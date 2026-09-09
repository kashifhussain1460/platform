import {
  EMPLOYEE_LIFECYCLE_SELECT,
  EmployeeNotWorkableError,
  assertEmployeeWorkable,
  employeeWorkableReason,
  type EmployeeLifecycleState,
} from './employee-lifecycle';

/**
 * The five inputs that matter. The fourth (ACTIVE-but-archived) is the one a
 * status-only check would wave through, and it is reachable in production:
 * `PATCH /employees/:id { status: 'ACTIVE' }` on an archived employee does not
 * clear `archivedAt`, and there is no unarchive endpoint.
 */
function employee(over: Partial<EmployeeLifecycleState> = {}): EmployeeLifecycleState {
  return { id: 'emp-1', name: 'Emma', status: 'ACTIVE', archivedAt: null, ...over };
}

describe('employeeWorkableReason', () => {
  it('allows an ACTIVE, unarchived employee', () => {
    expect(employeeWorkableReason(employee())).toBeNull();
  });

  it('blocks PAUSED', () => {
    expect(employeeWorkableReason(employee({ status: 'PAUSED' }))).toBe('PAUSED');
  });

  it('blocks DISABLED', () => {
    expect(employeeWorkableReason(employee({ status: 'DISABLED' }))).toBe('DISABLED');
  });

  it('blocks an ACTIVE employee that is archived — the split state a status-only check misses', () => {
    expect(
      employeeWorkableReason(employee({ status: 'ACTIVE', archivedAt: new Date() })),
    ).toBe('ARCHIVED');
  });

  it('reports ARCHIVED ahead of DISABLED, because archiving is the actionable state', () => {
    // remove() sets both, so this combination is the normal archived shape.
    expect(
      employeeWorkableReason(employee({ status: 'DISABLED', archivedAt: new Date() })),
    ).toBe('ARCHIVED');
  });

  it('treats a missing employee as MISSING, never as allowed', () => {
    expect(employeeWorkableReason(null)).toBe('MISSING');
    expect(employeeWorkableReason(undefined)).toBe('MISSING');
  });
});

describe('assertEmployeeWorkable', () => {
  it('returns the row unchanged when workable, preserving the caller\'s own select type', () => {
    const row = { ...employee(), approvalRules: { requireApprovalForAllTools: true } };
    const out = assertEmployeeWorkable(row, { employeeId: 'emp-1', nodeId: 'n1' });
    // Not just truthy — the SAME object, so a handler can keep using its own fields.
    expect(out).toBe(row);
    expect(out.approvalRules.requireApprovalForAllTools).toBe(true);
  });

  it('throws a typed error carrying the reason, so the retry classifier can use instanceof', () => {
    expect.assertions(5);
    try {
      assertEmployeeWorkable(employee({ status: 'PAUSED' }), {
        employeeId: 'emp-1',
        nodeId: 'summarize_application',
      });
    } catch (err) {
      expect(err).toBeInstanceOf(EmployeeNotWorkableError);
      const e = err as EmployeeNotWorkableError;
      expect(e.reason).toBe('PAUSED');
      expect(e.employeeId).toBe('emp-1');
      expect(e.nodeId).toBe('summarize_application');
      expect(e.employeeName).toBe('Emma');
    }
  });

  it('throws MISSING with a null name rather than dereferencing null', () => {
    try {
      assertEmployeeWorkable(null, { employeeId: 'gone' });
      throw new Error('should have thrown');
    } catch (err) {
      const e = err as EmployeeNotWorkableError;
      expect(e.reason).toBe('MISSING');
      expect(e.employeeName).toBeNull();
      expect(e.nodeId).toBeNull();
    }
  });

  it('names the employee, its state and the fix — this text lands in WorkflowRun.error', () => {
    try {
      assertEmployeeWorkable(employee({ status: 'PAUSED' }), {
        employeeId: 'emp-1',
        nodeId: 'send_offer',
      });
      throw new Error('should have thrown');
    } catch (err) {
      const msg = (err as Error).message;
      expect(msg).toContain('send_offer');
      expect(msg).toContain('Emma');
      expect(msg).toContain('paused');
      // The fix, not just the diagnosis.
      expect(msg).toMatch(/Resume|assign this step/i);
    }
  });

  it('does not claim an archived employee is merely disabled', () => {
    try {
      assertEmployeeWorkable(employee({ status: 'DISABLED', archivedAt: new Date() }), {
        employeeId: 'emp-1',
        nodeId: 'n1',
      });
      throw new Error('should have thrown');
    } catch (err) {
      expect((err as Error).message).toContain('archived');
      expect((err as Error).message).not.toContain('disabled');
    }
  });
});

describe('EMPLOYEE_LIFECYCLE_SELECT', () => {
  it('selects exactly the four columns the rule reads', () => {
    // Pinned so a future edit cannot drop `archivedAt` and silently re-open the
    // ACTIVE-but-archived hole for every call site at once.
    expect(EMPLOYEE_LIFECYCLE_SELECT).toEqual({
      id: true,
      name: true,
      status: true,
      archivedAt: true,
    });
  });
});
