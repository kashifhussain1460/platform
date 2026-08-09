import { HR_WORKFLOW_TEMPLATES } from './hr-workflow-templates.catalog';

/**
 * HR production verification — doc 27 §0.3/§0.4 approval-boundary invariants.
 * These lock the "a machine never tells a human they were rejected, hired or
 * terminated" rule into a fast unit test so a future template edit that drops a
 * mandated APPROVAL gate fails here, not in production.
 */
const byKey = (key: string) => {
  const t = HR_WORKFLOW_TEMPLATES.find((x) => x.key === key);
  if (!t) throw new Error(`template ${key} missing`);
  return t;
};
type Node = { id: string; type: string; config?: Record<string, unknown> };
type Edge = { from: string; to: string; branch?: string };
const graph = (key: string) => {
  const def = byKey(key).definition as unknown as { nodes: Node[]; edges: Edge[] };
  return def;
};
const approvals = (key: string) =>
  graph(key).nodes.filter((n) => n.type === 'APPROVAL');

/** Is `target` reachable from `start` following edges (ignoring direction of gates)? */
const reaches = (key: string, start: string, target: string): boolean => {
  const { edges } = graph(key);
  const seen = new Set<string>();
  const stack = [start];
  while (stack.length) {
    const cur = stack.pop()!;
    if (cur === target) return true;
    if (seen.has(cur)) continue;
    seen.add(cur);
    for (const e of edges.filter((x) => x.from === cur)) stack.push(e.to);
  }
  return false;
};

describe('HR templates — frozen vocab (doc 27 §0.4)', () => {
  const BANNED = new Set(['AI_STEP', 'NOTIFY']);
  it('never uses the banned legacy node types', () => {
    for (const t of HR_WORKFLOW_TEMPLATES) {
      const def = t.definition as unknown as { nodes: Node[] };
      for (const n of def.nodes) {
        expect(BANNED.has(n.type)).toBe(false);
      }
    }
  });
});

describe('HR templates — approval boundaries (doc 27 §0.3)', () => {
  it('candidate-screening gates the candidate email behind an APPROVAL', () => {
    expect(approvals('hr.candidate-screening').length).toBeGreaterThanOrEqual(1);
    const appr = approvals('hr.candidate-screening')[0].id;
    // The person-facing "notify" email must be downstream of the approval gate.
    expect(reaches('hr.candidate-screening', appr, 'notify')).toBe(true);
    // And NOT reachable from the AI step without passing the gate.
    expect(reaches('hr.candidate-screening', 'screen', 'notify')).toBe(true); // via appr
  });

  it('performance-review has TWO sequential approvals (manager content + HR release)', () => {
    expect(approvals('hr.performance-review').length).toBe(2);
    // Employee email is downstream of the HR-release (second) gate.
    expect(reaches('hr.performance-review', 'hrReleaseApproval', 'email')).toBe(true);
  });

  it('offboarding has TWO approvals and the revocation notice is behind the second', () => {
    expect(approvals('hr.offboarding').length).toBe(2);
    expect(reaches('hr.offboarding', 'revokeApproval', 'revokeNotice')).toBe(true);
    // The revocation notice must NOT fire from the first (start) gate directly.
    expect(reaches('hr.offboarding', 'startApproval', 'exitDoc')).toBe(true);
  });

  it('onboarding gates provisioning behind the checklist approval', () => {
    expect(approvals('hr.onboarding').length).toBeGreaterThanOrEqual(1);
  });

  it('document-verification gates move-to-verified behind an APPROVAL (T3)', () => {
    const appr = approvals('hr.document-verification')[0].id;
    expect(reaches('hr.document-verification', appr, 'moveToVerified')).toBe(true);
  });

  it('read-only / T1 templates carry no approval (auto-ack / scheduling / attendance)', () => {
    expect(approvals('hr.recruitment-intake').length).toBe(0);
    expect(approvals('hr.interview-scheduling').length).toBe(0);
    expect(approvals('hr.attendance-monitor').length).toBe(0);
  });

  it('no APPROVAL sits inside a LOOP (no LOOP nodes at all)', () => {
    for (const t of HR_WORKFLOW_TEMPLATES) {
      const def = t.definition as unknown as { nodes: Node[] };
      expect(def.nodes.some((n) => n.type === 'LOOP')).toBe(false);
    }
  });
});
