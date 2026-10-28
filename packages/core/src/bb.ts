// Minimal client for the bb server's public API (/api/v1) and realtime socket (/ws).
// bb has no token auth on these routes; Tailscale is the boundary. React Native
// sends no Origin header, so the browser origin guard passes. The Host must be
// localhost, an IP, or the BB_APP_URL hostname.

import type { BbInteraction, QuestionResolution } from './questions';

export type BbThread = {
  id: string;
  title: string | null;
  titleFallback: string | null;
  status: string;
  projectId: string;
  updatedAt: number;
};

export type BbEvent = {
  seq: number;
  type: string;
  data: any;
};

// A message waiting in a thread's queue (bb dispatches it when the thread can take it).
export type BbQueuedMessage = {
  id: string;
  state: string; // queued | scheduled | waiting | failed_retrying | failed_exhausted | claimed
  waitingOn: { kind: string } | null;
  sendAt: number | null;
  content: { type: string; text?: string }[];
  createdAt: number;
};

export const queuedText = (m: BbQueuedMessage) => m.content.map((c) => c.text ?? '').join(' ').trim();

// One spoken turn of a GPT-Live conversation, shown in its thread by the
// handsfree bb plugin (bb's timeline only holds agent turns).
export type TranscriptEntry = { role: 'user' | 'assistant'; text: string; at: number };

// One entry of bb's model catalog: what a new thread can run on.
export type BbModel = { providerId: string; providerName: string; model: string; displayName: string; isDefault: boolean };

// The agent a new thread runs on; omitted fields fall back to the project's defaults.
export type ThreadExecution = { providerId?: string; model?: string };

// A favorite from the model-favorites bb plugin; list order is preference.
export type FavoriteModel = { providerId: string; model: string; nickname?: string };

const EVENT_PAGE = 100;
const TRANSCRIPT_RPC = '/plugins/handsfree/rpc/transcript.append';
const FAVORITES_RPC = '/plugins/model-favorites/rpc/favorites.list';

export class BbClient {
  constructor(public readonly baseUrl: string) {}

  private url(path: string) {
    return `${this.baseUrl.replace(/\/+$/, '')}/api/v1${path}`;
  }

  private async json<T>(path: string, init?: RequestInit): Promise<T> {
    const res = await fetch(this.url(path), {
      ...init,
      headers: { 'content-type': 'application/json', ...(init?.headers ?? {}) },
    });
    const body = await res.text();
    if (!res.ok) {
      let message = body;
      try {
        message = JSON.parse(body).message ?? body;
      } catch {}
      throw new Error(`${res.status}: ${message}`);
    }
    return body ? JSON.parse(body) : (undefined as T);
  }

  // bb returns sidebar order (pinned first); a voice picker wants recency.
  async listThreads(limit = 60) {
    const threads = await this.json<BbThread[]>(`/threads?archived=false&limit=${limit}`);
    return threads.sort((a, b) => b.updatedAt - a.updatedAt);
  }

  getThread(id: string) {
    return this.json<BbThread>(`/threads/${id}`);
  }

  async latestSeq(threadId: string): Promise<number> {
    const rows = await this.json<BbEvent[]>(`/threads/${threadId}/events?order=desc&limit=1`);
    return rows[0]?.seq ?? 0;
  }

  async eventsAfter(threadId: string, afterSeq: number): Promise<BbEvent[]> {
    const out: BbEvent[] = [];
    let cursor = afterSeq;
    for (;;) {
      const page = await this.json<BbEvent[]>(
        `/threads/${threadId}/events?order=asc&limit=${EVENT_PAGE}&afterSeq=${cursor}`,
      );
      out.push(...page);
      if (page.length < EVENT_PAGE) return out;
      cursor = page[page.length - 1].seq;
    }
  }

