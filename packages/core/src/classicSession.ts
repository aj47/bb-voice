// Hands-free loop: listen → debounce → send to bb → speak the streamed reply → listen.
//
// Lessons carried over from dotagents' Android service:
// - Use standard (non-segmented, non-continuous) recognizer sessions and restart
//   them on `end`. Samsung's segmented sessions emit empty results and cancel.
// - Prefer on-device recognition.
// - Debounce finals (~1.5s) so a pause mid-thought doesn't send half a sentence;
//   any new speech holds the pending send.
// - Half duplex: stop the mic while TTS plays so the agent never hears itself.
// - An agent's question holds its turn open; the next utterance answers it
//   directly, since a message sent meanwhile would only queue behind it.

import { BbClient, parseNewThreadCommand, resolveModel, threadLabel, type BbEvent, type ThreadExecution } from './bb';
import { agentQuestion, buildAnswer, describeQuestion, isOpenInteraction, questionSummary, type AgentQuestion } from './questions';
import { SentenceChunker } from './speakable';
import { MUTED_NOTIFICATION, PHASE_NOTIFICATION, type KeepAlive, type LogEntry, type Phase, type VoiceEngine, type VoiceSnapshot } from './types';

export type VoiceSettings = {
  language: string;
  rate: number;
  debounceMs: number;
};

// Speech recognition, modelled on expo-speech-recognition: each `start` is one
// short session that ends with `end`. `speech` is optional, for recognizers
// without partial transcripts (it marks voice activity).
export type RecognizerEvents = {
  result(transcript: string, isFinal: boolean): void;
  end(): void;
  error(code: string, message?: string): void;
  speech?(): void;
};

export interface Recognizer {
  requestPermission(): Promise<boolean>;
  listen(events: RecognizerEvents): () => void;
  start(language: string): void;
  abort(): void;
}

export interface Speaker {
  speak(text: string, options: { language: string; rate: number; onDone: () => void }): void;
  stop(): void;
}

export type ClassicPlatform = { recognizer: Recognizer; speaker: Speaker; keepAlive: KeepAlive };

// A session with no thread yet: the first utterance starts one in `projectId`
// (null: the most recently active project) and the session follows it.
export type NewThreadOptions = {
  projectId?: string | null;
  // The agent the new thread runs on; omitted: the project's defaults.
  execution?: ThreadExecution;
  onThreadChange?: (threadId: string, title: string) => void;
};

const LOG_LIMIT = 60;
const debug = (...args: unknown[]) => console.log('[bbvoice]', ...args);
const STOP_WORDS = new Set(['stop', 'cancel', 'stop stop', 'stop it', 'never mind', 'nevermind']);
const BENIGN_ERRORS = new Set(['no-speech', 'aborted', 'speech-timeout', 'busy', 'client']);

export class ClassicSession implements VoiceEngine {
  private snapshot: VoiceSnapshot = { phase: 'off', partial: '', log: [], error: null, micMuted: false, question: null, queued: 0 };
  private listeners = new Set<(s: VoiceSnapshot) => void>();
  private unlisten: (() => void) | null = null;
  private unwatch: (() => void) | null = null;

  private enabled = false;
  private recognizing = false;
  private restartTimer: ReturnType<typeof setTimeout> | null = null;
  private errorStreak = 0;

  private pending: string[] = [];
  // Google's on-device recognizer often ends a session with an empty final
  // result (or `no-speech`) after streaming good partials. Keep the latest
  // partial and commit it when the session ends without a final.
  private lastPartial = '';
  private sendTimer: ReturnType<typeof setTimeout> | null = null;

  private lastSeq = 0;
  private syncing: Promise<void> | null = null;
  private resync = false;
  private turnActive = false;
  private chunkers = new Map<string, SentenceChunker>();
  private spokenItems = new Set<string>();
  private agentText = new Map<string, number>(); // itemId → log entry id

  private speechQueued = 0;
  private muted = false; // user interrupted: drop the rest of this turn's speech
  private nextLogId = 1;
  // Chosen by "create a new thread with Luna" before the first real message.
  private pendingExecution: ThreadExecution | null = null;
  // The question or approval the agent is waiting on.
  private question: AgentQuestion | null = null;

