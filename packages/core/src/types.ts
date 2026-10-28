// Shared vocabulary for the voice engines and the platforms that host them.

// asking: an agent is waiting on the user's answer to a question or approval.
export type Phase = 'off' | 'listening' | 'hearing' | 'thinking' | 'asking' | 'speaking' | 'error';

export type LogEntry = { id: number; role: 'you' | 'agent' | 'assistant' | 'system'; text: string };

export type VoiceSnapshot = {
  phase: Phase;
  partial: string;
  log: LogEntry[];
  error: string | null;
  micMuted: boolean;
  // The open question an agent is waiting on, in one line; null when none.
  question: string | null;
  // Messages waiting in the followed threads' queues, not yet delivered to the agent.
  queued: number;
};

// Common surface for the classic (STT + TTS) and live (OpenAI GPT-Live) engines.
export interface VoiceEngine {
  subscribe(fn: (s: VoiceSnapshot) => void): () => void;
  start(): Promise<void>;
  stop(): void;
  interrupt(): boolean;
  // Stop hearing the user without ending the session; replies still play.
  setMicMuted(muted: boolean): void;
}

// The second line of a voice bar (desktop banner and phone bar): an error, then
// an agent's open question unless the user is mid-sentence, then the partial.
// A queued message shows next, so "sent" is never mistaken for "delivered".
export function statusDetail(s: Pick<VoiceSnapshot, 'phase' | 'partial' | 'error' | 'question' | 'queued'>): string {
  if (s.error) return s.error;
  if (s.phase === 'hearing') return s.partial;
  if (s.question) return `Agent asks: ${s.question}`;
  if (s.queued) return queuedLine(s.queued);
  return s.partial;
}

export const queuedLine = (n: number) => `${n} message${n === 1 ? '' : 's'} queued for the agent`;

export const MUTED_NOTIFICATION = 'Mic muted';

export const PHASE_NOTIFICATION: Record<Phase, string> = {
  off: 'Off',
  listening: 'Listening',
  hearing: 'Hearing you',
  thinking: 'Agent working',
  asking: 'Agent has a question',
  speaking: 'Speaking',
  error: 'Error',
};

// Keeps the session alive while the app is backgrounded (Android foreground
// service). Platforms that stay alive on their own pass NO_KEEP_ALIVE.
export interface KeepAlive {
  start(title: string, text: string): Promise<unknown>;
  update(title: string, text: string): void;
  stop(): void;
}

export const NO_KEEP_ALIVE: KeepAlive = {
  start: async () => {},
  update: () => {},
  stop: () => {},
};