  send(threadId: string, text: string) {
    return this.json<{ ok: true; delivery: 'sent' | 'queued'; queuedMessage?: BbQueuedMessage }>(`/threads/${threadId}/send`, {
      method: 'POST',
      body: JSON.stringify({ input: [{ type: 'text', text, mentions: [] }], mode: 'queue-if-active' }),
    });
  }

  listProjects() {
    return this.json<{ id: string; name: string }[]>(`/projects`);
  }

  // The project for a new thread when none is chosen: the most recently active one.
  async defaultProjectId(): Promise<string> {
    const [latest] = await this.listThreads();
    if (latest) return latest.projectId;
    const [project] = await this.listProjects();
    if (!project) throw new Error('No bb project to start a thread in');
    return project.id;
  }

  // Every enabled provider's models, in bb's provider order (the same catalog
  // as bb's model pickers and `bb provider models`).
  async listModels(): Promise<BbModel[]> {
    type Options = {
      providers: { id: string; displayName: string; available: boolean }[];
      models: { model: string; displayName?: string | null; isDefault?: boolean }[];
    };
    const { providers } = await this.json<Options>('/system/execution-options');
    const lists = await Promise.allSettled(
      providers
        .filter((p) => p.available)
        .map(async (p) => {
          const { models } = await this.json<Options>(`/system/execution-options?providerId=${encodeURIComponent(p.id)}`);
          return models.map((m) => ({
            providerId: p.id,
            providerName: p.displayName,
            model: m.model,
            displayName: m.displayName || m.model,
            isDefault: Boolean(m.isDefault),
          }));
        }),
    );
    return lists.flatMap((r) => (r.status === 'fulfilled' ? r.value : []));
  }

  // Empty when the model-favorites plugin isn't installed.
  async listFavorites(): Promise<FavoriteModel[]> {
    try {
      const res = await this.json<{ ok: boolean; result?: { favorites: FavoriteModel[] } }>(FAVORITES_RPC, { method: 'POST', body: '{}' });
      return res?.ok ? (res.result?.favorites ?? []) : [];
    } catch {
      return [];
    }
  }

  createThread(projectId: string, text: string, execution: ThreadExecution = {}) {
    return this.json<BbThread>(`/threads`, {
      method: 'POST',
      body: JSON.stringify({
        ...execution,
        projectId,
        origin: 'app',
        input: [{ type: 'text', text, mentions: [] }],
        environment: { type: 'project-default' },
      }),
    });
  }

  async appendTranscript(threadId: string, entries: TranscriptEntry[]) {
    const res = await this.json<{ ok: boolean; error?: { message?: string } }>(TRANSCRIPT_RPC, {
      method: 'POST',
      body: JSON.stringify({ threadId, entries }),
    });
    if (!res?.ok) throw new Error(res?.error?.message ?? 'transcript.append failed');
  }

  // The latest agent messages in a thread, oldest first.
  async recentAgentMessages(threadId: string, count = 3): Promise<string[]> {
    const rows = await this.json<BbEvent[]>(`/threads/${threadId}/events?order=desc&limit=100`);
    return rows
      .filter((r) => r.type === 'item/completed' && r.data?.item?.type === 'agentMessage' && r.data.item.text)
      .slice(0, count)
      .map((r) => r.data.item.text as string)
      .reverse();
  }

  stop(threadId: string) {
    return this.json(`/threads/${threadId}/stop`, { method: 'POST', body: '{}' });
  }

  // Read only: the voice reports the queue, it never sends, edits or deletes rows.
  queuedMessages(threadId: string) {
    return this.json<BbQueuedMessage[]>(`/threads/${threadId}/queued-messages`);
  }

  // The questions and approvals a thread's agent is waiting on (bb lists only open ones).
  pendingInteractions(threadId: string) {
    return this.json<BbInteraction[]>(`/threads/${threadId}/interactions`);
  }

  resolveInteraction(threadId: string, interactionId: string, resolution: QuestionResolution) {
    return this.json<BbInteraction>(`/threads/${threadId}/interactions/${interactionId}/resolve`, {
      method: 'POST',
      body: JSON.stringify(resolution),
    });
  }

