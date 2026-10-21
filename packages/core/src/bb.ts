// Minimal client for the bb server's public API (/api/v1) and realtime socket (/ws).
// bb has no token auth on these routes; Tailscale is the boundary. React Native
// sends no Origin header, so the browser origin guard passes. The Host must be
// localhost, an IP, or the BB_APP_URL hostname.

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

const EVENT_PAGE = 100;

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
    return this.json<{ ok: true; delivery: 'sent' | 'queued' }>(`/threads/${threadId}/send`, {
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

  createThread(projectId: string, text: string) {
    return this.json<BbThread>(`/threads`, {
      method: 'POST',
      body: JSON.stringify({
        projectId,
        origin: 'app',
        input: [{ type: 'text', text, mentions: [] }],
        environment: { type: 'project-default' },
      }),
    });
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

  // Subscribes to change notifications for one thread. Reconnects until closed.
  watchThread(threadId: string, onChange: () => void): () => void {
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
        onChange(); // catch anything missed while disconnected
      };
      ws.onmessage = (e) => {
        try {
          const msg = JSON.parse(String(e.data));
          if (msg.type === 'changed' && msg.entity === 'thread' && (msg.id === undefined || msg.id === threadId)) {
            onChange();
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

export function threadLabel(t: BbThread) {
  return t.title || t.titleFallback || t.id;
}
