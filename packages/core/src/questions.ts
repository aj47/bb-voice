// Questions an agent asks mid-turn: Claude Code's AskUserQuestion, a tool
// approval, or a plugin form. bb holds the agent's turn open as a pending
// interaction until it is answered, and a message sent meanwhile only queues
// behind it, so the voice has to surface the question and resolve it directly.

export type BbInteraction = { id: string; status: string; payload: any };

export type QuestionOption = { value: string; label: string; description?: string };

export type QuestionItem = {
  id: string;
  prompt: string;
  header?: string;
  options: QuestionOption[];
  multiSelect: boolean;
  allowFreeText: boolean;
};

export type AgentQuestion = { interactionId: string; threadId: string } & (
  | { kind: 'question'; questions: QuestionItem[] }
  | { kind: 'approval'; summary: string; decisions: string[]; permissions: unknown }
  // A plugin form (e.g. Codex's async question): shown, but answered in bb.
  | { kind: 'form'; summary: string }
);

// What bb's resolve endpoint takes.
export type QuestionResolution =
  | { kind: 'user_answer'; answers: Record<string, { selected: string[]; freeText?: string }> }
  | { decision: string; grantedPermissions: unknown };

// One spoken answer: option labels and/or the user's own words, for one question (1-based).
export type SpokenAnswer = { question?: number; choices?: string[]; text?: string };

// 'resolving' means an answer is already on its way.
export const isOpenInteraction = (status: string) => status === 'pending';

const str = (v: unknown) => (typeof v === 'string' ? v.trim() : '');

export function agentQuestion(threadId: string, interaction: BbInteraction): AgentQuestion | null {
  const p = interaction?.payload;
  if (!interaction?.id || !p) return null;
  const base = { interactionId: interaction.id, threadId };
  if (p.kind === 'user_question' && Array.isArray(p.questions) && p.questions.length) {
    const questions: QuestionItem[] = p.questions.map((q: any) => ({
      id: String(q.id),
      prompt: str(q.prompt),
      ...(str(q.shortLabel) ? { header: str(q.shortLabel) } : {}),
      options: (Array.isArray(q.options) ? q.options : []).map((o: any) => ({
        value: String(o.value),
        label: str(o.label),
        ...(str(o.description) ? { description: str(o.description) } : {}),
      })),
      multiSelect: Boolean(q.multiSelect),
      allowFreeText: q.allowFreeText !== false,
    }));
    return { ...base, kind: 'question', questions };
  }
  if (p.kind === 'approval') {
    const s = p.subject ?? {};
    const what =
      s.kind === 'command'
        ? `run the command: ${str(s.command)}`
        : s.kind === 'permission_grant'
          ? `use ${str(s.toolName) || 'a tool'} with extra permissions`
          : s.kind === 'plan'
            ? 'go ahead with its plan'
            : `go ahead with ${str(s.toolName) || str(s.kind) || 'an action'}`;
    return {
      ...base,
      kind: 'approval',
      summary: `The agent asks permission to ${what}.${str(p.reason) ? ` Reason: ${clipLine(str(p.reason), 300)}` : ''}`,
      decisions: Array.isArray(p.availableDecisions) ? p.availableDecisions.map(String) : ['allow_once', 'deny'],
      permissions: s.kind === 'permission_grant' ? (s.permissions ?? null) : null,
    };
  }
  const title = str(p.title) || str(p.data?.questions?.[0]?.title);
  return { ...base, kind: 'form', summary: title || 'The agent is waiting on a form in bb.' };
}

const clipLine = (text: string, max: number) => {
  const flat = text.replace(/\s+/g, ' ').trim();
  return flat.length > max ? `${flat.slice(0, max)}…` : flat;
};

// One line for a status bar: the first question, and how many more.
export function questionSummary(q: AgentQuestion): string {
  if (q.kind !== 'question') return clipLine(q.summary, 200);
  const [first, ...rest] = q.questions;
  return clipLine(first.prompt, 200) + (rest.length ? ` (+${rest.length} more)` : '');
}

// The full question as the voice should read it, options included.
export function describeQuestion(q: AgentQuestion): string {
  if (q.kind === 'approval') return `${q.summary} Answer yes or no.`;
  if (q.kind === 'form') return `${q.summary} This one has to be answered in the bb app.`;
  return q.questions
    .map((item, i) => {
      const lines = [`${q.questions.length > 1 ? `Question ${i + 1}: ` : ''}${item.prompt}`];
      item.options.forEach((o, j) => lines.push(`  ${j + 1}. ${o.label}${o.description ? ` — ${o.description}` : ''}`));
      if (item.multiSelect) lines.push('  (more than one option may be chosen)');
      if (item.allowFreeText && item.options.length) lines.push('  (or the user can answer in their own words)');
      return lines.join('\n');
    })
    .join('\n');
}