  // Subscribes to change notifications for one thread. Reconnects until closed.
  // `changes` are bb's change kinds ("events-appended", "queue-changed",
  // "interactions-changed", …); empty after a (re)connect, when anything may have changed.
  watchThread(threadId: string, onChange: (changes: string[]) => void): () => void {
    let ws: WebSocket | null = null;
    let closed = false;
    let retry: ReturnType<typeof setTimeout> | null = null;
    let ping: ReturnType<typeof setInterval> | null = null;
    const wsUrl = this.baseUrl.replace(/^http/, 'ws').replace(/\/+$/, '') + '/ws';

    const connect = () => {
      ws = new WebSocket(wsUrl);
      ws.onopen = () => {
        ws?.send(JSON.stringify({ type: 'subscribe', target: { kind: 'thread-detail', threadId } }));
        ping = setInterval(() => ws?.send(JSON.stringify({ type: 'ping' })), 25_000);
        onChange([]); // catch anything missed while disconnected
      };
      ws.onmessage = (e) => {
        try {
          const msg = JSON.parse(String(e.data));
          if (msg.type === 'changed' && msg.entity === 'thread' && (msg.id === undefined || msg.id === threadId)) {
            onChange(Array.isArray(msg.changes) ? msg.changes.map(String) : []);
          }
        } catch {}
      };
      ws.onclose = () => {
        if (ping) clearInterval(ping);
        if (!closed) retry = setTimeout(connect, 1500);
      };
      ws.onerror = () => ws?.close();
    };
    connect();

    return () => {
      closed = true;
      if (retry) clearTimeout(retry);
      if (ping) clearInterval(ping);
      ws?.close();
    };
  }
}

const words = (s: string) => s.toLowerCase().replace(/favourite/g, 'favorite').split(/[^a-z0-9]+/).filter(Boolean);
const joined = (s: string) => words(s).join('');
const modelKey = (m: { providerId: string; model: string }) => `${m.providerId}:${m.model}`;
const FILLER = new Set(['my', 'the', 'a', 'an', 'model', 'please', 'one']);
const ORDINALS: Record<string, number> = { first: 0, second: 1, third: 2, fourth: 3, fifth: 4, '1': 0, '2': 1, '3': 2, '4': 3, '5': 4 };

// Resolves a spoken model name ("Luna", "GPT 5.6 Luna", "Opus") against the
// catalog. Exact ids and names win; otherwise every spoken word must appear in
// the model's id or name. Ties go to a favorite, then a provider's default
// model, then catalog order.
export function findModel(models: BbModel[], query: string, provider?: string, favorites: FavoriteModel[] = []): BbModel | null {
  const want = words(query);
  if (want.length === 0) return null;
  const prov = provider ? joined(provider) : '';
  const pool = prov ? models.filter((m) => joined(m.providerId).includes(prov) || joined(m.providerName).includes(prov)) : models;
  const q = want.join('');
  const preferred = new Set(favorites.map(modelKey));
  const score = (m: BbModel) => {
    if (joined(m.model) === q || joined(m.displayName) === q) return 3;
    const have = new Set([...words(m.model), ...words(m.displayName)]);
    return want.every((w) => have.has(w)) ? 2 : 0;
  };
  let best: BbModel | null = null;
  let bestScore = 0;
  for (const m of pool) {
    const base = score(m);
    if (base < 2) continue;
    const s = base + (preferred.has(modelKey(m)) ? 0.75 : 0) + (m.isDefault ? 0.5 : 0);
    if (s > bestScore) [best, bestScore] = [m, s];
  }
  return best;
}

