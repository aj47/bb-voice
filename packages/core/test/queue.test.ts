import { afterEach, describe, expect, it, vi } from 'vitest';
import { ClassicSession, LiveSession, statusDetail, type VoiceSnapshot } from '../src';
import { COLOR_QUESTION, lifecycle } from './fixtures';
import { fakeBb, fakeKeepAlive, fakeLivePlatform, queuedRow, tick } from './fakes';

vi.spyOn(console, 'log').mockImplementation(() => {});

const SETTINGS = { model: 'gpt-live-1', voice: 'marin', delegateModel: 'gpt-6-luna' };
// The only calls a voice may make against a queue: reading it, and sending a new message.
const READ_ONLY = new Set(['queuedMessages', 'send', 'resolveInteraction']);
let session: { stop(): void } | null = null;
afterEach(() => session?.stop());

async function startLive() {
  const bb = fakeBb({ thr_kanban: { title: 'Kanban backlog', status: 'active' } });
  bb.busy.add('thr_kanban');
  const live = fakeLivePlatform();
  const s = new LiveSession(live.platform as any, bb.client, 'thr_kanban', 'Kanban backlog', SETTINGS);
  session = s;
  let snap: VoiceSnapshot | null = null;
  s.subscribe((x) => (snap = x));
  await s.start();
  live.emit({ type: 'session.started' });
  return { bb, live, snap: () => snap! };
}

const BROADEN = 'Please broaden the backfill review to every active thread.';

