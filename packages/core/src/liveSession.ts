// Live mode: OpenAI GPT-Live (WebRTC) is the conversation; bb threads do the
// work. GPT-Live runs with Responses delegation: requests that need action go
// to a small text model (luna) that calls our function tools. The phone runs
// each tool against bb's API and returns the result.
//
// ask_agent is where the voice layer pre-processes: luna composes a clean,
// self-contained message for the coding agent from the conversation, rather
// than forwarding the raw transcript.
//
// Agent replies arrive asynchronously (bb turns take minutes), so they come
// back as session commentary, which GPT-Live speaks in its own words. With
// Responses delegation every append must use `delegation_id: null`.
//
// WebRTC and the SDP exchange come from the platform: the phone posts the offer
// to OpenAI with the key it holds, the desktop plugin relays it through its
// server so the key never reaches the page.

import { BbClient, threadLabel, type BbEvent, type BbThread } from './bb';
import { PHASE_NOTIFICATION, type KeepAlive, type LogEntry, type Phase, type VoiceEngine, type VoiceSnapshot } from './types';

export type LiveSettings = { model: string; voice: string; delegateModel: string };

// The subset of RTCPeerConnection / MediaStream used here; satisfied by both
// the browser and react-native-webrtc.
export type PeerConnection = {
  connectionState: string;
  addEventListener(type: string, fn: (e: any) => void): void;
  addTrack(track: any, stream: any): unknown;
  createDataChannel(label: string): any;
  createOffer(options?: object): Promise<{ sdp?: string | null }>;
  setLocalDescription(description: any): Promise<void>;
  setRemoteDescription(description: any): Promise<void>;
  close(): void;
};

export type AudioStream = { getTracks(): { stop(): void }[] };

export type LivePlatform = {
  createPeerConnection(): PeerConnection;
  getUserMedia(): Promise<AudioStream>;
  // Posts the SDP offer and session config to OpenAI; resolves to the answer SDP.
  negotiate(offerSdp: string, session: LiveSessionConfig): Promise<string>;
  keepAlive: KeepAlive;
  setAudioRoute?(active: boolean): void;
  // Browsers need remote audio attached to an element; returns a detach function.
  playRemoteAudio?(stream: unknown): () => void;
};

export type LiveSessionConfig = Record<string, unknown>;

const OPENAI = 'https://api.openai.com/v1';
const LOG_LIMIT = 60;
const APPEND_CHARS = 1600; // ~400 tokens; an append is capped at 500 tokens
const TOOL_OUTPUT_CHARS = 6000;
const SPEAKING_DECAY_MS = 1500;
const HEARING_DECAY_MS = 1200;
const TOOL_FLUSH_MS = 1200; // fallback if the delegate's response.done never shows

const debug = (...args: unknown[]) => console.log('[bbvoice:live]', ...args);

// ---- prompts ---------------------------------------------------------------------

function voiceInstructions(context: string) {
  return [
    'You are the voice of bb, an IDE where coding agents work on the user\'s computer. You talk; the agents do the work.',
    'Delegate anything that needs action or knowledge: code, files, commands, projects, threads, research, or anything current.',
    'While a request is being handled, say one short sentence like "On it." Never say something is done, fixed or finished until the result arrives.',
    'Agent results and progress arrive as context. Relay results conversationally: short ones nearly verbatim, long ones as key points. Read any question an agent asks word for word.',
    'Never read code, file paths, URLs or IDs aloud character by character; describe them. Keep replies brief.',
    '',
    context,
  ].join('\n');
}

function delegateInstructions(context: string) {
  return [
    'You are the tool layer behind a voice assistant for bb, an IDE where coding agents (Claude Code, Codex and others) work in threads on the user\'s computer.',
    'Use the tools to act. Prefer the current thread unless the user names another one; use find_threads to resolve a thread by name.',
    '',
    'When you call ask_agent, you are writing a message to a capable coding agent that cannot hear the conversation. Compose it yourself:',
    '- State the goal and every concrete detail the agent needs: names, files, numbers, constraints, and the user\'s latest corrections.',
    '- Make it self-contained: resolve references like "that", "it" or "the other one" using the conversation and thread context.',
    '- Drop filler, greetings, hesitations, false starts and anything about the voice conversation itself.',
    '- Write it as the user would type it to the agent, in the first person, plainly. Do not invent requirements.',
    '',
    'ask_agent only sends the message; the agent\'s reply arrives later. Tell the voice it was sent, not that it is done.',
    'Use read_thread for "what did it say" questions and thread_status for "is it done" questions.',
    '',
    context,
  ].join('\n');
}

