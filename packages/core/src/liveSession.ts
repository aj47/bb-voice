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

import {
  BbClient,
  parseNewThreadCommand,
  parseThreadModel,
  queuedText,
  resolveModel,
  threadLabel,
  type BbEvent,
  type BbQueuedMessage,
  type BbThread,
  type ThreadExecution,
  type TranscriptEntry,
} from './bb';
import { agentQuestion, buildAnswer, describeQuestion, isOpenInteraction, questionSummary, type AgentQuestion, type SpokenAnswer } from './questions';
import { MUTED_NOTIFICATION, PHASE_NOTIFICATION, type KeepAlive, type LogEntry, type Phase, type VoiceEngine, type VoiceSnapshot } from './types';

// threadModel: the default agent for new threads ("providerId:model", "" = project default).
export type LiveSettings = { model: string; voice: string; delegateModel: string; threadModel?: string };

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

export type AudioStream = { getTracks(): { stop(): void; enabled: boolean }[] };

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
const GOODBYE_MS = 2000; // after end_call, time for the voice to say goodbye

// A whole utterance asking to hang up ("All right, hang up"), not one that
// mentions it ("did you hang up?"). Ends the call even if the voice never delegates.
const HANG_UP = /^(?:(?:ok(?:ay)?|all ?right|alright|yeah|yes|cool|thanks|thank you)[,.!]?\s+)*(?:please\s+)?(?:hang up|end (?:the |this )?call|stop (?:the |this )?call)(?: now)?(?:,? please)?[.!]?$/i;
export const isHangUp = (text: string) => HANG_UP.test(text.trim());

const debug = (...args: unknown[]) => console.log('[bbvoice:live]', ...args);

// ---- prompts ---------------------------------------------------------------------