  constructor(
    private platform: ClassicPlatform,
    private client: BbClient,
    private threadId: string | null,
    private settings: VoiceSettings,
    private title: string,
    private options: NewThreadOptions = {},
  ) {}

  subscribe(fn: (s: VoiceSnapshot) => void) {
    this.listeners.add(fn);
    fn(this.snapshot);
    return () => this.listeners.delete(fn);
  }

  async start() {
    if (this.enabled) return;
    if (!(await this.platform.recognizer.requestPermission())) {
      this.update({ phase: 'error', error: 'Microphone permission denied' });
      return;
    }
    this.enabled = true;
    this.errorStreak = 0;
    await this.platform.keepAlive.start(this.title, 'Listening');
    this.bindRecognizer();

    if (this.threadId) {
      const threadId = this.threadId;
      try {
        this.lastSeq = await this.client.latestSeq(threadId);
        const thread = await this.client.getThread(threadId);
        this.turnActive = thread.status === 'active';
        // A question asked before the session started is behind lastSeq; bb lists it as pending.
        const open = (await this.client.pendingInteractions(threadId)).find((i) => isOpenInteraction(i.status));
        if (open) this.ask(agentQuestion(threadId, open));
      } catch (e: any) {
        this.update({ phase: 'error', error: `Can't reach bb: ${e.message}` });
      }
      this.unwatch = this.client.watchThread(threadId, (changes) => this.onChange(changes));
    }
    this.refreshPhase();
    this.listen();
  }

  stop() {
    this.enabled = false;
    this.clearTimers();
    this.pending = [];
    this.unwatch?.();
    this.unwatch = null;
    this.unlisten?.();
    this.unlisten = null;
    try {
      this.platform.recognizer.abort();
    } catch {}
    this.recognizing = false;
    this.platform.speaker.stop();
    this.speechQueued = 0;
    this.platform.keepAlive.stop();
    this.question = null;
    this.update({ phase: 'off', partial: '', micMuted: false, question: null, queued: 0 });
  }

  // Muting keeps what was already heard: it still sends after the usual pause.
  setMicMuted(muted: boolean) {
    if (muted === this.snapshot.micMuted) return;
    this.update({ micMuted: muted });
    if (muted) {
      if (this.lastPartial) {
        this.pending.push(this.lastPartial);
        if (!this.sendTimer) this.scheduleSend();
      }
      this.pauseMic();
      this.platform.keepAlive.update(this.title, MUTED_NOTIFICATION);
    } else {
      this.platform.keepAlive.update(this.title, PHASE_NOTIFICATION[this.snapshot.phase]);
      this.listen();
    }
  }

  // Tap while speaking: shut up and listen. Tap otherwise: toggle on/off.
  interrupt() {
    if (this.speechQueued > 0) {
      this.muted = this.turnActive;
      this.speechQueued = 0;
      this.platform.speaker.stop();
      this.refreshPhase();
      this.listen();
      return true;
    }
    return false;
  }

  // ---- recognizer ---------------------------------------------------------

