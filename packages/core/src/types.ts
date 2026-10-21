// Shared vocabulary for the voice engines and the platforms that host them.

export type Phase = 'off' | 'listening' | 'hearing' | 'thinking' | 'speaking' | 'error';

export type LogEntry = { id: number; role: 'you' | 'agent' | 'assistant' | 'system'; text: string };

export type VoiceSnapshot = {
  phase: Phase;
  partial: string;
  log: LogEntry[];
  error: string | null;
  micMuted: boolean;
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

export const MUTED_NOTIFICATION = 'Mic muted';

export const PHASE_NOTIFICATION: Record<Phase, string> = {
  off: 'Off',
  listening: 'Listening',
  hearing: 'Hearing you',
  thinking: 'Agent working',
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
