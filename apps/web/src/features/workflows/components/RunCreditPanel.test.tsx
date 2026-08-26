import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { RunCreditPanel } from './RunCreditPanel';
import type { WorkflowRunDto } from '@vaep/types';

function makeRun(overrides: Partial<WorkflowRunDto> = {}): WorkflowRunDto {
  return {
    id: 'r1',
    companyId: 'c1',
    workflowId: 'w1',
    status: 'COMPLETED',
    source: 'MANUAL',
    dryRun: false,
    trigger: null,
    context: null,
    triggerEventId: null,
    correlationId: null,
    error: null,
    failureClass: null,
    resumeNodeId: null,
    startedByUserId: null,
    workflowVersionId: null,
    startedAt: null,
    finishedAt: null,
    createdAt: '2026-08-20T00:00:00.000Z',
    creditLimit: null,
    totalCreditsCharged: 0,
    steps: [],
    ...overrides,
  };
}

describe('RunCreditPanel', () => {
  it('a completed run shows non-zero creditsCharged per billable step, zero for control-flow nodes', () => {
    const run = makeRun({
      totalCreditsCharged: 7,
      steps: [
        {
          id: 's1',
          companyId: 'c1',
          runId: 'r1',
          nodeId: 'ai-step',
          type: 'AI_STEP',
          status: 'COMPLETED',
          attempt: 1,
          input: null,
          output: null,
          error: null,
          startedAt: null,
          finishedAt: null,
          createdAt: '2026-08-20T00:00:00.000Z',
          creditsCharged: 7,
        },
        {
          id: 's2',
          companyId: 'c1',
          runId: 'r1',
          nodeId: 'wait-step',
          type: 'WAIT',
          status: 'COMPLETED',
          attempt: 1,
          input: null,
          output: null,
          error: null,
          startedAt: null,
          finishedAt: null,
          createdAt: '2026-08-20T00:00:00.000Z',
          creditsCharged: null,
        },
      ],
    });

    render(<RunCreditPanel run={run} />);

    expect(screen.getAllByText('7').length).toBeGreaterThan(0);
    expect(screen.queryByText('wait-step')).toBeNull();
  });

  it('a WAITING/approval-paused run with no billable steps yet shows zero accrued cost', () => {
    const run = makeRun({ status: 'WAITING', totalCreditsCharged: 0, steps: [] });
    render(<RunCreditPanel run={run} />);
    expect(screen.getByText('No billable steps in this run yet.')).not.toBeNull();
  });
});
