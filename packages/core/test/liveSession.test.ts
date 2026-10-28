import { afterEach, describe, expect, it, vi } from 'vitest';
import { LiveSession, type VoiceSnapshot } from '../src';
import { COLOR_QUESTION, COMMAND_APPROVAL, lifecycle } from './fixtures';
import { fakeBb, fakeLivePlatform, tick } from './fakes';

vi.spyOn(console, 'log').mockImplementation(() => {});

const SETTINGS = { model: 'gpt-live-1', voice: 'marin', delegateModel: 'gpt-6-luna' };
let session: LiveSession | null = null;
afterEach(() => session?.stop());

async function startLive(opts: { pendingAtStart?: boolean } = {}) {
  const bb = fakeBb({ thr_cur: { title: 'Kanban commit' }, thr_other: { title: 'Release notes' } });
  if (opts.pendingAtStart) bb.pending.thr_cur = [COLOR_QUESTION];
  const live = fakeLivePlatform();
  session = new LiveSession(live.platform as any, bb.client, 'thr_cur', 'Kanban commit', SETTINGS);
  let snap: VoiceSnapshot | null = null;
  session.subscribe((s) => (snap = s));
  await session.start();
  live.emit({ type: 'session.started' });
  return { bb, live, snap: () => snap! };
}

