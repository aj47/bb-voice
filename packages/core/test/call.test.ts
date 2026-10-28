// The call itself: work that must not wait on timers (a locked Android phone
// can hold JS timers for minutes), hanging up, and threads started alongside.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { isHangUp, LiveSession, type VoiceSnapshot } from '../src';
import { fakeBb, fakeLivePlatform, tick } from './fakes';

vi.spyOn(console, 'log').mockImplementation(() => {});

const SETTINGS = { model: 'gpt-live-1', voice: 'marin', delegateModel: 'gpt-6-luna' };
let session: LiveSession | null = null;
afterEach(() => {
  session?.stop();
  vi.useRealTimers();
});

async function startLive() {
  const bb = fakeBb({ thr_cur: { title: 'Plan the day' } });
  const live = fakeLivePlatform();
  session = new LiveSession(live.platform as any, bb.client, 'thr_cur', 'Plan the day', SETTINGS);
  let snap: VoiceSnapshot | null = null;
  session.subscribe((s) => (snap = s));
  await session.start();
  live.emit({ type: 'session.started' });
  return { bb, live, snap: () => snap! };
}

// Settles promise chains without letting any timer fire.
const settle = async () => {
  for (let i = 0; i < 50; i++) await Promise.resolve();
};

const said = (snap: VoiceSnapshot, role: 'you' | 'assistant') => snap.log.filter((l) => l.role === role).map((l) => l.text);

describe('LiveSession with timers held (locked phone)', () => {
  it('runs a tool call as soon as the delegate is done', async () => {
    const { live } = await startLive();
    vi.useFakeTimers({ toFake: ['setTimeout', 'setInterval', 'clearTimeout', 'clearInterval'] });
    const id = live.call('thread_status', {});
    await settle();
    expect(live.output(id)).toMatchObject({ thread: 'Plan the day' });
    expect(live.sent.at(-1)).toMatchObject({ type: 'response.create' });
  });

  it('closes a spoken line when the next event shows it ended', async () => {
    const { live, snap } = await startLive();
    vi.useFakeTimers({ toFake: ['setTimeout', 'setInterval', 'clearTimeout', 'clearInterval', 'Date'] });
    live.emit({ type: 'session.output_transcript.delta', delta: 'Checking it now.' });
    vi.setSystemTime(Date.now() + 60_000);
    live.emit({ type: 'session.input_transcript.delta', delta: 'Hello' });
    vi.setSystemTime(Date.now() + 5_000);
    live.emit({ type: 'session.output_transcript.delta', delta: 'Hi, I am here.' });
    vi.setSystemTime(Date.now() + 5_000);
    live.emit({ type: 'session.usage.updated' });
    expect(said(snap(), 'assistant')).toEqual(['Checking it now.', 'Hi, I am here.']);
    expect(said(snap(), 'you')).toEqual(['Hello']);
  });
});

describe('LiveSession: hanging up', () => {
  it('end_call ends the session after a short goodbye', async () => {
    const { live, snap } = await startLive();
    const id = live.call('end_call', {});
    await tick(5);
    expect(live.output(id)).toMatchObject({ ending: true });
    expect(snap().phase).not.toBe('off');
    await tick(2100);
    expect(snap().phase).toBe('off');
    expect(live.sent.some((e) => e.type === 'session.close')).toBe(true);
  });

  it('a spoken "hang up" ends the call even if the voice only says okay', async () => {
    const { live, snap } = await startLive();
    vi.useFakeTimers({ toFake: ['setTimeout', 'setInterval', 'clearTimeout', 'clearInterval', 'Date'] });
    live.emit({ type: 'session.input_transcript.delta', delta: 'All right, hang up' });
    live.emit({ type: 'session.output_transcript.delta', delta: 'Okay.' });
    expect(snap().phase).not.toBe('off');
    // Timers held: the next event after the goodbye window still ends it.
    vi.setSystemTime(Date.now() + 2500);
    live.emit({ type: 'session.usage.updated' });
    expect(snap().phase).toBe('off');
  });

  it('a dropped connection goes to error without passing through off', async () => {
    const { live } = await startLive();
    const phases: string[] = [];
    session!.subscribe((s) => phases.push(s.phase));
    live.emit({ type: 'session.closed', reason: 'network' });
    expect(phases.slice(1)).not.toContain('off');
    expect(phases.at(-1)).toBe('error');
  });

  it('tells hang-up requests from mentions', () => {
    for (const s of ['All right, hang up', 'hang up', 'Okay, end the call.', 'please hang up now', 'Yeah, stop the call']) expect(isHangUp(s)).toBe(true);
    for (const s of ['Did you hang up', 'Don\'t hang up', 'Ask it why the call ended', 'stop']) expect(isHangUp(s)).toBe(false);
  });
});

describe('LiveSession: threads alongside', () => {
  it('new_thread with switch false keeps the current thread and relays the new reply', async () => {
    const { bb, live } = await startLive();
    const id = live.call('new_thread', { message: 'Review the backlog', switch: false });
    await tick(5);
    const out = live.output(id);
    expect(out).toMatchObject({ created: 'Review the backlog', current_thread: 'Plan the day' });
    expect(bb.calls.find((c) => c.method === 'createThread')?.args).toEqual(['proj_1', 'Review the backlog']);

    // Still on the old thread: ask_agent without a thread goes there.
    const askId = live.call('ask_agent', { message: 'Next step?' });
    await tick(5);
    expect(live.output(askId)).toMatchObject({ thread: 'Plan the day' });

    bb.push(
      out.id,
      { seq: 1, type: 'item/completed', data: { item: { type: 'agentMessage', text: 'Backlog reviewed' } } },
      { seq: 2, type: 'turn/completed', data: { status: 'completed' } },
    );
    await tick();
    expect(live.appends('commentary').at(-1)).toContain('Backlog reviewed');
  });

  it('new_thread switches by default', async () => {
    const { live } = await startLive();
    live.call('new_thread', { message: 'Write the intro' });
    await tick(5);
    const askId = live.call('ask_agent', { message: 'Shorter' });
    await tick(5);
    expect(live.output(askId)).toMatchObject({ thread: 'Write the intro' });
  });
});