const fn = (name: string, description: string, properties: Record<string, unknown> = {}, required: string[] = []) => ({
  type: 'function',
  name,
  description,
  parameters: { type: 'object', properties, required, additionalProperties: false },
});

const THREAD_ARG = { thread_id: { type: 'string', description: 'Thread id (thr_…). Omit for the current thread.' } };

const TOOLS = [
  fn(
    'ask_agent',
    'Send a request to the coding agent in a bb thread. The message must be self-contained and composed by you, not a transcript.',
    { message: { type: 'string', description: 'The complete message for the agent.' }, ...THREAD_ARG },
    ['message'],
  ),
  fn('find_threads', 'List recent bb threads, optionally filtered by a name query. Returns id, title, status and project.', {
    query: { type: 'string', description: 'Words from the thread title.' },
  }),
  fn('switch_thread', 'Make another thread the current one for this voice session.', { thread_id: { type: 'string' } }, ['thread_id']),
  fn(
    'new_thread',
    'Start a new bb thread with a first message for its agent, composed the same way as ask_agent. Then it becomes the current thread.',
    {
      message: { type: 'string', description: 'The complete first message for the agent.' },
      project: { type: 'string', description: 'Project name or id. Omit to use the current thread\'s project.' },
    },
    ['message'],
  ),
  fn('read_thread', "Read a thread's latest agent messages.", {
    ...THREAD_ARG,
    count: { type: 'integer', description: 'How many messages (1-5).', minimum: 1, maximum: 5 },
  }),
  fn('thread_status', 'Check whether the agent in a thread is working, idle or waiting on the user.', THREAD_ARG),
  fn('stop_agent', "Stop the agent's current work in a thread.", THREAD_ARG),
];

function chunk(text: string, size: number): string[] {
  const out: string[] = [];
  let rest = text.trim();
  while (rest.length > size) {
    let cut = rest.lastIndexOf('\n', size);
    if (cut < size / 2) cut = rest.lastIndexOf('. ', size) + 1;
    if (cut < size / 2) cut = size;
    out.push(rest.slice(0, cut).trim());
    rest = rest.slice(cut).trim();
  }
  if (rest) out.push(rest);
  return out;
}

const clip = (text: string, max: number) => (text.length > max ? `${text.slice(0, max)}…` : text);

export function liveSessionConfig(settings: LiveSettings, context: string): LiveSessionConfig {
  return {
    model: settings.model,
    instructions: voiceInstructions(context),
    audio: { output: { voice: settings.voice } },
    delegation: {
      type: 'responses',
      responses: {
        model: settings.delegateModel,
        instructions: delegateInstructions(context),
        tools: TOOLS,
        tool_choice: 'auto',
      },
    },
  };
}

// The OpenAI half of `LivePlatform.negotiate`, for whichever side holds the key.
export async function negotiateWithOpenAI(apiKey: string, offerSdp: string, session: LiveSessionConfig): Promise<string> {
  const res = await fetch(`${OPENAI}/live/sessions`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ session, transport: { type: 'webrtc', sdp: offerSdp } }),
  });
  const body = await res.text();
  if (!res.ok) {
    let message = body.slice(0, 300);
    try {
      message = JSON.parse(body).error?.message ?? message;
    } catch {}
    throw new Error(`GPT-Live ${res.status}: ${message}`);
  }
  const json = JSON.parse(body);
  debug('session', json.session?.id);
  return json.transport.sdp;
}

// ---- per-thread bb tracking ------------------------------------------------------

type Tracker = {
  threadId: string;
  title: string;
  lastSeq: number;
  turnActive: boolean;
  turnText: string[];
  awaitingReply: boolean; // we asked; relay the reply when the turn ends
  unwatch: () => void;
  syncing: boolean;
  resync: boolean;
};

type ToolCall = { call_id: string; name: string; arguments: string };