// Like findModel, but understands favorites first: "my favorite", "second
// favorite", or a favorite's nickname ("my fast model").
export function resolveModel(models: BbModel[], favorites: FavoriteModel[], query: string, provider?: string): BbModel | null {
  const asModel = (f: FavoriteModel): BbModel =>
    models.find((m) => modelKey(m) === modelKey(f)) ?? { ...f, providerName: f.providerId, displayName: f.model, isDefault: false };
  const want = words(query).filter((w) => !FILLER.has(w));
  if (want.includes('favorite') && favorites.length) {
    const rest = want.filter((w) => w !== 'favorite' && w !== 'number');
    if (rest.length === 0) return asModel(favorites[0]);
    if (rest.length === 1 && ORDINALS[rest[0]] !== undefined) return favorites[ORDINALS[rest[0]]] ? asModel(favorites[ORDINALS[rest[0]]]) : null;
  }
  const q = want.join('');
  const nick = favorites.find((f) => f.nickname && (joined(f.nickname) === q || joined(f.nickname.replace(/\bmodel\b/i, '')) === q));
  if (nick) return asModel(nick);
  return findModel(models, want.join(' ') || query, provider, favorites);
}

const COMMAND = /^\s*(?:(?:hey|ok|okay|please|so|can you|could you|would you|let's|lets|i want to|i'd like to)[\s,]+)*(?:(?:create|start|make|open|spin up|begin|kick off)\s+(?:a\s+|another\s+)?|(?=new\s))(?:new\s+|fresh\s+)?(?:(.+?)\s+)?(?:thread|chat|conversation|session)\b[\s,.:;]*(.*)$/i;
const MODEL_INTRO = /^(?:with|using|on|in|via|running)\s+(.*)$/i;
const JOINERS = new Set(['and', 'to', 'that', 'which', 'so', 'then', 'saying', 'asking', 'telling']);
const PROVIDER_SPLIT = /\s+(?:on|in|via|through)\s+/i;

export type NewThreadCommand = { model?: string; provider?: string; message: string };

// Parses "Create a new thread with Luna", "start a thread using my fast model
// and fix the login bug", "new Luna thread: ..." or "a thread with Luna on Pi".
// null when the text isn't a new-thread command.
export function parseNewThreadCommand(text: string): NewThreadCommand | null {
  const m = COMMAND.exec(text.trim());
  if (!m) return null;
  let phrase = '';
  let rest = (m[2] ?? '').trim();
  // "new Luna thread" puts the model before the noun.
  const before = (m[1] ?? '').trim();
  if (before && !/^(new|fresh|another)$/i.test(before)) phrase = before;
  const intro = MODEL_INTRO.exec(rest);
  if (!phrase && intro) {
    // The model phrase runs until a joiner word or clause punctuation.
    const tokens = intro[1].split(/\s+/);
    const taken: string[] = [];
    let i = 0;
    for (; i < tokens.length; i++) {
      const t = tokens[i];
      if (JOINERS.has(t.toLowerCase().replace(/[^a-z']/g, ''))) {
        i++;
        break;
      }
      const end = /[,:;]$|[.!?]$/.test(t) && !/\d\.$/.test(t);
      taken.push(end ? t.slice(0, -1) : t);
      if (end) {
        i++;
        break;
      }
    }
    phrase = taken.join(' ');
    rest = tokens.slice(i).join(' ');
  }
  const message = rest
    .replace(/^[\s,.:;]+/, '')
    .replace(/^(?:and|to|that|which|so|then)\s+/i, '')
    .trim();
  if (!phrase) return { message };
  const [model, provider] = phrase.split(PROVIDER_SPLIT);
  return { model: model.trim(), ...(provider ? { provider: provider.trim() } : {}), message };
}

// Stored as "providerId:model" (model ids can contain "/"); "" means the project default.
export function parseThreadModel(value: string | undefined): ThreadExecution {
  const i = value ? value.indexOf(':') : -1;
  return value && i > 0 ? { providerId: value.slice(0, i), model: value.slice(i + 1) } : {};
}

export function threadLabel(t: BbThread) {
  return t.title || t.titleFallback || t.id;
}
