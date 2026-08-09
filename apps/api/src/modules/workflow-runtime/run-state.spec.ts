import {
  STEP_RUN_STATUSES,
  WORKFLOW_RUN_STATUSES,
  type StepRunStatus,
  type WorkflowRunStatus,
} from '@vaep/types';
import {
  IllegalStateTransitionError,
  RUN_TRANSITIONS,
  STEP_TRANSITIONS,
  assertRunTransition,
  assertStepTransition,
  canTransitionRun,
  canTransitionStep,
  isTerminalRunStatus,
  isTerminalStepStatus,
} from './run-state';

/**
 * The transition matrix is the safety net for the whole state machine, so it is
 * tested EXHAUSTIVELY — every (from, to) pair, not a hand-picked sample. It is
 * cheap to do and it is the only way to be sure a legal transition was not
 * dropped or an illegal one quietly allowed.
 */
describe('run/step state machine (P1-04)', () => {
  describe('run transitions', () => {
    it('covers every status in @vaep/types (no value missing from the matrix)', () => {
      expect(Object.keys(RUN_TRANSITIONS).sort()).toEqual(
        [...WORKFLOW_RUN_STATUSES].sort(),
      );
    });

    it.each(WORKFLOW_RUN_STATUSES)(
      'every (%s → X) pair is either allowed or throws — nothing silent',
      (from) => {
        for (const to of WORKFLOW_RUN_STATUSES) {
          if (canTransitionRun(from, to)) {
            expect(() => assertRunTransition(from, to)).not.toThrow();
          } else {
            expect(() => assertRunTransition(from, to)).toThrow(
              IllegalStateTransitionError,
            );
          }
        }
      },
    );

    it('treats COMPLETED / FAILED / TIMED_OUT / CANCELLED as terminal', () => {
      const terminal: WorkflowRunStatus[] = [
        'COMPLETED',
        'FAILED',
        'TIMED_OUT',
        'CANCELLED',
      ];
      for (const status of terminal) {
        expect(isTerminalRunStatus(status)).toBe(true);
        // A terminal run must be unreachable FROM — that is what makes
        // "a COMPLETED run can never be reopened" mechanical, not a convention.
        for (const to of WORKFLOW_RUN_STATUSES) {
          expect(canTransitionRun(status, to)).toBe(false);
        }
      }
    });

    it('cannot reopen a COMPLETED run', () => {
      expect(() => assertRunTransition('COMPLETED', 'RUNNING')).toThrow(
        'Illegal run transition: COMPLETED → RUNNING',
      );
    });

    it('allows the WAITING → RUNNING resume path (approval / timer)', () => {
      expect(canTransitionRun('WAITING', 'RUNNING')).toBe(true);
    });

    it('does not allow PENDING to jump straight to COMPLETED', () => {
      // A run that never RAN cannot have succeeded; allowing this would let a
      // bug fabricate a successful run with no steps.
      expect(canTransitionRun('PENDING', 'COMPLETED')).toBe(false);
    });

    it('only allows COMPENSATING to end, never to resume', () => {
      expect(canTransitionRun('COMPENSATING', 'RUNNING')).toBe(false);
      expect(canTransitionRun('COMPENSATING', 'COMPLETED')).toBe(false);
      expect(canTransitionRun('COMPENSATING', 'FAILED')).toBe(true);
    });
  });

  describe('step transitions', () => {
    it('covers every status in @vaep/types', () => {
      expect(Object.keys(STEP_TRANSITIONS).sort()).toEqual(
        [...STEP_RUN_STATUSES].sort(),
      );
    });

    it.each(STEP_RUN_STATUSES)(
      'every (%s → X) pair is either allowed or throws',
      (from) => {
        for (const to of STEP_RUN_STATUSES) {
          if (canTransitionStep(from, to)) {
            expect(() => assertStepTransition(from, to)).not.toThrow();
          } else {
            expect(() => assertStepTransition(from, to)).toThrow(
              IllegalStateTransitionError,
            );
          }
        }
      },
    );

    it('allows the retry loop RUNNING → RETRYING → RUNNING', () => {
      expect(canTransitionStep('RUNNING', 'RETRYING')).toBe(true);
      expect(canTransitionStep('RETRYING', 'RUNNING')).toBe(true);
    });

    it('allows COMPLETED → COMPENSATED (saga rollback) but nothing else', () => {
      expect(canTransitionStep('COMPLETED', 'COMPENSATED')).toBe(true);
      expect(canTransitionStep('COMPLETED', 'RUNNING')).toBe(false);
      expect(isTerminalStepStatus('COMPLETED')).toBe(false);
      expect(isTerminalStepStatus('COMPENSATED')).toBe(true);
    });

    it('cannot resurrect a FAILED step — a retry is a NEW attempt', () => {
      const failed: StepRunStatus = 'FAILED';
      for (const to of STEP_RUN_STATUSES) {
        expect(canTransitionStep(failed, to)).toBe(false);
      }
    });
  });
});
