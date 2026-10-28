// Interaction payloads as bb stores them (from real Claude Code threads).

export const COLOR_QUESTION = {
  id: 'pint_color',
  status: 'pending',
  payload: {
    kind: 'user_question',
    questions: [
      {
        id: 'toolu_1:question-1',
        prompt: 'Which color should I use?',
        shortLabel: 'Color',
        multiSelect: false,
        options: [
          { value: 'toolu_1:question-1:option-1', label: 'Red (Recommended)', description: 'Warm' },
          { value: 'toolu_1:question-1:option-2', label: 'Blue', description: 'Cool' },
        ],
        allowFreeText: true,
      },
    ],
  },
};

export const TWO_QUESTIONS = {
  id: 'pint_two',
  status: 'pending',
  payload: {
    kind: 'user_question',
    questions: [
      {
        id: 'q1',
        prompt: 'Which branch?',
        multiSelect: false,
        options: [
          { value: 'q1:o1', label: 'main via worktree' },
          { value: 'q1:o2', label: 'New kanban branch' },
        ],
        allowFreeText: false,
      },
      {
        id: 'q2',
        prompt: 'Which checks?',
        multiSelect: true,
        options: [
          { value: 'q2:o1', label: 'Typecheck' },
          { value: 'q2:o2', label: 'Unit tests' },
          { value: 'q2:o3', label: 'Lint' },
        ],
        allowFreeText: true,
      },
    ],
  },
};

export const COMMAND_APPROVAL = {
  id: 'pint_cmd',
  status: 'pending',
  payload: {
    kind: 'approval',
    subject: { kind: 'command', itemId: 'i1', command: 'df -h /', cwd: null },
    reason: 'Needs review.',
    availableDecisions: ['allow_once', 'deny'],
  },
};

export const PERMISSION_APPROVAL = {
  id: 'pint_perm',
  status: 'pending',
  payload: {
    kind: 'approval',
    subject: { kind: 'permission_grant', itemId: 'i2', toolName: 'mcp__chrome__computer', permissions: { network: { enabled: true }, fileSystem: null } },
    availableDecisions: ['allow_once', 'allow_for_session', 'deny'],
  },
};

export const PLUGIN_FORM = {
  id: 'pint_form',
  status: 'pending',
  payload: { kind: 'plugin', title: 'Click Allow on the prompt, then reply.', data: { questions: [{ title: 'Click Allow', options: ['Allowed'] }] } },
};

export const lifecycle = (seq: number, interaction: { id: string; payload: unknown }, status = 'pending') => ({
  seq,
  type: 'system/interaction/lifecycle',
  data: { interaction: { ...interaction, status } },
});