  private bindRecognizer() {
    this.unlisten = this.platform.recognizer.listen({
      // Not `speechstart`: each restarted session fires it on noise ~350ms in,
      // which would hold the pending send forever. Only real words hold it.
      result: (raw, isFinal) => {
        const text = raw.trim();
        debug('result', isFinal ? 'final' : 'partial', JSON.stringify(raw));
        if (!text) return;
        this.errorStreak = 0;
        if (isFinal) {
          this.lastPartial = '';
          this.pending.push(text);
          this.update({ partial: this.pending.join(' ') });
          this.scheduleSend();
        } else {
          // After end-of-speech the on-device recognizer re-sends the
          // transcript in segments; a leading space marks a continuation.
          const continuation = /^\s/.test(raw) && this.lastPartial && !this.lastPartial.endsWith(text);
          this.lastPartial = continuation ? `${this.lastPartial} ${text}` : text;
          this.holdSend();
          this.update({ phase: 'hearing', partial: [...this.pending, this.lastPartial].join(' ') });
        }
      },
      speech: () => {
        this.holdSend();
        this.update({ phase: 'hearing' });
      },
      end: () => {
        debug('end', { lastPartial: this.lastPartial, pending: this.pending, timer: !!this.sendTimer, speech: this.speechQueued });
        this.recognizing = false;
        if (this.lastPartial) {
          this.pending.push(this.lastPartial);
          this.lastPartial = '';
        }
        // A restarted session can fire speechstart on noise and hold the send;
        // whenever a session ends with words pending and no timer, re-arm it.
        if (this.pending.length && !this.sendTimer) this.scheduleSend();
        this.scheduleListen(this.errorStreak ? Math.min(4000, 400 * this.errorStreak) : 50);
      },
      error: (code, message) => {
        if (BENIGN_ERRORS.has(code)) return;
        this.errorStreak++;
        if (code === 'not-allowed') {
          this.update({ phase: 'error', error: 'Microphone permission denied' });
          this.enabled = false;
          return;
        }
        this.log('system', `Mic: ${code} ${message ?? ''}`.trim());
      },
    });
  }

  private canListen() {
    return this.enabled && this.speechQueued === 0 && !this.snapshot.micMuted;
  }

  private listen() {
    if (!this.canListen() || this.recognizing) return;
    this.recognizing = true;
    try {
      this.platform.recognizer.start(this.settings.language);
    } catch {
      this.recognizing = false;
      this.errorStreak++;
      this.scheduleListen(1000);
    }
  }

  private scheduleListen(delay: number) {
    if (this.restartTimer) clearTimeout(this.restartTimer);
    this.restartTimer = setTimeout(() => {
      this.restartTimer = null;
      this.listen();
    }, delay);
  }

  private pauseMic() {
    this.lastPartial = '';
    if (this.restartTimer) clearTimeout(this.restartTimer);
    if (!this.recognizing) return;
    try {
      this.platform.recognizer.abort();
    } catch {}
    this.recognizing = false;
  }

  // ---- sending ------------------------------------------------------------

  private holdSend() {
    if (this.sendTimer) {
      debug('hold send');
      clearTimeout(this.sendTimer);
      this.sendTimer = null;
    }
  }

  private scheduleSend() {
    this.holdSend();
    this.sendTimer = setTimeout(() => this.flushUtterance(), this.settings.debounceMs);
  }

  private async flushUtterance() {
    this.sendTimer = null;
    const text = this.pending.join(' ').trim();
    debug('flush', JSON.stringify(text));
    this.pending = [];
    this.update({ partial: '' });
    if (!text) return this.refreshPhase();

    const normalized = text.toLowerCase().replace(/[^a-z ]/g, '').trim();
    if (STOP_WORDS.has(normalized)) {
      this.log('you', text);
      if (this.turnActive && this.threadId) {
        this.client.stop(this.threadId).catch((e) => this.log('system', `Stop failed: ${e.message}`));
      }
      return this.refreshPhase();
    }

    this.log('you', text);
    this.muted = false;
    if (this.question && this.threadId) return this.answer(this.threadId, this.question, text);
    this.turnActive = true;
    this.refreshPhase();
    if (!this.threadId) return this.newThread(text);
    try {
      const res = await this.client.send(this.threadId, text);
      debug('sent', res.delivery);
      if (res.delivery === 'queued') this.log('system', 'Queued behind the current turn');
    } catch (e: any) {
      this.turnActive = false;
      debug('send failed', e.message);
      this.log('system', `Send failed: ${e.message}`);
      this.refreshPhase();
    }
  }

  private async answer(threadId: string, question: AgentQuestion, text: string) {
    const built = buildAnswer(question, text);
    if ('error' in built) return this.reply(built.error);
    try {
      await this.client.resolveInteraction(threadId, question.interactionId, built.resolution);
      if (this.question?.interactionId === question.interactionId) this.question = null;
      this.turnActive = true;
      this.refreshPhase();
    } catch (e: any) {
      this.reply(`I couldn't send that answer: ${e.message}`);
    }
  }