export class LiveSession implements VoiceEngine {
  private snapshot: VoiceSnapshot = { phase: 'off', partial: '', log: [], error: null };
  private listeners = new Set<(s: VoiceSnapshot) => void>();
  private pc: PeerConnection | null = null;
  private dc: any = null;
  private stream: AudioStream | null = null;
  private detachAudio: (() => void) | null = null;
  private ticker: ReturnType<typeof setInterval> | null = null;
  private enabled = false;
  private started = false;
  private nextLogId = 1;
  private nextEventId = 1;

  private userLine = '';
  private lastUserDeltaAt = 0;
  private assistantLine = '';
  private lastOutputAt = 0;

  private trackers = new Map<string, Tracker>();
  private pendingCalls: ToolCall[] = [];
  private seenCalls = new Set<string>();
  private toolFlushTimer: ReturnType<typeof setTimeout> | null = null;
  private toolsRunning = false;

  constructor(
    private platform: LivePlatform,
    private client: BbClient,
    private threadId: string,
    private threadTitle: string,
    private settings: LiveSettings,
    private onThreadChange: (threadId: string, title: string) => void = () => {},
  ) {}

  subscribe(fn: (s: VoiceSnapshot) => void) {
    this.listeners.add(fn);
    fn(this.snapshot);
    return () => this.listeners.delete(fn);
  }

  async start() {
    if (this.enabled) return;
    this.enabled = true;
    this.update({ phase: 'thinking', error: null, partial: 'Connecting to GPT-Live…' });
    try {
      await this.platform.keepAlive.start(this.threadTitle, 'Live voice · connecting');
      await this.track(this.threadId, this.threadTitle);
      const context = await this.buildContext();
      await this.connect(context);
      this.ticker = setInterval(() => this.tick(), 300);
    } catch (e: any) {
      this.fail(e?.message ?? String(e));
    }
  }

  stop() {
    if (!this.enabled && !this.pc) return;
    this.enabled = false;
    this.send({ type: 'session.close' });
    if (this.ticker) clearInterval(this.ticker);
    if (this.toolFlushTimer) clearTimeout(this.toolFlushTimer);
    this.ticker = this.toolFlushTimer = null;
    for (const t of this.trackers.values()) t.unwatch();
    this.trackers.clear();
    const { pc, stream, dc } = this;
    this.pc = this.dc = this.stream = null;
    this.detachAudio?.();
    this.detachAudio = null;
    // Give session.close a moment to reach OpenAI so billing stops cleanly.
    setTimeout(() => {
      try {
        dc?.close();
      } catch {}
      stream?.getTracks().forEach((t) => t.stop());
      pc?.close();
    }, 400);
    this.platform.setAudioRoute?.(false);
    this.platform.keepAlive.stop();
    this.started = false;
    this.update({ phase: 'off', partial: '' });
  }

  interrupt() {
    if (this.snapshot.phase !== 'speaking') return false;
    this.send({ type: 'session.instructions.append', delegation_id: null, content: 'Stop speaking immediately and listen to the user.' });
    return true;
  }

  // ---- context ----------------------------------------------------------------

  private async buildContext(): Promise<string> {
    const lines: string[] = [`Current thread: "${this.threadTitle}" (${this.threadId}).`];
    try {
      const recent = await this.client.recentAgentMessages(this.threadId, 3);
      if (recent.length) {
        lines.push('Its latest agent messages, oldest first:');
        for (const m of recent) lines.push(`- ${clip(m.replace(/\s+/g, ' '), 700)}`);
      }
    } catch {}
    try {
      const [threads, projects] = await Promise.all([this.client.listThreads(12), this.client.listProjects()]);
      const names = new Map(projects.map((p) => [p.id, p.name]));
      lines.push('Recent threads:');
      for (const t of threads) lines.push(`- ${threadLabel(t)} (${t.id}, ${t.status}, project ${names.get(t.projectId) ?? t.projectId})`);
    } catch {}
    return lines.join('\n');
  }

  // ---- connection -------------------------------------------------------------

