import { afterEach, describe, expect, it, vi } from 'vitest';
import { ClassicSession, type VoiceSnapshot } from '../src';
import { COLOR_QUESTION, lifecycle } from './fixtures';
import { fakeBb, fakeKeepAlive, tick } from './fakes';

vi.spyOn(console, 'log').mockImplementation(() => {});

let session: ClassicSession | null = null;
afterEach(() => session?.stop());

async function startClassic(pendingAtStart = false) {
  const bb = fakeBb({ thr_cur: { title: 'Kanban commit', status: 'active' } });
  if (pendingAtStart) bb.pending.thr_cur = [COLOR_QUESTION];
  const spoken: string[] = [];
  let handlers: any = null;
  const { lines, keepAlive } = fakeKeepAlive();
  const platform = {
    recognizer: { requestPermission: async () => true, listen: (h: any) => ((handlers = h), () => {}), start() {}, abort() {} },
    // Finishes each utterance at once so the loop goes back to listening.
    speaker: { speak: (text: string, o: { onDone: () => void }) => (spoken.push(text), setTimeout(o.onDone, 0)), stop() {} },
    keepAlive,
  };
  session = new ClassicSession(platform as any, bb.client, 'thr_cur', { language: 'en-US', rate: 1, debounceMs: 5 }, 'Kanban commit');
  let snap: VoiceSnapshot | null = null;
  session.subscribe((s) => (snap = s));
  await session.start();
  const say = async (text: string) => {
    handlers.result(text, true);
    await tick(20);
  };
  return { bb, spoken, notifications: lines, say, snap: () => snap! };
}

describe('ClassicSession: agent questions', () => {
  it('speaks the question with its options and shows it', async () => {
    const { bb, spoken, notifications, snap } = await startClassic();
    bb.push('thr_cur', lifecycle(1, COLOR_QUESTION));
    await tick(5);
    expect(spoken).toEqual(['Which color should I use?', '1. Red, recommended.', '2. Blue.']);
    expect(snap().phase).toBe('asking');
    expect(snap().question).toBe('Which color should I use?');
    expect(notifications.at(-1)).toBe('Agent has a question: Which color should I use?');
  });

  it('sends the next utterance as the answer instead of a queued message', async () => {
    const { bb, say, snap } = await startClassic(true);
    expect(snap().question).toBe('Which color should I use?');
    await say('blue');
    expect(bb.calls.map((c) => c.method)).toEqual(['resolveInteraction']);
    expect(bb.calls[0].args).toEqual(['thr_cur', 'pint_color', { kind: 'user_answer', answers: { 'toolu_1:question-1': { selected: ['toolu_1:question-1:option-2'] } } }]);
    expect(snap().phase).toBe('thinking');
    expect(snap().question).toBeNull();

    // After the question, speech goes to the agent as usual.
    bb.push('thr_cur', lifecycle(2, COLOR_QUESTION, 'resolved'), { seq: 3, type: 'turn/completed', data: {} });
    await tick(5);
    await say('thanks, now commit it');
    expect(bb.calls.at(-1)).toEqual({ method: 'send', args: ['thr_cur', 'thanks, now commit it'] });
  });
});