describe('LiveSession: agent questions', () => {
  it('reads a question asked mid-turn and shows it as asking', async () => {
    const { bb, live, snap } = await startLive();
    bb.push('thr_cur', { seq: 1, type: 'turn/started', data: {} });
    await tick();
    expect(snap().phase).toBe('thinking');

    bb.push('thr_cur', lifecycle(2, COLOR_QUESTION));
    await tick();
    const said = live.appends('commentary');
    expect(said).toHaveLength(1);
    expect(said[0]).toContain('Which color should I use?');
    expect(said[0]).toContain('1. Red (Recommended)');
    expect(said[0]).toContain('2. Blue');
    expect(snap().phase).toBe('asking');
    expect(snap().question).toBe('Which color should I use?');
    expect(snap().log.some((l) => l.role === 'agent' && l.text.startsWith('Question:'))).toBe(true);
    // The Android foreground notification carries the question for a locked screen.
    expect(live.notifications.at(-1)).toBe('Live · Agent has a question: Which color should I use?');
  });

  it('does not repeat a question on resync', async () => {
    const { bb, live } = await startLive();
    bb.push('thr_cur', lifecycle(1, COLOR_QUESTION));
    await tick();
    bb.push('thr_cur', { seq: 2, type: 'thread/contextWindowUsage/updated', data: {} });
    bb.push('thr_cur', lifecycle(3, COLOR_QUESTION));
    await tick();
    expect(live.appends('commentary')).toHaveLength(1);
  });

  it('picks up a question that was already open when the session started', async () => {
    const { live, snap } = await startLive({ pendingAtStart: true });
    expect(live.config().instructions).toContain('waiting on the user\'s answer');
    expect(live.config().delegation.responses.instructions).toContain('Which color should I use?');
    expect(live.appends('commentary')[0]).toContain('Which color should I use?');
    await tick();
    expect(snap().phase).toBe('asking');
  });

  it('answers through bb\'s resolve endpoint, not as a queued message', async () => {
    const { bb, live, snap } = await startLive();
    bb.push('thr_cur', lifecycle(1, COLOR_QUESTION));
    await tick();

    const askId = live.call('ask_agent', { message: 'blue' });
    await tick(5);
    expect(live.output(askId).error).toContain('answer_question');
    expect(bb.calls.find((c) => c.method === 'send')).toBeUndefined();

    const answerId = live.call('answer_question', { answer: 'the blue one' });
    await tick(5);
    expect(bb.calls.filter((c) => c.method === 'resolveInteraction')).toEqual([
      {
        method: 'resolveInteraction',
        args: ['thr_cur', 'pint_color', { kind: 'user_answer', answers: { 'toolu_1:question-1': { selected: ['toolu_1:question-1:option-2'] } } }],
      },
    ]);
    expect(live.output(answerId)).toMatchObject({ answered: 'Which color should I use?' });
    expect(snap().phase).toBe('thinking');
    expect(snap().question).toBeNull();

    // The agent continues and its reply is relayed as usual.
    bb.push(
      'thr_cur',
      lifecycle(2, COLOR_QUESTION, 'resolving'),
      lifecycle(3, COLOR_QUESTION, 'resolved'),
      { seq: 4, type: 'item/completed', data: { item: { type: 'agentMessage', text: 'Blue' } } },
      { seq: 5, type: 'turn/completed', data: { status: 'completed' } },
    );
    await tick();
    expect(live.appends('commentary').at(-1)).toContain('Its reply:\nBlue');
    expect(snap().phase).toBe('listening');
  });

  it('returns the question again when the answer fits no option and free text is off', async () => {
    const { bb, live } = await startLive();
    const strict = { ...COLOR_QUESTION, payload: { ...COLOR_QUESTION.payload, questions: [{ ...COLOR_QUESTION.payload.questions[0], allowFreeText: false }] } };
    bb.push('thr_cur', lifecycle(1, strict));
    await tick();
    const id = live.call('answer_question', { answer: 'green' });
    await tick(5);
    expect(live.output(id)).toMatchObject({ error: expect.stringContaining('not one of the options'), question: expect.stringContaining('Which color') });
    expect(bb.calls.find((c) => c.method === 'resolveInteraction')).toBeUndefined();
  });

  it('clears the question when it is answered in bb instead', async () => {
    const { bb, live, snap } = await startLive();
    bb.push('thr_cur', { seq: 1, type: 'turn/started', data: {} }, lifecycle(2, COLOR_QUESTION));
    await tick();
    expect(snap().phase).toBe('asking');
    bb.push('thr_cur', lifecycle(3, COLOR_QUESTION, 'resolved'));
    await tick();
    expect(snap().phase).toBe('thinking');
    expect(snap().question).toBeNull();
    expect(live.appends('thinking').at(-1)).toContain('was answered in bb');
  });

  it('surfaces a question from another thread it is waiting on, and answers there', async () => {
    const { bb, live, snap } = await startLive();
    const askId = live.call('ask_agent', { message: 'Draft the notes', thread_id: 'thr_other' });
    await tick(5);
    expect(live.output(askId).status).toContain('sent');
    bb.push('thr_other', lifecycle(1, COMMAND_APPROVAL));
    await tick();
    expect(snap().question).toBe('"Release notes": The agent asks permission to run the command: df -h /. Reason: Needs review.');
    expect(live.appends('commentary').at(-1)).toContain('Answer yes or no');

    const statusId = live.call('thread_status', { thread_id: 'thr_other' });
    await tick(5);
    expect(live.output(statusId)).toMatchObject({ status: 'waiting on the user', waiting_on_user: expect.stringContaining('df -h') });

    const answerId = live.call('answer_question', { answer: 'yes' });
    await tick(5);
    expect(live.output(answerId)).toMatchObject({ thread: 'Release notes' });
    expect(bb.calls.find((c) => c.method === 'resolveInteraction')?.args).toEqual(['thr_other', 'pint_cmd', { decision: 'allow_once', grantedPermissions: null }]);
  });

  it('ignores questions in threads it is not following', async () => {
    const { bb, live, snap } = await startLive();
    live.call('thread_status', { thread_id: 'thr_other' }); // tracked, but not awaiting a reply
    await tick(5);
    bb.push('thr_other', lifecycle(1, COLOR_QUESTION));
    await tick();
    expect(live.appends('commentary')).toHaveLength(0);
    expect(snap().phase).toBe('listening');
  });
});