  private async connect(context: string) {
    const pc = this.platform.createPeerConnection();
    this.pc = pc;
    pc.addEventListener('connectionstatechange', () => {
      debug('pc', pc.connectionState);
      if (this.enabled && (pc.connectionState === 'failed' || pc.connectionState === 'closed')) {
        this.fail('Voice connection dropped');
      }
    });
    if (this.platform.playRemoteAudio) {
      pc.addEventListener('track', (e) => {
        this.detachAudio?.();
        this.detachAudio = this.platform.playRemoteAudio!(e.streams?.[0]);
      });
    }

    const stream = await this.platform.getUserMedia();
    this.stream = stream;
    stream.getTracks().forEach((track) => pc.addTrack(track, stream));
    this.platform.setAudioRoute?.(true);

    const dc = pc.createDataChannel('oai-events');
    this.dc = dc;
    dc.addEventListener('message', (e: any) => {
      try {
        this.onServerEvent(JSON.parse(e.data));
      } catch {}
    });

    const offer = await pc.createOffer({});
    await pc.setLocalDescription(offer);
    const answer = await this.platform.negotiate(offer.sdp ?? '', liveSessionConfig(this.settings, context));
    await pc.setRemoteDescription({ type: 'answer', sdp: answer });
  }

  private send(event: Record<string, unknown>) {
    if (this.dc?.readyState !== 'open') return;
    this.dc.send(JSON.stringify({ event_id: `bbv_${this.nextEventId++}`, ...event }));
  }

  private append(kind: 'commentary' | 'thinking', content: string) {
    for (const part of chunk(content, APPEND_CHARS)) {
      this.send({ type: `session.${kind}.append`, delegation_id: null, content: part });
    }
  }

  // ---- GPT-Live events --------------------------------------------------------

  private onServerEvent(ev: any) {
    switch (ev.type) {
      case 'session.started':
        this.started = true;
        this.update({ partial: '' });
        this.log('system', 'GPT-Live connected');
        break;
      case 'session.input_transcript.delta':
        this.userLine += ev.delta ?? '';
        this.lastUserDeltaAt = Date.now();
        this.update({ partial: this.userLine.trim() });
        break;
      case 'session.output_transcript.delta':
        this.assistantLine += ev.delta ?? '';
        this.lastOutputAt = Date.now();
        break;
      case 'session.delegation.created':
        debug('delegation', JSON.stringify(ev.delegation));
        break;
      case 'response.event':
        this.onDelegateEvent(ev.event ?? ev.response_event ?? ev.data);
        break;
      case 'session.closed':
        debug('closed', ev.reason);
        if (this.enabled) this.fail(`GPT-Live session ended (${ev.reason ?? 'closed'})`);
        break;
      case 'error':
        debug('error', JSON.stringify(ev.error));
        this.log('system', `GPT-Live: ${ev.error?.message ?? 'error'}`);
        break;
      default:
        if (!String(ev.type).endsWith('.appended') && ev.type !== 'session.usage.updated') debug('event', ev.type);
    }
    this.refreshPhase();
  }

  // Events from the Responses delegate (luna), wrapped in response.event.
  private onDelegateEvent(inner: any) {
    if (!inner?.type) return;
    if (inner.type === 'response.output_item.done' && inner.item?.type === 'function_call') {
      const item = inner.item;
      if (!item.call_id || this.seenCalls.has(item.call_id)) return;
      this.seenCalls.add(item.call_id);
      this.pendingCalls.push({ call_id: item.call_id, name: item.name, arguments: item.arguments ?? '{}' });
      debug('tool call', item.name, item.arguments);
      this.scheduleToolFlush(TOOL_FLUSH_MS);
    } else if (inner.type === 'response.done' || inner.type === 'response.completed') {
      if (this.pendingCalls.length) this.scheduleToolFlush(0);
    } else if (!/delta$/.test(inner.type)) {
      debug('delegate', inner.type);
    }
  }

  private scheduleToolFlush(delay: number) {
    if (this.toolFlushTimer) clearTimeout(this.toolFlushTimer);
    this.toolFlushTimer = setTimeout(() => this.runPendingTools(), delay);
  }

  // Every pending call needs an output before the delegate may continue.
  private async runPendingTools() {
    this.toolFlushTimer = null;
    if (this.toolsRunning || this.pendingCalls.length === 0) return;
    this.toolsRunning = true;
    const calls = this.pendingCalls.splice(0);
    try {
      for (const call of calls) {
        let result: unknown;
        try {
          result = await this.runTool(call.name, call.arguments ? JSON.parse(call.arguments) : {});
        } catch (e: any) {
          result = { error: e?.message ?? String(e) };
        }
        debug('tool result', call.name, JSON.stringify(result).slice(0, 200));
        this.send({
          type: 'response.item.create',
          item: { type: 'function_call_output', call_id: call.call_id, output: clip(JSON.stringify(result), TOOL_OUTPUT_CHARS) },
        });
      }
      this.send({ type: 'response.create' });
    } finally {
      this.toolsRunning = false;
      if (this.pendingCalls.length) this.scheduleToolFlush(0);
    }
  }

