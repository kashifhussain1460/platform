import { AiEmployeeStepNodeHandler } from './ai-employee-step.handler';
import { OUT_OF_SCOPE_MARKER } from './out-of-scope';

/**
 * A refused step must FAIL the run.
 *
 * Live evidence for why: an HR AI Employee was given "summarize the candidate's
 * application", declined it as recruiting work, and the platform recorded the
 * step COMPLETED and the run COMPLETED — then the next step emailed the
 * candidate an acknowledgement for a summary that was never written. The QA
 * pack's first pass criterion is "no silent success"; this is the test for it.
 */
describe('AI_EMPLOYEE_STEP — a refusal is not a result', () => {
  const employee = {
    id: 'emp-1',
    name: 'Anushka',
    role: 'HR',
    companyId: 'co-1',
  };

  const makeHandler = (runResult: Record<string, unknown>) => {
    const prisma = {
      aiEmployee: { findFirst: jest.fn().mockResolvedValue(employee) },
      conversation: { create: jest.fn().mockResolvedValue({ id: 'conv-1' }) },
    };
    const runtime = { run: jest.fn().mockResolvedValue(runResult) };
    const registry = { register: jest.fn() };
    return new AiEmployeeStepNodeHandler(
      prisma as never,
      runtime as never,
      registry as never,
    );
  };

  const ctx = {
    companyId: 'co-1',
    workflowId: 'wf-1',
    runId: 'run-1',
    node: {
      id: 'summarize_application',
      type: 'AI_EMPLOYEE_STEP' as const,
      config: { employeeId: 'emp-1', instruction: 'Summarize the CV.' },
    },
    context: {},
    dryRun: false,
  };

  it('throws when the employee declined the work as another role\'s job', async () => {
    const handler = makeHandler({
      message: {
        id: 'msg-1',
        content:
          'Summarizing candidate applications is a recruiting task, outside my HR role.',
      },
      plan: [],
      sources: [],
      validation: { grounded: false, confidence: 0, needsApproval: false },
      toolCalls: [],
      outOfScope: true,
    });

    await expect(handler.execute(ctx as never)).rejects.toThrow(
      /declined it as outside that role/i,
    );
  });

  it('names the step, the employee and their role so the fix is obvious', async () => {
    const handler = makeHandler({
      message: { id: 'msg-1', content: 'That is recruiting work.' },
      plan: [],
      sources: [],
      validation: { grounded: false, confidence: 0, needsApproval: false },
      toolCalls: [],
      outOfScope: true,
    });

    await expect(handler.execute(ctx as never)).rejects.toThrow(
      /summarize_application[\s\S]*Anushka[\s\S]*HR/,
    );
  });

  it('does NOT leak the protocol marker into the run log', async () => {
    const handler = makeHandler({
      message: { id: 'msg-1', content: 'That is recruiting work.' },
      plan: [],
      sources: [],
      validation: { grounded: false, confidence: 0, needsApproval: false },
      toolCalls: [],
      outOfScope: true,
    });

    await expect(handler.execute(ctx as never)).rejects.toThrow(
      expect.not.stringContaining(OUT_OF_SCOPE_MARKER) as never,
    );
  });

  it('still returns the answer when the employee actually did the work', async () => {
    const handler = makeHandler({
      message: { id: 'msg-1', content: 'Sarah has 4 years of experience.' },
      plan: ['read the CV'],
      sources: [],
      validation: { grounded: true, confidence: 0.9, needsApproval: false },
      toolCalls: [],
      outOfScope: false,
    });

    const result = await handler.execute(ctx as never);
    expect(result.contextValue).toBe('Sarah has 4 years of experience.');
  });
});