function voiceInstructions(context: string) {
  return [
    'You are the voice of bb, an IDE where coding agents work on the user\'s computer. You talk; the agents do the work.',
    'Delegate anything that needs action or knowledge: code, files, commands, projects, threads, research, or anything current.',
    'Answer from the conversation and context when the answer is already there; delegate only when you need something new.',
    'While a request is being handled, say one short sentence like "On it." Never say something is done, fixed or finished until the result arrives.',
    'Threads run in parallel. When the user asks to start, kick off or hand off work in a new or another thread, delegate it right away, even while other work is running. Never hold it until something else finishes.',
    'When the user wants to end the call ("hang up", "end the call", "that\'s all, bye"), delegate it: only the end_call tool actually hangs up. Never just say okay.',
    'Agent results and progress arrive as context. Relay results conversationally: short ones nearly verbatim, long ones as key points. Read any question an agent asks word for word.',
    'When an agent is waiting on a question, read the question and its options, then wait: the user\'s answer is delegated and goes straight back to that agent.',
    'A queued message has not reached the agent yet: say it is queued and what it is waiting for, never that the agent has it.',
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
    'ask_agent only sends the message; the agent\'s reply arrives later. Tell the voice it was sent, not that it is done. When it comes back queued, the agent has not seen it: say so, and why it waits.',
    'Each thread has a message queue; thread_status lists what is waiting in it.',
    'Use read_thread for "what did it say" questions and thread_status for "is it done" questions.',
    'Threads run in parallel. When the user wants work started in a new or another thread, call new_thread now, once per piece of work, even if other threads are busy; never postpone it. Pass switch: false when it runs alongside the current work ("in another thread", "in parallel", "kick off"), so the current thread stays current.',
    'find_threads marks the threads this call sent work to (awaiting_reply); use it for "what about the other threads".',
    'When the user wants to hang up or end the call, call end_call.',
    'When an agent is waiting on a question or approval (it arrives as context, and thread_status shows it), the user\'s next reply is usually the answer: pass it to answer_question in their words. Never use ask_agent for it; a message to a waiting agent only queues behind the question.',
    'When the user names a model or agent for a new thread (e.g. "create a new thread with Luna", "on Claude Opus", "with my fast model", "my favorite"), pass their words as new_thread\'s model (and provider if they named one). Never only mention it in the message: the message does not choose the model. Favorites and their nicknames are listed below; use list_models when unsure what exists.',
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
    'Start a new bb thread with a first message for its agent, composed the same way as ask_agent. It becomes the current thread unless switch is false.',
    {
      message: { type: 'string', description: 'The complete first message for the agent.' },
      switch: { type: 'boolean', description: 'false: keep the current thread current and run this one alongside it. Default true.' },
      project: { type: 'string', description: 'Project name or id. Omit to use the current thread\'s project.' },
      model: { type: 'string', description: 'Model the user asked for, in their words: a name or id ("Luna", "GPT-6-Sol", "Opus"), a favorite\'s nickname ("my fast model"), or "my favorite". Omit for the default.' },
      provider: { type: 'string', description: 'Agent provider the user named (e.g. "Codex", "Claude Code", "Pi"). Omit unless named.' },
    },
    ['message'],
  ),
  fn('list_models', "List the models new threads can run on, by agent provider, marking the user's favorites and their nicknames.", {
    provider: { type: 'string', description: 'Only this provider (e.g. "Codex").' },
  }),
  fn('read_thread', "Read a thread's latest agent messages.", {
    ...THREAD_ARG,
    count: { type: 'integer', description: 'How many messages (1-5).', minimum: 1, maximum: 5 },
  }),
  fn('thread_status', 'Check whether the agent in a thread is working, idle or waiting on the user.', THREAD_ARG),
  fn('stop_agent', "Stop the agent's current work in a thread.", THREAD_ARG),
  fn('end_call', 'Hang up: end this voice call. Agents keep working. Not for stopping an agent.'),
  fn(
    'answer_question',
    "Answer the question or approval an agent is waiting on. Use this, not ask_agent, whenever an agent asked the user something.",
    {
      answer: {
        type: 'string',
        description: "The user's answer: an option's label or number, or their own words. For an approval: yes, yes for the session, or no.",
      },
      answers: {
        type: 'array',
        description: 'Only when the agent asked several questions at once: one entry per question.',
        items: {
          type: 'object',
          properties: {
            question: { type: 'integer', description: 'Question number, from 1.' },
            choices: { type: 'array', items: { type: 'string' }, description: 'Labels of the options the user chose.' },
            text: { type: 'string', description: "The user's own words, when they didn't pick an option." },
          },
          required: ['question'],
          additionalProperties: false,
        },
      },
      ...THREAD_ARG,
    },
  ),
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

// The Android notification line; a question goes in full so it reads on a locked screen.
export const liveNotification = (phase: Phase, question: string | null, queued = 0) =>
  `Live · ${PHASE_NOTIFICATION[phase]}${question ? `: ${question}` : ''}${queued ? ` · ${queued} queued` : ''}`;

// Why a queued message hasn't gone yet, from bb's waitingOn / state.
function waitReason(m: BbQueuedMessage): string {
  switch (m.waitingOn?.kind ?? m.state) {
    case 'thread-busy':
    case 'queued':
      return 'waiting for the agent\'s current turn to finish';
    case 'interaction':
      return 'waiting for an answer to the agent\'s question';
    case 'turn-starting':
      return 'waiting for the turn to start';
    case 'provisioning':
      return 'waiting for the workspace to be ready';
    case 'host-offline':
      return 'waiting for the machine to come back online';
    case 'time':
    case 'scheduled':
      return m.sendAt ? `scheduled for ${new Date(m.sendAt).toLocaleTimeString()}` : 'scheduled';
    case 'plugin':
      return 'held by a plugin';
    case 'failed_retrying':
      return 'failed to send; bb will retry';
    case 'failed_exhausted':
      return 'failed to send; needs a retry in bb';
    case 'claimed':
      return 'being sent now';
    default:
      return m.state;
  }
}

const queueEntry = (m: BbQueuedMessage, mine: boolean) => ({ text: clip(queuedText(m), 200), status: waitReason(m), ...(mine ? { sent_by_voice: true } : {}) });

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
  question: AgentQuestion | null; // open question or approval the agent is waiting on
  queue: BbQueuedMessage[]; // the thread's message queue, oldest first
  // Messages this voice queued that have not started a turn yet. `left`: gone
  // from the queue, but its turn/requested event not seen yet (bb drops the row
  // before the earlier turn's turn/completed reaches us).
  mine: Map<string, { text: string; left: boolean }>;
  unwatch: () => void;
  syncing: boolean;
  resync: boolean;
};