  // ---- tools ------------------------------------------------------------------

  private target(args: any): string {
    return typeof args?.thread_id === 'string' && args.thread_id.startsWith('thr_') ? args.thread_id : this.threadId;
  }

  private async runTool(name: string, args: any): Promise<unknown> {
    switch (name) {
      case 'ask_agent': {
        const message = String(args.message ?? '').trim();
        if (!message) return { error: 'message is empty' };
        const threadId = this.target(args);
        const tracker = await this.track(threadId);
        const res = await this.client.send(threadId, message);
        tracker.awaitingReply = true;
        tracker.turnActive = true;
        tracker.turnText = [];
        this.log('you', message);
        return {
          status: res.delivery === 'queued' ? 'queued behind the agent\'s current work' : 'sent; the agent is working',
          thread: tracker.title,
          note: 'The reply will arrive later as commentary. Do not claim the work is done.',
        };
      }
      case 'find_threads': {
        const [threads, projects] = await Promise.all([this.client.listThreads(40), this.client.listProjects()]);
        const names = new Map(projects.map((p) => [p.id, p.name]));
        const query = String(args.query ?? '').toLowerCase().trim();
        const words = query.split(/\s+/).filter(Boolean);
        const matches = threads.filter((t) => words.every((w) => threadLabel(t).toLowerCase().includes(w)));
        return (query ? matches : threads).slice(0, 12).map((t) => ({
          id: t.id,
          title: threadLabel(t),
          status: t.status,
          project: names.get(t.projectId) ?? t.projectId,
          current: t.id === this.threadId,
        }));
      }
      case 'switch_thread': {
        const thread = await this.client.getThread(String(args.thread_id));
        await this.setCurrent(thread);
        return { switched_to: threadLabel(thread), status: thread.status };
      }
      case 'new_thread': {
        const message = String(args.message ?? '').trim();
        if (!message) return { error: 'message is empty' };
        const projectId = await this.resolveProject(args.project);
        const thread = await this.client.createThread(projectId, message);
        await this.setCurrent(thread);
        const tracker = await this.track(thread.id, threadLabel(thread));
        tracker.awaitingReply = true;
        tracker.turnActive = true;
        this.log('you', message);
        return { created: threadLabel(thread), id: thread.id, note: 'The agent is starting; its reply will arrive later.' };
      }
      case 'read_thread': {
        const threadId = this.target(args);
        const count = Math.min(5, Math.max(1, Number(args.count) || 2));
        const messages = await this.client.recentAgentMessages(threadId, count);
        return { thread: (await this.track(threadId)).title, messages: messages.map((m) => clip(m, 2500)) };
      }
      case 'thread_status': {
        const thread = await this.client.getThread(this.target(args));
        return { thread: threadLabel(thread), status: thread.status, queued_work: (thread as any).queuedWork ?? null };
      }
      case 'stop_agent': {
        const threadId = this.target(args);
        await this.client.stop(threadId);
        const tracker = this.trackers.get(threadId);
        if (tracker) tracker.awaitingReply = false;
        return { stopped: tracker?.title ?? threadId };
      }
      default:
        return { error: `unknown tool ${name}` };
    }
  }

  private async resolveProject(project: unknown): Promise<string> {
    const wanted = typeof project === 'string' ? project.trim().toLowerCase() : '';
    if (wanted) {
      const projects = await this.client.listProjects();
      const hit = projects.find((p) => p.id === project || p.name.toLowerCase() === wanted) ?? projects.find((p) => p.name.toLowerCase().includes(wanted));
      if (hit) return hit.id;
    }
    return (await this.client.getThread(this.threadId)).projectId;
  }

  private async setCurrent(thread: BbThread) {
    this.threadId = thread.id;
    this.threadTitle = threadLabel(thread);
    await this.track(thread.id, this.threadTitle);
    this.onThreadChange(thread.id, this.threadTitle);
    this.log('system', `Now on "${this.threadTitle}"`);
  }

