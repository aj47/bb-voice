// Protocol between the bb web UI (the handsfree plugin) and the bb voice
// mobile shell, which loads that UI in a WebView.
//
// Shell → page: injects `window.__BB_VOICE__` before load and dispatches
// `bbvoice:state` whenever the voice session changes.
// Page → shell: `window.ReactNativeWebView.postMessage(JSON)`.

import type { Phase } from './types';
import type { VoiceMode } from './settings';

export const BRIDGE_VERSION = 1;
export const STATE_EVENT = 'bbvoice:state';

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
  | { type: 'bbvoice.settings' };

export function parseBridgeMessage(raw: string): BridgeMessage | null {
  try {
    const msg = JSON.parse(raw);
    if (msg?.type === 'bbvoice.toggle' && typeof msg.threadId === 'string') return msg;
    if (msg?.type === 'bbvoice.newThread') return { type: msg.type, projectId: typeof msg.projectId === 'string' ? msg.projectId : null };
    if (msg?.type === 'bbvoice.settings') return msg;
  } catch {}
  return null;
}