type ToolCall = { call_id: string; name: string; arguments: string };

export class LiveSession implements VoiceEngine {
  private snapshot: VoiceSnapshot = { phase: 'off', partial: '', log: [], error: null, micMuted: false, question: null, queued: 0 };
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
  // When the user asked to hang up; the call ends GOODBYE_MS later.
  private endRequestedAt = 0;
  // Questions already read out, so a resync or reconnect doesn't repeat them.
  private announced = new Set<string>();

  // Spoken turns waiting for a thread (a session started from the home page),
  // and the chain that keeps appends to bb in order.
  private unfiledTranscript: TranscriptEntry[] = [];
  // What the user said since the last new_thread, newest last: a fallback for
  // a model named aloud ("create a new thread with Luna") that the tool call left out.
  private recentUtterances: string[] = [];
  private transcriptWrites: Promise<void> = Promise.resolve();

  constructor(
    private platform: LivePlatform,
    private client: BbClient,
    // null: no thread yet; the first request starts one with new_thread.
    private threadId: string | null,
    private threadTitle: string,
    private settings: LiveSettings,
    private onThreadChange: (threadId: string, title: string) => void = () => {},
    // Where new_thread puts a thread when there is no current one (null: the most recently active project).
    private projectId: string | null = null,
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
      if (this.threadId) await this.track(this.threadId, this.threadTitle);
      const context = await this.buildContext();
      await this.connect(context);
      this.ticker = setInterval(() => this.tick(), 300);
    } catch (e: any) {
      this.fail(e?.message ?? String(e));
    }
  }

  stop() {
    this.shutdown({ phase: 'off' });
  }

  // A failure goes straight to error, never through off: the app reads off
  // after running as a hang-up and clears the bar.
  private shutdown(final: Pick<VoiceSnapshot, 'phase'> & Partial<VoiceSnapshot>) {
    if (!this.enabled && !this.pc) {
      if (final.error) this.update(final);
      return;
    }
    this.commitUserLine();
    this.commitAssistantLine();
    this.enabled = false;
    this.endRequestedAt = 0;
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
    this.update({ partial: '', micMuted: false, question: null, queued: 0, ...final });
  }

  // Disabled tracks send silence, so the connection and the voice's replies carry on.
  setMicMuted(muted: boolean) {
    if (muted === this.snapshot.micMuted) return;
    this.stream?.getTracks().forEach((t) => (t.enabled = !muted));
    this.update({ micMuted: muted });
    this.platform.keepAlive.update(this.threadTitle, muted ? `Live · ${MUTED_NOTIFICATION}` : liveNotification(this.snapshot.phase, this.snapshot.question, this.snapshot.queued));
  }

  interrupt() {
    if (this.snapshot.phase !== 'speaking') return false;
    this.send({ type: 'session.instructions.append', delegation_id: null, content: 'Stop speaking immediately and listen to the user.' });
    return true;
  }

  // ---- context ----------------------------------------------------------------

  private async buildContext(): Promise<string> {
    const lines: string[] = [];
    if (this.threadId) {
      lines.push(`Current thread: "${this.threadTitle}" (${this.threadId}).`);
      try {
        const recent = await this.client.recentAgentMessages(this.threadId, 3);
        if (recent.length) {
          lines.push('Its latest agent messages, oldest first:');
          for (const m of recent) lines.push(`- ${clip(m.replace(/\s+/g, ' '), 700)}`);
        }
      } catch {}
      const question = this.trackers.get(this.threadId)?.question;
      if (question) lines.push('Its agent is waiting on the user\'s answer to this (use answer_question):', describeQuestion(question));
    } else {
      lines.push('No current thread: the user opened this session to start a new one. Use new_thread for their first request unless they name an existing thread.');
    }
    try {
      const favorites = await this.client.listFavorites();
      if (favorites.length) {
        const models = await this.client.listModels();
        lines.push('Favorite models for new threads (the first is "my favorite"):');
        favorites.forEach((f, i) => {
          const m = models.find((x) => x.providerId === f.providerId && x.model === f.model);
          const name = m ? `${m.displayName} (${m.providerName})` : `${f.model} (${f.providerId})`;
          lines.push(`${i + 1}. ${name}${f.nickname ? ` — nickname "${f.nickname}"` : ''}`);
        });
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
    stream.getTracks().forEach((track) => {
      track.enabled = !this.snapshot.micMuted;
      pc.addTrack(track, stream);
    });
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
    // Timers can stall while the phone is locked, but data channel events keep
    // arriving: do the ticker's work here too, before this event adds to a line.
    this.tick();
    if (!this.enabled) return;
    switch (ev.type) {
      case 'session.started':
        this.started = true;
        this.update({ partial: '' });
        this.log('system', 'GPT-Live connected');
        for (const t of this.trackers.values()) this.announceQuestion(t);
        break;
      case 'session.input_transcript.delta':
        this.userLine += ev.delta ?? '';
        this.lastUserDeltaAt = Date.now();
        this.update({ partial: this.userLine.trim() });
        break;
      case 'session.output_transcript.delta':
        this.commitUserLine();
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
      // Run now, not on a timer: a locked phone can hold timers for minutes.
      if (this.pendingCalls.length) this.flushToolsNow();
    } else if (!/delta$/.test(inner.type)) {
      debug('delegate', inner.type);
    }
  }

  private scheduleToolFlush(delay: number) {
    if (this.toolFlushTimer) clearTimeout(this.toolFlushTimer);
    this.toolFlushTimer = setTimeout(() => this.runPendingTools(), delay);
  }

  private flushToolsNow() {
    if (this.toolFlushTimer) clearTimeout(this.toolFlushTimer);
    this.toolFlushTimer = null;
    void this.runPendingTools();
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
      this.refreshPhase();
      if (this.pendingCalls.length) this.flushToolsNow();
    }
  }

  // ---- tools ------------------------------------------------------------------

  private target(args: any): string {
    if (typeof args?.thread_id === 'string' && args.thread_id.startsWith('thr_')) return args.thread_id;
    if (!this.threadId) throw new Error('No current thread yet; use new_thread, or pass thread_id');
    return this.threadId;
  }

  private async runTool(name: string, args: any): Promise<unknown> {
    switch (name) {
      case 'ask_agent': {
        const message = String(args.message ?? '').trim();
        if (!message) return { error: 'message is empty' };
        const threadId = this.target(args);
        const tracker = await this.track(threadId);
        if (tracker.question) {
          return {
            error: 'The agent is waiting on an answer, so this message would only queue behind its question. Use answer_question with the user\'s answer.',
            waiting_on: describeQuestion(tracker.question),
          };
        }
        const res = await this.client.send(threadId, message);
        tracker.awaitingReply = true;
        tracker.turnActive = true;
        const queued = res.delivery === 'queued' ? res.queuedMessage : undefined;
        if (res.delivery === 'queued') {
          // The running turn's reply is not the answer to this; keep its text.
          if (queued) {
            tracker.mine.set(queued.id, { text: message, left: false });
            if (!tracker.queue.some((m) => m.id === queued.id)) tracker.queue = [...tracker.queue, queued];
          }
          this.log('system', `Queued for agent: ${message}`);
          this.refreshPhase();
          return {
            status: `queued, not delivered yet: ${queued ? waitReason(queued) : 'waiting for the agent\'s current turn to finish'}`,
            thread: tracker.title,
            queue_position: queued ? tracker.queue.findIndex((m) => m.id === queued.id) + 1 : tracker.queue.length,
            note: 'The agent has not seen this yet. Tell the user it is queued; its reply will arrive later as commentary.',
          };
        }
        tracker.turnText = [];
        this.log('system', `To agent: ${message}`);
        return {
          status: 'sent; the agent is working',
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
          ...(this.trackers.get(t.id)?.awaitingReply ? { awaiting_reply: true } : {}),
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
        let execution: ThreadExecution = parseThreadModel(this.settings.threadModel);
        let modelName = execution.model ?? 'the project default';
        const requested = this.requestedModel(args);
        if (requested) {
          const [models, favorites] = await Promise.all([this.client.listModels(), this.client.listFavorites()]);
          const hit = resolveModel(models, favorites, requested.model, requested.provider);
          if (!hit) {
            return {
              error: `No model matches "${requested.model}". No thread was created; ask the user to pick one of these.`,
              favorites: favorites.map((f) => `${f.nickname ? `"${f.nickname}": ` : ''}${f.providerId}:${f.model}`),
              available: models.map((m) => `${m.displayName} (${m.providerName})`).slice(0, 40),
            };
          }
          execution = { providerId: hit.providerId, model: hit.model };
          modelName = `${hit.displayName} (${hit.providerName})`;
        }
        this.recentUtterances = [];
        const thread = await this.client.createThread(projectId, message, execution);
        // Alongside: the current thread stays current; this one's reply is still relayed.
        const alongside = args.switch === false && !!this.threadId;
        if (!alongside) await this.setCurrent(thread);
        const tracker = await this.track(thread.id, threadLabel(thread));
        tracker.awaitingReply = true;
        tracker.turnActive = true;
        this.log('system', `To agent in "${tracker.title}": ${message}`);
        return {
          created: threadLabel(thread),
          id: thread.id,
          model: modelName,
          ...(alongside ? { current_thread: this.threadTitle } : {}),
          note: 'The agent is starting; its reply will arrive later.',
        };
      }
      case 'list_models': {
        const [models, favorites] = await Promise.all([this.client.listModels(), this.client.listFavorites()]);
        const prov = typeof args.provider === 'string' ? args.provider.toLowerCase() : '';
        const rank = (m: { providerId: string; model: string }) => favorites.findIndex((f) => f.providerId === m.providerId && f.model === m.model);
        return models
          .filter((m) => !prov || m.providerId.includes(prov) || m.providerName.toLowerCase().includes(prov))
          .map((m) => {
            const i = rank(m);
            return {
              provider: m.providerName,
              model: m.displayName,
              id: m.model,
              default: m.isDefault,
              ...(i >= 0 ? { favorite: i + 1, ...(favorites[i].nickname ? { nickname: favorites[i].nickname } : {}) } : {}),
            };
          });
      }
      case 'read_thread': {
        const threadId = this.target(args);
        const count = Math.min(5, Math.max(1, Number(args.count) || 2));
        const messages = await this.client.recentAgentMessages(threadId, count);
        const tracker = await this.track(threadId);
        return {
          thread: tracker.title,
          messages: messages.map((m) => clip(m, 2500)),
          ...(tracker.question ? { waiting_on_user: describeQuestion(tracker.question) } : {}),
          ...(tracker.queue.length ? { queued_messages: tracker.queue.map((m) => queueEntry(m, tracker.mine.has(m.id))) } : {}),
        };
      }
      case 'thread_status': {
        const thread = await this.client.getThread(this.target(args));
        const tracker = await this.track(thread.id);
        await this.refreshQueue(tracker);
        const question = tracker.question;
        return {
          thread: threadLabel(thread),
          status: question ? 'waiting on the user' : thread.status,
          ...(question ? { waiting_on_user: describeQuestion(question) } : {}),
          queued_messages: tracker.queue.map((m) => queueEntry(m, tracker.mine.has(m.id))),
        };
      }
      case 'stop_agent': {
        const threadId = this.target(args);
        await this.client.stop(threadId);
        const tracker = this.trackers.get(threadId);
        if (tracker) tracker.awaitingReply = false;
        return { stopped: tracker?.title ?? threadId };
      }
      case 'end_call':
        this.requestEnd();
        return { ending: true, note: 'Say a short goodbye. The call ends in a moment; agents keep working.' };
      case 'answer_question': {
        const tracker = await this.track(this.questionTarget(args));
        const question = tracker.question;
        if (!question) return { error: `No open question in "${tracker.title}".` };
        const spoken: SpokenAnswer[] | string = Array.isArray(args.answers) && args.answers.length ? args.answers : String(args.answer ?? '');
        const built = buildAnswer(question, spoken);
        if ('error' in built) return { error: built.error, question: describeQuestion(question) };
        await this.client.resolveInteraction(tracker.threadId, question.interactionId, built.resolution);
        tracker.question = null;
        tracker.awaitingReply = true;
        tracker.turnActive = true;
        this.log('system', `Answered: ${typeof spoken === 'string' ? spoken : JSON.stringify(spoken)}`);
        return { answered: questionSummary(question), thread: tracker.title, note: 'The agent continues; its reply will arrive later.' };
      }
      default:
        return { error: `unknown tool ${name}` };
    }
  }

  // An explicit thread, else the current thread if it is asking, else the one thread that is.
  private questionTarget(args: any): string {
    if (typeof args?.thread_id === 'string' && args.thread_id.startsWith('thr_')) return args.thread_id;
    if (this.threadId && this.trackers.get(this.threadId)?.question) return this.threadId;
    const asking = [...this.trackers.values()].filter((t) => t.question);
    if (asking.length === 1) return asking[0].threadId;
    return this.target(args);
  }

  // The model asked for: the tool's own argument, else one named aloud in a
  // recent "create a new thread with …" utterance or in the composed message.
  private requestedModel(args: any): { model: string; provider?: string } | null {
    const provider = typeof args.provider === 'string' && args.provider.trim() ? args.provider.trim() : undefined;
    if (typeof args.model === 'string' && args.model.trim()) return { model: args.model.trim(), provider };
    const spoken = [...this.recentUtterances, this.userLine.trim()].filter(Boolean).reverse();
    for (const text of [...spoken, String(args.message ?? '')]) {
      const cmd = parseNewThreadCommand(text);
      if (cmd?.model) return { model: cmd.model, provider: cmd.provider ?? provider };
    }
    return null;
  }

  private async resolveProject(project: unknown): Promise<string> {
    const wanted = typeof project === 'string' ? project.trim().toLowerCase() : '';
    if (wanted) {
      const projects = await this.client.listProjects();
      const hit = projects.find((p) => p.id === project || p.name.toLowerCase() === wanted) ?? projects.find((p) => p.name.toLowerCase().includes(wanted));
      if (hit) return hit.id;
    }
    if (this.threadId) return (await this.client.getThread(this.threadId)).projectId;
    return this.projectId ?? (await this.client.defaultProjectId());
  }

  private async setCurrent(thread: BbThread) {
    if (!this.threadId && this.unfiledTranscript.length) this.writeTranscript(thread.id, this.unfiledTranscript.splice(0));
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
      question: null,
      queue: [],
      mine: new Map(),
      unwatch: () => {},
      syncing: false,
      resync: false,
    };
    this.trackers.set(threadId, tracker);
    // Queue changes are not timeline events; bb only signals them as "queue-changed".
    tracker.unwatch = this.client.watchThread(threadId, (changes) => {
      if (changes.length === 0 || changes.includes('queue-changed')) void this.refreshQueue(tracker);
      if (changes.length === 0 || changes.some((c) => c !== 'queue-changed')) void this.sync(tracker);
    });
    await this.refreshQueue(tracker);
    // A question asked before tracking began is behind lastSeq; bb lists it as pending.
    try {
      const open = (await this.client.pendingInteractions(threadId)).filter((i) => isOpenInteraction(i.status));
      const question = open.length ? agentQuestion(threadId, open[0]) : null;
      if (question && !tracker.question) {
        tracker.question = question;
        tracker.turnActive = true;
        this.announceQuestion(tracker);
      }
    } catch (e: any) {
      debug('interactions failed', e?.message);
    }
    this.refreshPhase();
    return tracker;
  }

  // Read only: never sends, edits or deletes queued messages.
  private async refreshQueue(t: Tracker) {
    try {
      t.queue = await this.client.queuedMessages(t.threadId);
      // Gone from the queue: dispatched, or deleted. The timeline's turn request tells which.
      for (const [id, m] of t.mine) if (!t.queue.some((q) => q.id === id)) m.left = true;
    } catch (e: any) {
      debug('queue failed', e?.message);
    }
    this.refreshPhase();
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
    } else if (ev.type === 'client/turn/requested' && t.mine.size) {
      // A queued message of ours went out: this turn answers it. One that left
      // the queue and isn't this request was deleted rather than sent.
      const text = (ev.data?.input ?? []).map((i: any) => i?.text ?? '').join(' ').trim();
      for (const [id, m] of t.mine) if (m.text === text || m.left) t.mine.delete(id);
      t.queue = t.queue.filter((m) => queuedText(m) !== text);
    } else if (ev.type === 'item/completed' && ev.data?.item?.type === 'agentMessage' && ev.data.item.text) {
      const text: string = ev.data.item.text;
      t.turnText.push(text);
      if (relevant) {
        this.log('agent', text);
        // Intermediate messages are progress: quiet context, not speech.
        if (this.started) this.append('thinking', `Progress from the agent in "${t.title}": ${clip(text, APPEND_CHARS)}`);
      }
    } else if (ev.type === 'system/interaction/lifecycle' && ev.data?.interaction?.id) {
      const interaction = ev.data.interaction;
      if (isOpenInteraction(interaction.status)) {
        const question = agentQuestion(t.threadId, interaction);
        if (question) {
          t.question = question;
          this.announceQuestion(t);
        }
      } else if (t.question?.interactionId === interaction.id) {
        // Answered elsewhere (bb's own question card), or the turn was stopped.
        t.question = null;
        if (relevant && this.started && interaction.status === 'resolved') {
          this.append('thinking', `The agent's question in "${t.title}" was answered in bb; it is continuing.`);
        }
      }
    } else if (ev.type === 'turn/completed') {
      t.turnActive = false;
      t.question = null;
      const reply = t.turnText[t.turnText.length - 1] ?? '';
      t.turnText = [];
      const status = ev.data?.status && ev.data.status !== 'completed' ? ` (turn ${ev.data.status})` : '';
      if (t.mine.size) {
        // The turn that ended ran before our queued message; ours goes next.
        if (relevant && this.started) {
          this.append(
            'commentary',
            `The agent in "${t.title}" finished its earlier work${status}${reply ? `: ${clip(reply, 600).replace(/[.!?…\s]+$/, '')}` : ''}. The user's queued message goes to it next; that reply is still to come.`,
          );
        }
        return this.refreshPhase();
      }
      if (relevant && this.started) {
        this.append(
          'commentary',
          reply ? `The agent in "${t.title}" finished${status}. Its reply:\n${reply}` : `The agent in "${t.title}" finished${status} without a text reply.`,
        );
      }
      t.awaitingReply = false;
    }
    this.refreshPhase();
  }

  // Says an open question once, as soon as the voice is connected.
  private announceQuestion(t: Tracker) {
    const q = t.question;
    if (!q || !this.started || this.announced.has(q.interactionId)) return;
    if (!t.awaitingReply && t.threadId !== this.threadId) return;
    this.announced.add(q.interactionId);
    const text = describeQuestion(q);
    this.log('agent', `Question: ${text}`);
    this.append(
      'commentary',
      `The agent in "${t.title}" stopped to ask the user something and is waiting for the answer. Read it to the user word for word, with the options, then wait for their answer:\n${text}`,
    );
  }

  // ---- state ------------------------------------------------------------------

  private tick() {
    const now = Date.now();
    if (this.userLine.trim() && now - this.lastUserDeltaAt > HEARING_DECAY_MS * 2) this.commitUserLine();
    if (this.assistantLine.trim() && now - this.lastOutputAt > SPEAKING_DECAY_MS) this.commitAssistantLine();
    this.endIfDue();
    this.refreshPhase();
  }

  private commitUserLine() {
    const text = this.userLine.trim();
    this.userLine = '';
    if (!text) return;
    this.update({ partial: '' });
    this.log('you', text);
    this.recordTranscript('user', text);
    this.recentUtterances = [...this.recentUtterances, text].slice(-4);
    if (isHangUp(text)) this.requestEnd();
  }

  // Ends after a short goodbye. Both the ticker and incoming events check, so
  // the call still ends if the phone holds timers while locked.
  private requestEnd() {
    if (this.endRequestedAt || !this.enabled) return;
    this.endRequestedAt = Date.now();
    this.log('system', 'Hanging up');
    setTimeout(() => this.endIfDue(), GOODBYE_MS);
  }

  private endIfDue() {
    if (!this.endRequestedAt || Date.now() - this.endRequestedAt < GOODBYE_MS) return;
    debug('hang up');
    this.stop();
  }

  private commitAssistantLine() {
    const text = this.assistantLine.trim();
    this.assistantLine = '';
    if (!text) return;
    this.log('assistant', text);
    this.recordTranscript('assistant', text);
  }

  // ---- transcript -------------------------------------------------------------

  private recordTranscript(role: TranscriptEntry['role'], text: string) {
    const entry = { role, text, at: Date.now() };
    if (this.threadId) this.writeTranscript(this.threadId, [entry]);
    else this.unfiledTranscript.push(entry);
  }

  private writeTranscript(threadId: string, entries: TranscriptEntry[]) {
    this.transcriptWrites = this.transcriptWrites
      .then(() => this.client.appendTranscript(threadId, entries))
      .catch((e) => debug('transcript', e?.message ?? e));
  }

  private refreshPhase() {
    if (!this.enabled || !this.started) return;
    const now = Date.now();
    const relevant = [...this.trackers.values()].filter((t) => t.awaitingReply || t.threadId === this.threadId);
    // The current thread's question first.
    const asking = relevant.filter((t) => t.question).sort((a, b) => Number(b.threadId === this.threadId) - Number(a.threadId === this.threadId))[0];
    const working = this.toolsRunning || relevant.some((t) => t.turnActive && !t.question);
    const phase: Phase =
      now - this.lastOutputAt < SPEAKING_DECAY_MS
        ? 'speaking'
        : now - this.lastUserDeltaAt < HEARING_DECAY_MS
          ? 'hearing'
          : asking
            ? 'asking'
            : working
              ? 'thinking'
              : 'listening';
    const question = asking?.question
      ? `${asking.threadId === this.threadId ? '' : `"${asking.title}": `}${questionSummary(asking.question)}`
      : null;
    const queued = relevant.reduce((n, t) => n + t.queue.length, 0);
    if (phase !== this.snapshot.phase || question !== this.snapshot.question || queued !== this.snapshot.queued) {
      if (!this.snapshot.micMuted) this.platform.keepAlive.update(this.threadTitle, liveNotification(phase, question, queued));
      this.update({ phase, question, queued, error: null });
    }
  }

  private fail(message: string) {
    debug('fail', message);
    this.shutdown({ phase: 'error', error: message });
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
