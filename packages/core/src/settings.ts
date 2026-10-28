// Voice preferences shared by the mobile app and the desktop plugin. Each
// platform stores them its own way; the OpenAI key never lives here.

export type VoiceMode = 'live' | 'classic';

export type VoicePrefs = {
  mode: VoiceMode;
  liveModel: string;
  liveVoice: string;
  delegateModel: string;
  // Agent for threads the voice starts: "providerId:model", or "" for the project default.
  threadModel: string;
};

export const DEFAULT_PREFS: VoicePrefs = {
  mode: 'live',
  liveModel: 'gpt-live-1',
  liveVoice: 'marin',
  delegateModel: 'gpt-6-luna',
  threadModel: '',
};

// GPT-Live voices from OpenAI's docs; marin and cedar are the recommended defaults.
export const LIVE_VOICES = [
  'marin', 'cedar', 'quartz', 'ripple', 'vesper', 'willow', 'stone', 'gleam', 'meridian', 'bossa', 'tempo',
  'beacon', 'delta', 'cinder', 'nuri', 'juni', 'flitz', 'brise', 'sillage', 'nira', 'harema', 'shida', 'noeul',
  'alloy', 'ash', 'ballad', 'coral', 'echo', 'sage', 'shimmer', 'verse',
];