  // Reads a new question aloud once; the next utterance answers it.
  private ask(question: AgentQuestion | null) {
    if (!question || this.question?.interactionId === question.interactionId) return;
    this.question = question;
    this.turnActive = true;
    this.log('agent', `Question: ${describeQuestion(question)}`);
    this.muted = false;
    // Spoken to the user directly: prompts and option labels, not the descriptions.
    this.speak(
      question.kind === 'question'
        ? question.questions.flatMap((item) => [item.prompt, ...item.options.map((o, j) => `${j + 1}. ${o.label.replace(/\s*\(recommended\)/i, ', recommended')}.`)])
        : [describeQuestion(question)],
    );
  }

  // Before there is a thread, "create a new thread with Luna[ and …]" picks the
  // model (a name, a favorite's nickname, or "my favorite"); anything else is
  // the first message.
  private async newThread(text: string) {
    const cmd = parseNewThreadCommand(text);
    if (!cmd) return this.startThread(text, this.pendingExecution ?? this.options.execution);
    let execution = this.pendingExecution ?? this.options.execution;
    let picked = '';
    if (cmd.model) {
      try {
        const [models, favorites] = await Promise.all([this.client.listModels(), this.client.listFavorites()]);
        const hit = resolveModel(models, favorites, cmd.model, cmd.provider);
        if (!hit) return this.reply(`I couldn't find a model called ${cmd.model}. Try again, or name another one.`);
        execution = this.pendingExecution = { providerId: hit.providerId, model: hit.model };
        picked = hit.displayName;
      } catch (e: any) {
        return this.reply(`I couldn't load the models: ${e.message}`);
      }
    }
    if (!cmd.message) return this.reply(picked ? `Okay, ${picked}. What should the new thread do?` : 'Okay. What should the new thread do?');
    return this.startThread(cmd.message, execution);
  }

  private reply(text: string) {
    this.turnActive = false;
    this.log('assistant', text);
    this.speak([text]);
    this.refreshPhase();
  }

  private async startThread(text: string, execution: ThreadExecution | undefined) {
    try {
      const projectId = this.options.projectId ?? (await this.client.defaultProjectId());
      const thread = await this.client.createThread(projectId, text, execution);
      this.pendingExecution = null;
      if (!this.enabled) return;
      this.threadId = thread.id;
      this.title = threadLabel(thread);
      this.lastSeq = 0;
      this.unwatch = this.client.watchThread(thread.id, (changes) => this.onChange(changes));
      this.log('system', `Started "${this.title}"`);
      this.options.onThreadChange?.(thread.id, this.title);
    } catch (e: any) {
      this.turnActive = false;
      this.log('system', `Couldn't start a thread: ${e.message}`);
      this.refreshPhase();
    }
  }

  // ---- thread events ------------------------------------------------------

  // Queue changes are not timeline events; bb signals them as "queue-changed".
  private onChange(changes: string[]) {
    if (changes.length === 0 || changes.includes('queue-changed')) void this.refreshQueue();
    if (changes.length === 0 || changes.some((c) => c !== 'queue-changed')) this.sync();
  }

  // Read only: the count shown in the voice bar.
  private async refreshQueue() {
    if (!this.threadId) return;
    try {
      const queued = (await this.client.queuedMessages(this.threadId)).length;
      if (queued !== this.snapshot.queued) this.update({ queued });
    } catch {}
  }

  private sync() {
    if (this.syncing) {
      this.resync = true;
      return;
    }
    this.syncing = (async () => {
      do {
        this.resync = false;
        try {
          const events = this.threadId ? await this.client.eventsAfter(this.threadId, this.lastSeq) : [];
          for (const ev of events) this.apply(ev);
        } catch (e: any) {
          this.log('system', `Sync failed: ${e.message}`);
        }
      } while (this.resync && this.enabled);
      this.syncing = null;
    })();
  }

