import { describe, expect, it } from 'vitest';
import { agentQuestion, buildAnswer, describeQuestion, matchOption, questionSummary, statusDetail } from '../src';
import { COLOR_QUESTION, COMMAND_APPROVAL, PERMISSION_APPROVAL, PLUGIN_FORM, TWO_QUESTIONS } from './fixtures';

const color = agentQuestion('thr_a', COLOR_QUESTION)!;
const two = agentQuestion('thr_a', TWO_QUESTIONS)!;

describe('agentQuestion', () => {
  it('reads a Claude AskUserQuestion interaction', () => {
    expect(color).toMatchObject({ kind: 'question', interactionId: 'pint_color', threadId: 'thr_a' });
    if (color.kind !== 'question') throw new Error('kind');
    expect(color.questions[0]).toMatchObject({ prompt: 'Which color should I use?', header: 'Color', multiSelect: false, allowFreeText: true });
    expect(color.questions[0].options.map((o) => o.label)).toEqual(['Red (Recommended)', 'Blue']);
  });

  it('reads approvals and plugin forms', () => {
    expect(agentQuestion('thr_a', COMMAND_APPROVAL)).toMatchObject({ kind: 'approval', decisions: ['allow_once', 'deny'] });
    expect(questionSummary(agentQuestion('thr_a', COMMAND_APPROVAL)!)).toContain('run the command: df -h /');
    expect(agentQuestion('thr_a', PLUGIN_FORM)).toMatchObject({ kind: 'form', summary: 'Click Allow on the prompt, then reply.' });
  });

  it('ignores rows without an id or payload', () => {
    expect(agentQuestion('thr_a', { id: '', status: 'pending', payload: {} })).toBeNull();
    expect(agentQuestion('thr_a', { id: 'x', status: 'pending', payload: null })).toBeNull();
  });
});

describe('describeQuestion / questionSummary', () => {
  it('reads the prompt with numbered options', () => {
    const text = describeQuestion(color);
    expect(text).toContain('Which color should I use?');
    expect(text).toContain('1. Red (Recommended) — Warm');
    expect(text).toContain('2. Blue — Cool');
    expect(text).toContain('own words');
  });

  it('numbers several questions and counts them in the summary', () => {
    expect(describeQuestion(two)).toMatch(/Question 1: Which branch\?[\s\S]*Question 2: Which checks\?/);
    expect(questionSummary(two)).toBe('Which branch? (+1 more)');
  });
});

describe('matchOption', () => {
  if (color.kind !== 'question') throw new Error('kind');
  const options = color.questions[0].options;
  it.each([
    ['blue', 'Blue'],
    ['Blue.', 'Blue'],
    ['the blue one', 'Blue'],
    ['red', 'Red (Recommended)'],
    ['option 2', 'Blue'],
    ['the second one', 'Blue'],
    ['first', 'Red (Recommended)'],
    ['last', 'Blue'],
    ['let\'s go with blue please', 'Blue'],
  ])('%s → %s', (spoken, label) => {
    expect(matchOption(options, spoken)?.label).toBe(label);
  });

  it('returns null for words that fit no option', () => {
    expect(matchOption(options, 'green')).toBeNull();
    expect(matchOption(options, '')).toBeNull();
  });
});

describe('buildAnswer', () => {
  it('turns a spoken label into the option value', () => {
    expect(buildAnswer(color, 'Blue')).toEqual({
      resolution: { kind: 'user_answer', answers: { 'toolu_1:question-1': { selected: ['toolu_1:question-1:option-2'] } } },
    });
  });

  it('sends anything else as free text when the question allows it', () => {
    expect(buildAnswer(color, 'green, but darker')).toEqual({
      resolution: { kind: 'user_answer', answers: { 'toolu_1:question-1': { selected: [], freeText: 'green, but darker' } } },
    });
  });

  it('answers several questions, with multi-select and free text', () => {
    const r = buildAnswer(two, [
      { question: 1, choices: ['main'] },
      { question: 2, choices: ['typecheck', 'unit tests'], text: 'skip e2e' },
    ]);
    expect(r).toEqual({
      resolution: {
        kind: 'user_answer',
        answers: { q1: { selected: ['q1:o1'] }, q2: { selected: ['q2:o1', 'q2:o2'], freeText: 'skip e2e' } },
      },
    });
  });

  it('explains what is wrong instead of sending a bad answer', () => {
    expect(buildAnswer(two, [{ question: 1, choices: ['somewhere else'] }])).toEqual({ error: expect.stringContaining('not one of the options') });
    expect(buildAnswer(two, [{ question: 1, choices: ['main'] }])).toEqual({ error: expect.stringContaining('Which checks?') });
    expect(buildAnswer(color, '')).toEqual({ error: expect.stringContaining('Which color') });
    expect(buildAnswer(color, [{ question: 3, text: 'x' }])).toEqual({ error: expect.stringContaining('no question 3') });
  });

  it('maps yes / no / for the session onto an approval', () => {
    const cmd = agentQuestion('thr_a', COMMAND_APPROVAL)!;
    const perm = agentQuestion('thr_a', PERMISSION_APPROVAL)!;
    expect(buildAnswer(cmd, 'yes go ahead')).toEqual({ resolution: { decision: 'allow_once', grantedPermissions: null } });
    expect(buildAnswer(cmd, "no, don't")).toEqual({ resolution: { decision: 'deny', grantedPermissions: null } });
    expect(buildAnswer(cmd, 'maybe')).toEqual({ error: expect.any(String) });
    expect(buildAnswer(perm, 'yes, for the session')).toEqual({
      resolution: { decision: 'allow_for_session', grantedPermissions: { network: { enabled: true }, fileSystem: null } },
    });
  });

  it('refuses plugin forms, which are answered in bb', () => {
    expect(buildAnswer(agentQuestion('thr_a', PLUGIN_FORM)!, 'Allowed')).toEqual({ error: expect.stringContaining('bb app') });
  });
});

describe('statusDetail (desktop banner and phone bar)', () => {
  const base = { phase: 'asking' as const, partial: '', error: null, question: 'Which color should I use?', queued: 0 };
  it('shows the open question', () => expect(statusDetail(base)).toBe('Agent asks: Which color should I use?'));
  it('shows the user\'s words while they answer', () => expect(statusDetail({ ...base, phase: 'hearing', partial: 'blue' })).toBe('blue'));
  it('puts errors first', () => expect(statusDetail({ ...base, error: 'Voice connection dropped' })).toBe('Voice connection dropped'));
  it('shows queued messages when nothing is asked', () => expect(statusDetail({ ...base, phase: 'thinking', question: null, queued: 1 })).toBe('1 message queued for the agent'));
  it('keeps the question ahead of the queue', () => expect(statusDetail({ ...base, queued: 2 })).toBe('Agent asks: Which color should I use?'));
  it('falls back to the partial', () => expect(statusDetail({ ...base, question: null, phase: 'thinking', partial: 'Connecting…' })).toBe('Connecting…'));
});
