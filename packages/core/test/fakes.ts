// In-memory stand-ins for bb's API and the platforms, enough to drive a session.
import type { BbEvent, BbQueuedMessage } from '../src';

export type Call = { method: string; args: unknown[] };

export function fakeBb(threads: Record<string, { title: string; status?: string }>) {
  const events: Record<string, BbEvent[]> = {};
  const pending: Record<string, any[]> = {};
  const queues: Record<string, BbQueuedMessage[]> = {};
  // Threads whose agent is busy: a send queues behind the running turn.
  const busy = new Set<string>();
  const watchers: Record<string, (changes: string[]) => void> = {};
  let nextQueued = 1;
  const calls: Call[] = [];
  const log = (method: string, ...args: unknown[]) => calls.push({ method, args });
  const client = {
    getThread: async (id: string) => ({ id, title: threads[id].title, titleFallback: null, status: threads[id].status ?? 'idle', projectId: 'proj_1', updatedAt: 0 }),
    latestSeq: async (id: string) => events[id]?.at(-1)?.seq ?? 0,
    eventsAfter: async (id: string, after: number) => (events[id] ?? []).filter((e) => e.seq > after),
    recentAgentMessages: async () => [],
    listFavorites: async () => [],
    listModels: async () => [],
    listThreads: async () => [],
    listProjects: async () => [],
    pendingInteractions: async (id: string) => pending[id] ?? [],
    queuedMessages: async (id: string) => (log('queuedMessages', id), [...(queues[id] ?? [])]),
    resolveInteraction: async (threadId: string, interactionId: string, resolution: unknown) => {
      log('resolveInteraction', threadId, interactionId, resolution);
      pending[threadId] = (pending[threadId] ?? []).filter((i) => i.id !== interactionId);
      return { id: interactionId, status: 'resolving', payload: {} };
    },
    send: async (threadId: string, text: string) => {
      log('send', threadId, text);
      if (!busy.has(threadId)) return { ok: true, delivery: 'sent' };
      const row = queuedRow(`qmsg_${nextQueued++}`, text, 'thread-busy');
      (queues[threadId] ??= []).push(row);
      return { ok: true, delivery: 'queued', queuedMessage: row };
    },
    stop: async (threadId: string) => log('stop', threadId),
    createThread: async (projectId: string, text: string) => {
      log('createThread', projectId, text);
      const id = `thr_new${Object.keys(threads).length}`;
      threads[id] = { title: text.slice(0, 30) };
      return { id, title: threads[id].title, titleFallback: null, status: 'active', projectId, updatedAt: 0 };
    },
    appendTranscript: async () => {},
    watchThread: (id: string, onChange: (changes: string[]) => void) => {
      watchers[id] = onChange;
      return () => delete watchers[id];
    },
  };
  return {
    client: client as any,
    calls,
    pending,
    queues,
    busy,
    // Appends events and fires the thread's change notification, like bb's /ws.
    push(threadId: string, ...evs: BbEvent[]) {
      (events[threadId] ??= []).push(...evs);
      watchers[threadId]?.(['events-appended']);
    },
    // Replaces the thread's queue as bb would, and sends "queue-changed".
    setQueue(threadId: string, rows: BbQueuedMessage[]) {
      queues[threadId] = rows;
      watchers[threadId]?.(['queue-changed']);
    },
  };
}

export function fakeKeepAlive() {
  const lines: string[] = [];
  return { lines, keepAlive: { start: async (_t: string, text: string) => void lines.push(text), update: (_t: string, text: string) => void lines.push(text), stop() {} } };
}

export function fakeLivePlatform() {
  const sent: any[] = [];
  const handlers: ((e: { data: string }) => void)[] = [];
  const { lines, keepAlive } = fakeKeepAlive();
  let session: any = null;
  const dc = { readyState: 'open', send: (s: string) => sent.push(JSON.parse(s)), addEventListener: (t: string, fn: any) => t === 'message' && handlers.push(fn), close() {} };
  const platform = {
    createPeerConnection: () => ({
      connectionState: 'connected',
      addEventListener() {},
      addTrack() {},
      createDataChannel: () => dc,
      createOffer: async () => ({ sdp: 'offer' }),
      setLocalDescription: async () => {},
      setRemoteDescription: async () => {},
      close() {},
    }),
    getUserMedia: async () => ({ getTracks: () => [] }),
    negotiate: async (_sdp: string, config: unknown) => {
      session = config;
      return 'answer';
    },
    keepAlive,
  };
  const emit = (ev: unknown) => handlers.forEach((fn) => fn({ data: JSON.stringify(ev) }));
  let n = 0;
  return {
    platform,
    sent,
    notifications: lines,
    config: () => session,
    emit,
    // A tool call from the Responses delegate, then its response.done.
    call(name: string, args: unknown) {
      const call_id = `call_${++n}`;
      emit({ type: 'response.event', event: { type: 'response.output_item.done', item: { type: 'function_call', call_id, name, arguments: JSON.stringify(args) } } });
      emit({ type: 'response.event', event: { type: 'response.done' } });
      return call_id;
    },
    output(callId: string) {
      const item = sent.find((e) => e.type === 'response.item.create' && e.item.call_id === callId);
      return item ? JSON.parse(item.item.output) : undefined;
    },
    appends: (kind?: 'commentary' | 'thinking') => sent.filter((e) => (kind ? e.type === `session.${kind}.append` : /^session\.(commentary|thinking)\.append$/.test(e.type))).map((e) => e.content as string),
  };
}

export const tick = (ms = 0) => new Promise((r) => setTimeout(r, ms));

export const queuedRow = (id: string, text: string, waitingOn: string | null, state = 'waiting'): BbQueuedMessage => ({
  id,
  state,
  waitingOn: waitingOn ? { kind: waitingOn } : null,
  sendAt: null,
  content: [{ type: 'text', text }],
  createdAt: Date.now(),
});
