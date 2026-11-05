// Protocol between the bb web UI (the handsfree plugin) and the bb voice
// mobile shell, which loads that UI in a WebView.
//
// Shell → page: injects `window.__BB_VOICE__` before load and dispatches
// `bbvoice:state` whenever the voice session changes.
// Page → shell: `window.ReactNativeWebView.postMessage(JSON)`.

import type { Phase } from './types';
import type { VoiceMode } from './settings';

// Version 2 added native speech for pages: Android WebViews have no speechSynthesis.
export const BRIDGE_VERSION = 2;
export const STATE_EVENT = 'bbvoice:state';
// Dispatched with `detail: { id }` when a `bbvoice.speak` finishes, stops or fails.
export const SPEECH_EVENT = 'bbvoice:speech';

// threadId is null while a session started from the home page is waiting for
// its first message, which creates the thread.
export type BridgeState = {
  threadId: string | null;
  phase: Phase;
  mode: VoiceMode;
};

export type BridgeMessage =
  | { type: 'bbvoice.toggle'; threadId: string }
  | { type: 'bbvoice.newThread'; projectId: string | null }
  | { type: 'bbvoice.settings' }
  | { type: 'bbvoice.speak'; id: string; text: string; rate: number }
  | { type: 'bbvoice.speakStop' };

export function parseBridgeMessage(raw: string): BridgeMessage | null {
  try {
    const msg = JSON.parse(raw);
    if (msg?.type === 'bbvoice.toggle' && typeof msg.threadId === 'string') return msg;
    if (msg?.type === 'bbvoice.newThread') return { type: msg.type, projectId: typeof msg.projectId === 'string' ? msg.projectId : null };
    if (msg?.type === 'bbvoice.settings') return msg;
    if (msg?.type === 'bbvoice.speak' && typeof msg.id === 'string' && typeof msg.text === 'string') {
      return { type: msg.type, id: msg.id, text: msg.text, rate: typeof msg.rate === 'number' ? msg.rate : 1 };
    }
    if (msg?.type === 'bbvoice.speakStop') return msg;
  } catch {}
  return null;
}