describe('LiveSession: thread message queue', () => {
  // Replays 2026-10-23 11:47–11:53 in thr_baxmfjstzm: the voice said "I've asked
  // them", the message sat in the queue for six minutes, and the earlier turn's
  // reply was relayed as if it answered it.
  it('says a message is queued, keeps it out of the running turn, and relays the right reply', async () => {
    const { bb, live, snap } = await startLive();
    const id = live.call('ask_agent', { message: BROADEN });
    await tick(5);
    expect(live.output(id)).toMatchObject({
      status: "queued, not delivered yet: waiting for the agent's current turn to finish",
      queue_position: 1,
      note: expect.stringContaining('has not seen this'),
    });
    expect(snap().queued).toBe(1);
    expect(statusDetail(snap())).toBe('1 message queued for the agent');
    expect(live.notifications.at(-1)).toBe('Live · Agent working · 1 queued');

    // The earlier turn ends: not the reply to the queued message.
    bb.push(
      'thr_kanban',
      { seq: 1, type: 'item/completed', data: { item: { type: 'agentMessage', text: 'Pushed the kanban commit.' } } },
      { seq: 2, type: 'turn/completed', data: { status: 'completed' } },
    );
    await tick();
    const after = live.appends('commentary').at(-1)!;
    expect(after).toContain('finished its earlier work: Pushed the kanban commit.');
    expect(after).toContain('queued message goes to it next');
    expect(after).not.toContain('Its reply');

    // bb dispatches the queued row and runs it.
    bb.setQueue('thr_kanban', []);
    bb.push(
      'thr_kanban',
      { seq: 3, type: 'client/turn/requested', data: { source: 'tell', input: [{ type: 'text', text: BROADEN }] } },
      { seq: 4, type: 'turn/started', data: {} },
      { seq: 5, type: 'item/completed', data: { item: { type: 'agentMessage', text: 'Added 20 cards.' } } },
      { seq: 6, type: 'turn/completed', data: { status: 'completed' } },
    );
    await tick(5);
    expect(live.appends('commentary').at(-1)).toBe('The agent in "Kanban backlog" finished. Its reply:\nAdded 20 cards.');
    expect(snap().queued).toBe(0);
    expect(snap().phase).toBe('listening');
  });

  // Seen against real bb: the row leaves the queue before the earlier turn's
  // turn/completed is read, and the earlier reply was relayed as the answer.
  it('keeps attribution when bb drops the row before the earlier turn completes', async () => {
    const { bb, live } = await startLive();
    live.call('ask_agent', { message: BROADEN });
    await tick(5);
    bb.setQueue('thr_kanban', []);
    await tick(5);
    bb.push(
      'thr_kanban',
      { seq: 1, type: 'item/completed', data: { item: { type: 'agentMessage', text: 'The sleep is running in the background.' } } },
      { seq: 2, type: 'turn/completed', data: { status: 'completed' } },
      { seq: 3, type: 'client/turn/requested', data: { source: 'tell', input: [{ type: 'text', text: BROADEN }] } },
      { seq: 4, type: 'turn/started', data: {} },
      { seq: 5, type: 'item/completed', data: { item: { type: 'agentMessage', text: 'Added 20 cards.' } } },
      { seq: 6, type: 'turn/completed', data: { status: 'completed' } },
    );
    await tick(5);
    const said = live.appends('commentary');
    expect(said.at(-2)).toContain('finished its earlier work: The sleep is running in the background.');
    expect(said.at(-1)).toBe('The agent in "Kanban backlog" finished. Its reply:\nAdded 20 cards.');
  });

  it('forgets a queued message that was deleted instead of sent', async () => {
    const { bb, live } = await startLive();
    live.call('ask_agent', { message: BROADEN });
    await tick(5);
    bb.setQueue('thr_kanban', []); // deleted in bb
    await tick(5);
    bb.push(
      'thr_kanban',
      { seq: 1, type: 'turn/completed', data: { status: 'completed' } },
      { seq: 2, type: 'client/turn/requested', data: { source: 'tell', input: [{ type: 'text', text: 'something else' }] } },
      { seq: 3, type: 'turn/started', data: {} },
      { seq: 4, type: 'item/completed', data: { item: { type: 'agentMessage', text: 'Done.' } } },
      { seq: 5, type: 'turn/completed', data: { status: 'completed' } },
    );
    await tick(5);
    expect(live.appends('commentary').at(-1)).toBe('The agent in "Kanban backlog" finished. Its reply:\nDone.');
  });

  it('follows queue changes made outside the voice (typed in bb, or on another device)', async () => {
    const { bb, live, snap } = await startLive();
    bb.setQueue('thr_kanban', [queuedRow('qmsg_ui', 'also add the WorkOS prep', 'thread-busy')]);
    await tick(5);
    expect(snap().queued).toBe(1);

    const id = live.call('thread_status', {});
    await tick(5);
    expect(live.output(id).queued_messages).toEqual([{ text: 'also add the WorkOS prep', status: "waiting for the agent's current turn to finish" }]);

    bb.setQueue('thr_kanban', []);
    await tick(5);
    expect(snap().queued).toBe(0);
  });

  it('reports what each queued message waits on, and which ones the voice sent', async () => {
    const { bb, live } = await startLive();
    const sent = live.call('ask_agent', { message: BROADEN });
    await tick(5);
    expect(live.output(sent).status).toContain('queued');
    bb.queues.thr_kanban.push(
      queuedRow('qmsg_q', 'answer later', 'interaction'),
      { ...queuedRow('qmsg_t', 'at noon', 'time', 'scheduled'), sendAt: new Date(2026, 9, 23, 12, 0).getTime() },
      { ...queuedRow('qmsg_f', 'broken', null, 'failed_exhausted') },
    );
    const id = live.call('thread_status', {});
    await tick(5);
    expect(live.output(id).queued_messages).toEqual([
      { text: BROADEN, status: "waiting for the agent's current turn to finish", sent_by_voice: true },
      { text: 'answer later', status: "waiting for an answer to the agent's question" },
      { text: 'at noon', status: expect.stringMatching(/^scheduled for /) },
      { text: 'broken', status: 'failed to send; needs a retry in bb' },
    ]);
  });

  // Replays 11:52:02–11:52:16: "Are you able to answer the question that the
  // Kanban thread is having?" got "No question from that agent yet".
  it('answers "is it waiting on me" from the open question, not the thread status alone', async () => {
    const { bb, live } = await startLive();
    bb.push('thr_kanban', lifecycle(1, COLOR_QUESTION));
    await tick();
    const id = live.call('thread_status', {});
    await tick(5);
    expect(live.output(id)).toMatchObject({ status: 'waiting on the user', waiting_on_user: expect.stringContaining('Which color should I use?') });
  });

  it('only reads the queue: never sends, edits, reorders or deletes queued messages', async () => {
    const { bb, live } = await startLive();
    bb.setQueue('thr_kanban', [queuedRow('qmsg_ui', 'typed in bb', 'thread-busy')]);
    live.call('ask_agent', { message: BROADEN });
    live.call('thread_status', {});
    live.call('read_thread', {});
    await tick(10);
    bb.push('thr_kanban', { seq: 1, type: 'turn/completed', data: {} });
    await tick(5);
    expect(bb.calls.map((c) => c.method).filter((m) => !READ_ONLY.has(m))).toEqual([]);
    expect(bb.calls.filter((c) => c.method === 'send')).toHaveLength(1);
    expect(bb.queues.thr_kanban.map((m) => m.id)).toEqual(['qmsg_ui', 'qmsg_1']);
  });
});

describe('ClassicSession: thread message queue', () => {
  it('shows the queue count in the bar', async () => {
    const bb = fakeBb({ thr_kanban: { title: 'Kanban backlog', status: 'active' } });
    const { keepAlive } = fakeKeepAlive();
    const platform = {
      recognizer: { requestPermission: async () => true, listen: () => () => {}, start() {}, abort() {} },
      speaker: { speak: (_t: string, o: { onDone: () => void }) => setTimeout(o.onDone, 0), stop() {} },
      keepAlive,
    };
    const s = new ClassicSession(platform as any, bb.client, 'thr_kanban', { language: 'en-US', rate: 1, debounceMs: 5 }, 'Kanban backlog');
    session = s;
    let snap: VoiceSnapshot | null = null;
    s.subscribe((x) => (snap = x));
    await s.start();
    bb.setQueue('thr_kanban', [queuedRow('qmsg_a', 'next', 'thread-busy'), queuedRow('qmsg_b', 'after', 'thread-busy')]);
    await tick(5);
    expect(snap!.queued).toBe(2);
    expect(statusDetail(snap!)).toBe('2 messages queued for the agent');
  });
});