const norm = (s: string) => s.toLowerCase().replace(/\(recommended\)/g, '').replace(/[^a-z0-9]+/g, ' ').trim();
const ORDINAL: Record<string, number> = {
  first: 1, one: 1, '1': 1, second: 2, two: 2, '2': 2, third: 3, three: 3, '3': 3,
  fourth: 4, four: 4, '4': 4, fifth: 5, five: 5, '5': 5, last: -1,
};
const FILLER = new Set(['the', 'option', 'one', 'choice', 'number', 'pick', 'go', 'with', 'i', 'choose', 'a', 'let', 's', 'lets', 'please']);

// Matches a spoken choice to an option: its label, value, number or ordinal
// ("the second one", "option 2"), or a label containing every spoken word.
export function matchOption(options: QuestionOption[], spoken: string): QuestionOption | null {
  const want = norm(spoken);
  if (!want) return null;
  const exact = options.find((o) => norm(o.label) === want || o.value === spoken.trim());
  if (exact) return exact;
  const words = want.split(' ').filter((w) => !FILLER.has(w));
  const ordinal = words.length === 0 && want.split(' ').includes('one') ? 1 : words.length === 1 ? ORDINAL[words[0]] : undefined;
  if (ordinal !== undefined) return options[ordinal === -1 ? options.length - 1 : ordinal - 1] ?? null;
  const contains = options.filter((o) => {
    const label = ` ${norm(o.label)} `;
    return words.length > 0 && words.every((w) => label.includes(` ${w} `));
  });
  if (contains.length === 1) return contains[0];
  const inside = options.filter((o) => norm(o.label) && ` ${want} `.includes(` ${norm(o.label)} `));
  return inside.length === 1 ? inside[0] : null;
}

// Builds bb's resolution from what the user said. A single string answers the
// only (or first) question: an option if it matches one, else free text.
export function buildAnswer(q: AgentQuestion, answer: SpokenAnswer[] | string): { resolution: QuestionResolution } | { error: string } {
  if (q.kind === 'form') return { error: 'This question is a form that has to be answered in the bb app.' };
  if (q.kind === 'approval') {
    const said = norm(typeof answer === 'string' ? answer : (answer[0]?.choices?.[0] ?? answer[0]?.text ?? ''));
    const no = /\b(no|deny|don t|do not|stop|reject|decline|cancel|nope)\b/.test(said);
    const session = /\b(session|always|from now on|every time)\b/.test(said);
    const yes = /\b(yes|allow|approve|ok|okay|sure|go ahead|do it|yep|yeah|accept|grant)\b/.test(said);
    if (no === yes) return { error: 'Say whether to allow it (yes) or deny it (no).' };
    const pick = no ? 'deny' : session && q.decisions.includes('allow_for_session') ? 'allow_for_session' : q.decisions.find((d) => d.startsWith('allow'));
    if (!pick || !q.decisions.includes(pick)) return { error: `This approval only offers: ${q.decisions.join(', ')}` };
    return { resolution: { decision: pick, grantedPermissions: pick === 'deny' ? null : q.permissions } };
  }
  const list: SpokenAnswer[] = typeof answer === 'string' ? [{ choices: [answer] }] : answer;
  const answers: Record<string, { selected: string[]; freeText?: string }> = {};
  for (const [i, a] of list.entries()) {
    const index = (a.question ?? i + 1) - 1;
    const item = q.questions[index];
    if (!item) return { error: `There is no question ${index + 1}; the agent asked ${q.questions.length}.` };
    const entry = answers[item.id] ?? { selected: [] };
    const unmatched: string[] = [];
    for (const choice of (a.choices ?? []).map(str).filter(Boolean)) {
      const hit = matchOption(item.options, choice);
      if (hit && !entry.selected.includes(hit.value)) entry.selected.push(hit.value);
      else if (!hit) unmatched.push(choice);
    }
    const text = [str(a.text), ...unmatched].filter(Boolean).join('. ');
    if (text) {
      if (!item.allowFreeText) {
        return { error: `"${text}" is not one of the options for "${item.prompt}": ${item.options.map((o) => o.label).join(', ')}` };
      }
      entry.freeText = text;
    }
    if (!item.multiSelect && entry.selected.length > 1) return { error: `"${item.prompt}" takes only one option.` };
    answers[item.id] = entry;
  }
  const missing = q.questions.filter((item) => !answers[item.id] || (answers[item.id].selected.length === 0 && !answers[item.id].freeText));
  if (missing.length) return { error: `Still need an answer to: ${missing.map((m) => `"${m.prompt}"`).join(', ')}` };
  return { resolution: { kind: 'user_answer', answers } };
}
