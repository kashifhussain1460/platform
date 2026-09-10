import { evaluateEmployeeReadiness, type EmployeeReadinessInput } from './employee-readiness';

function input(over: Partial<EmployeeReadinessInput> = {}): EmployeeReadinessInput {
  return {
    employeeId: 'emp-1',
    name: 'Emma',
    status: 'ACTIVE',
    archivedAt: null,
    assignedSkillKeys: ['gmail'],
    skillRequirements: [
      {
        skillKey: 'gmail',
        displayName: 'Gmail',
        required: true,
        requiresConnection: true,
        status: 'READY',
        tools: [],
      } as never,
    ],
    workflowCount: 1,
    activeWorkflowCount: 1,
    knowledgeDocumentCount: 3,
    knowledgeAccessEnabled: true,
    ...over,
  };
}

describe('evaluateEmployeeReadiness', () => {
  it('is READY when every dependency is in place', () => {
    const result = evaluateEmployeeReadiness(input());
    expect(result.ready).toBe(true);
    expect(result.setupState).toBe('READY');
    expect(result.issues).toEqual([]);
    expect(result.checks.every((c) => c.status === 'PASS')).toBe(true);
  });

  it('BLOCKED for a paused employee, with a BLOCKER issue naming it', () => {
    const result = evaluateEmployeeReadiness(input({ status: 'PAUSED' }));
    expect(result.setupState).toBe('BLOCKED');
    expect(result.ready).toBe(false);
    expect(result.issues).toContainEqual(
      expect.objectContaining({ code: 'EMPLOYEE_PAUSED', severity: 'BLOCKER' }),
    );
  });

  it('BLOCKED for a disabled employee', () => {
    const result = evaluateEmployeeReadiness(input({ status: 'DISABLED' }));
    expect(result.setupState).toBe('BLOCKED');
    expect(result.issues).toContainEqual(
      expect.objectContaining({ code: 'EMPLOYEE_DISABLED' }),
    );
  });

  it('BLOCKED for an archived employee, reported ahead of status', () => {
    // archivedAt wins over status, same convention as employee-lifecycle.ts:
    // remove() sets both DISABLED and archivedAt, so this is the normal shape.
    const result = evaluateEmployeeReadiness(
      input({ status: 'DISABLED', archivedAt: new Date() }),
    );
    expect(result.issues).toContainEqual(
      expect.objectContaining({ code: 'EMPLOYEE_ARCHIVED' }),
    );
    expect(result.issues.some((i) => i.code === 'EMPLOYEE_DISABLED')).toBe(false);
  });

  it('NEEDS_SETUP (WARNING) for a zero-skill employee — not a blocker', () => {
    const result = evaluateEmployeeReadiness(
      input({ assignedSkillKeys: [], skillRequirements: [] }),
    );
    expect(result.setupState).toBe('NEEDS_SETUP');
    // A missing skill alone does not fail `ready` — it is advisory.
    expect(result.ready).toBe(true);
    expect(result.issues).toContainEqual(
      expect.objectContaining({ code: 'NO_SKILLS_ASSIGNED', severity: 'WARNING' }),
    );
    expect(result.checks.find((c) => c.key === 'SKILLS')?.status).toBe('WARN');
  });

  it('a disconnected required skill is a BLOCKER and names the skill', () => {
    const result = evaluateEmployeeReadiness(
      input({
        skillRequirements: [
          {
            skillKey: 'gmail',
            displayName: 'Gmail',
            required: true,
            requiresConnection: true,
            status: 'NOT_CONNECTED',
            tools: [],
          } as never,
        ],
      }),
    );
    expect(result.ready).toBe(false);
    expect(result.setupState).toBe('NEEDS_SETUP');
    expect(result.summary.unreadySkillKeys).toEqual(['gmail']);
    expect(result.issues).toContainEqual(
      expect.objectContaining({
        code: 'SKILL_NOT_CONNECTED',
        severity: 'BLOCKER',
        skillKey: 'gmail',
      }),
    );
    expect(result.checks.find((c) => c.key === 'CONNECTIONS')?.status).toBe('FAIL');
  });

  it('ignores a skill requirement for a skill this employee is not assigned', () => {
    // A company-wide InstalledSkill can be disconnected without touching an
    // employee that never uses it — this must not leak in as a false blocker.
    const result = evaluateEmployeeReadiness(
      input({
        assignedSkillKeys: ['gmail'],
        skillRequirements: [
          {
            skillKey: 'gmail',
            displayName: 'Gmail',
            required: true,
            requiresConnection: true,
            status: 'READY',
            tools: [],
          } as never,
          {
            skillKey: 'slack',
            displayName: 'Slack',
            required: true,
            requiresConnection: true,
            status: 'NOT_CONNECTED',
            tools: [],
          } as never,
        ],
      }),
    );
    expect(result.ready).toBe(true);
    expect(result.summary.unreadySkillKeys).toEqual([]);
  });

  it('a skill with no connection requirement is never reported as unready', () => {
    const result = evaluateEmployeeReadiness(
      input({
        assignedSkillKeys: ['http'],
        skillRequirements: [
          {
            skillKey: 'http',
            displayName: 'HTTP',
            required: true,
            requiresConnection: false,
            status: 'NOT_CONNECTED',
            tools: [],
          } as never,
        ],
      }),
    );
    expect(result.ready).toBe(true);
    expect(result.summary.unreadySkillKeys).toEqual([]);
  });

  it('NO_KNOWLEDGE is only raised when knowledge access is actually on', () => {
    const withAccessOff = evaluateEmployeeReadiness(
      input({ knowledgeAccessEnabled: false, knowledgeDocumentCount: 0 }),
    );
    expect(withAccessOff.issues.some((i) => i.code === 'NO_KNOWLEDGE')).toBe(false);

    const withAccessOn = evaluateEmployeeReadiness(
      input({ knowledgeAccessEnabled: true, knowledgeDocumentCount: 0 }),
    );
    expect(withAccessOn.issues).toContainEqual(
      expect.objectContaining({ code: 'NO_KNOWLEDGE', severity: 'WARNING' }),
    );
  });

  it('distinguishes zero workflows from workflows that are all inactive', () => {
    const none = evaluateEmployeeReadiness(
      input({ workflowCount: 0, activeWorkflowCount: 0 }),
    );
    expect(none.issues).toContainEqual(
      expect.objectContaining({ code: 'NO_WORKFLOWS' }),
    );

    const allPaused = evaluateEmployeeReadiness(
      input({ workflowCount: 2, activeWorkflowCount: 0 }),
    );
    expect(allPaused.issues).toContainEqual(
      expect.objectContaining({ code: 'NO_ACTIVE_WORKFLOWS' }),
    );
    expect(allPaused.issues.some((i) => i.code === 'NO_WORKFLOWS')).toBe(false);
  });

  it('warnings alone (no skills, no workflows) still leave ready=true and setupState NEEDS_SETUP', () => {
    const result = evaluateEmployeeReadiness(
      input({
        assignedSkillKeys: [],
        skillRequirements: [],
        workflowCount: 0,
        activeWorkflowCount: 0,
        knowledgeDocumentCount: 0,
      }),
    );
    expect(result.ready).toBe(true);
    expect(result.setupState).toBe('NEEDS_SETUP');
    expect(result.issues.every((i) => i.severity === 'WARNING')).toBe(true);
  });

  it('is a pure function: same input twice gives byte-identical output', () => {
    const a = evaluateEmployeeReadiness(input());
    const b = evaluateEmployeeReadiness(input());
    expect(a).toEqual(b);
  });
});