  private apply(ev: BbEvent) {
    this.lastSeq = Math.max(this.lastSeq, ev.seq);
    switch (ev.type) {
      case 'turn/started':
        this.turnActive = true;
        break;
      case 'item/agentMessage/delta': {
        const id = ev.data?.itemId;
        if (!id || typeof ev.data?.delta !== 'string') break;
        this.spokenItems.add(id);
        this.appendAgentText(id, ev.data.delta);
        this.speak(this.chunker(id).push(ev.data.delta));
        break;
      }
      case 'item/completed': {
        const item = ev.data?.item;
        if (item?.type !== 'agentMessage') break;
        if (!this.spokenItems.has(item.id) && item.text) {
          this.appendAgentText(item.id, item.text);
          this.speak(this.chunker(item.id).push(item.text));
        }
        this.speak(this.chunker(item.id).flush());
        this.chunkers.delete(item.id);
        this.spokenItems.delete(item.id);
        break;
      }
      case 'system/interaction/lifecycle': {
        const interaction = ev.data?.interaction;
        if (!interaction?.id || !this.threadId) break;
        if (isOpenInteraction(interaction.status)) this.ask(agentQuestion(this.threadId, interaction));
        else if (this.question?.interactionId === interaction.id) this.question = null;
        break;
      }
      case 'turn/completed':
        this.turnActive = false;
        this.question = null;
        for (const c of this.chunkers.values()) this.speak(c.flush());
        this.chunkers.clear();
        this.spokenItems.clear();
        this.muted = false;
        break;
    }
    this.refreshPhase();
  }

  private chunker(id: string) {
    let c = this.chunkers.get(id);
    if (!c) this.chunkers.set(id, (c = new SentenceChunker()));
    return c;
  }

  // ---- speech -------------------------------------------------------------

  private speak(sentences: string[]) {
    if (!this.enabled || this.muted || sentences.length === 0) return;
    debug('speak', sentences.length);
    this.holdSend();
    if (this.lastPartial) {
      this.pending.push(this.lastPartial);
      this.lastPartial = '';
    }
    this.pauseMic();
    for (const text of sentences) {
      this.speechQueued++;
      const done = () => {
        this.speechQueued = Math.max(0, this.speechQueued - 1);
        if (this.speechQueued === 0) {
          this.refreshPhase();
          if (this.pending.length) this.scheduleSend();
          this.scheduleListen(150);
        }
      };
      this.platform.speaker.speak(text, { language: this.settings.language, rate: this.settings.rate, onDone: done });
    }
    this.refreshPhase();
  }

  // ---- state --------------------------------------------------------------

  private refreshPhase() {
    if (!this.enabled) return;
    const phase: Phase =
      this.speechQueued > 0 ? 'speaking' : this.question ? 'asking' : this.turnActive ? 'thinking' : 'listening';
    const question = this.question ? questionSummary(this.question) : null;
    const changed = phase !== this.snapshot.phase || question !== this.snapshot.question;
    if (changed && !this.snapshot.micMuted) this.platform.keepAlive.update(this.title, `${PHASE_NOTIFICATION[phase]}${question ? `: ${question}` : ''}`);
    if (changed || this.snapshot.error) this.update({ phase, question, error: null });
  }

  private appendAgentText(itemId: string, delta: string) {
    const existing = this.agentText.get(itemId);
    if (existing !== undefined) {
      const log = this.snapshot.log.map((l) => (l.id === existing ? { ...l, text: l.text + delta } : l));
      this.update({ log });
      return;
    }
    this.agentText.set(itemId, this.log('agent', delta));
  }

  private log(role: LogEntry['role'], text: string) {
    const id = this.nextLogId++;
    const log = [...this.snapshot.log, { id, role, text }].slice(-LOG_LIMIT);
    this.update({ log });
    return id;
  }

  private update(patch: Partial<VoiceSnapshot>) {
    this.snapshot = { ...this.snapshot, ...patch };
    this.listeners.forEach((fn) => fn(this.snapshot));
  }

  private clearTimers() {
    if (this.restartTimer) clearTimeout(this.restartTimer);
    if (this.sendTimer) clearTimeout(this.sendTimer);
    this.restartTimer = this.sendTimer = null;
  }
}

export const DEFAULT_SETTINGS: VoiceSettings = {
  language: 'en-US',
  rate: 1.05,
  debounceMs: 1500,
};