  // ---- bb events --------------------------------------------------------------

  private async track(threadId: string, title?: string): Promise<Tracker> {
    const existing = this.trackers.get(threadId);
    if (existing) return existing;
    const thread = title ? null : await this.client.getThread(threadId);
    const tracker: Tracker = {
      threadId,
      title: title ?? threadLabel(thread!),
      lastSeq: await this.client.latestSeq(threadId),
      turnActive: thread?.status === 'active',
      turnText: [],
      awaitingReply: false,
      unwatch: () => {},
      syncing: false,
      resync: false,
    };
    this.trackers.set(threadId, tracker);
    tracker.unwatch = this.client.watchThread(threadId, () => this.sync(tracker));
    return tracker;
  }

  private async sync(t: Tracker) {
    if (t.syncing) {
      t.resync = true;
      return;
    }
    t.syncing = true;
    do {
      t.resync = false;
      try {
        const events = await this.client.eventsAfter(t.threadId, t.lastSeq);
        for (const ev of events) this.apply(t, ev);
      } catch (e: any) {
        debug('sync failed', e.message);
      }
    } while (t.resync && this.enabled);
    t.syncing = false;
  }

  private apply(t: Tracker, ev: BbEvent) {
    t.lastSeq = Math.max(t.lastSeq, ev.seq);
    const relevant = t.awaitingReply || t.threadId === this.threadId;
    if (ev.type === 'turn/started') {
      t.turnActive = true;
      t.turnText = [];
    } else if (ev.type === 'item/completed' && ev.data?.item?.type === 'agentMessage' && ev.data.item.text) {
      const text: string = ev.data.item.text;
      t.turnText.push(text);
      if (relevant) {
        this.log('agent', text);
        // Intermediate messages are progress: quiet context, not speech.
        if (this.started) this.append('thinking', `Progress from the agent in "${t.title}": ${clip(text, APPEND_CHARS)}`);
      }
    } else if (ev.type === 'turn/completed') {
      t.turnActive = false;
      const reply = t.turnText[t.turnText.length - 1] ?? '';
      t.turnText = [];
      if (relevant && this.started) {
        const status = ev.data?.status && ev.data.status !== 'completed' ? ` (turn ${ev.data.status})` : '';
        this.append(
          'commentary',
          reply ? `The agent in "${t.title}" finished${status}. Its reply:\n${reply}` : `The agent in "${t.title}" finished${status} without a text reply.`,
        );
      }
      t.awaitingReply = false;
    }
    this.refreshPhase();
  }

  // ---- state ------------------------------------------------------------------

  private tick() {
    const now = Date.now();
    if (this.assistantLine.trim() && now - this.lastOutputAt > SPEAKING_DECAY_MS) {
      this.log('assistant', this.assistantLine.trim());
      this.assistantLine = '';
    }
    if (this.userLine.trim() && now - this.lastUserDeltaAt > HEARING_DECAY_MS * 2) {
      this.userLine = '';
      this.update({ partial: '' });
    }
    this.refreshPhase();
  }

  private refreshPhase() {
    if (!this.enabled || !this.started) return;
    const now = Date.now();
    const working = this.toolsRunning || [...this.trackers.values()].some((t) => t.turnActive && (t.awaitingReply || t.threadId === this.threadId));
    const phase: Phase =
      now - this.lastOutputAt < SPEAKING_DECAY_MS
        ? 'speaking'
        : now - this.lastUserDeltaAt < HEARING_DECAY_MS
          ? 'hearing'
          : working
            ? 'thinking'
            : 'listening';
    if (phase !== this.snapshot.phase) {
      this.platform.keepAlive.update(this.threadTitle, `Live · ${PHASE_NOTIFICATION[phase]}`);
      this.update({ phase, error: null });
    }
  }

  private fail(message: string) {
    debug('fail', message);
    this.stop();
    this.update({ phase: 'error', error: message });
  }

  private log(role: LogEntry['role'], text: string) {
    const log = [...this.snapshot.log, { id: this.nextLogId++, role, text }].slice(-LOG_LIMIT);
    this.update({ log });
  }

  private update(patch: Partial<VoiceSnapshot>) {
    this.snapshot = { ...this.snapshot, ...patch };
    this.listeners.forEach((fn) => fn(this.snapshot));
  }
}
