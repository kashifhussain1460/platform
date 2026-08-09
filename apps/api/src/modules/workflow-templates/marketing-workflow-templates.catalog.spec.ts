import { MARKETING_WORKFLOW_TEMPLATES } from './marketing-workflow-templates.catalog';
import { SkillCatalog } from '../skills/catalog';

/**
 * Marketing production verification — doc 28 §0.2/§0.4: "Nothing addressed to the
 * public is autonomous." Every publish is gated either by the postiz highRisk
 * auto-pause OR an explicit APPROVAL; every prospect-facing email is gated by an
 * APPROVAL upstream. Locked here so a template edit can't silently open a
 * public-facing action.
 */
type Node = { id: string; type: string; config?: Record<string, unknown> };
type Edge = { from: string; to: string };
const graph = (t: (typeof MARKETING_WORKFLOW_TEMPLATES)[number]) =>
  t.definition as unknown as { nodes: Node[]; edges: Edge[] };

const reaches = (nodes: Node[], edges: Edge[], start: string, target: string): boolean => {
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

describe('Marketing templates — publish safety (doc 28 §0.2)', () => {
  it('postiz publish/schedule tools are highRisk (the platform auto-gate premise)', () => {
    expect(SkillCatalog.getTool('postiz', 'schedule_post')?.highRisk).toBe(true);
    expect(SkillCatalog.getTool('postiz', 'publish_now')?.highRisk).toBe(true);
  });

  it('never uses banned legacy vocab and never a LOOP (no APPROVAL-in-LOOP risk)', () => {
    for (const t of MARKETING_WORKFLOW_TEMPLATES) {
      for (const n of graph(t).nodes) {
        expect(['AI_STEP', 'NOTIFY', 'LOOP']).not.toContain(n.type);
      }
    }
  });

  it('every prospect-facing email send sits downstream of an APPROVAL', () => {
    for (const t of MARKETING_WORKFLOW_TEMPLATES) {
      const { nodes, edges } = graph(t);
      const emailNodes = nodes.filter(
        (n) =>
          n.type === 'TOOL_ACTION' &&
          (n.config?.skillKey === 'gmail' || n.config?.skillKey === 'email') &&
          n.config?.tool === 'send_email',
      );
      if (emailNodes.length === 0) continue;
      const approvals = nodes.filter((n) => n.type === 'APPROVAL');
      for (const email of emailNodes) {
        const gated = approvals.some((a) => reaches(nodes, edges, a.id, email.id));
        expect({ template: t.key, email: email.id, gated }).toEqual({
          template: t.key,
          email: email.id,
          gated: true,
        });
      }
    }
  });

  it('every postiz publish_now/schedule_post node relies on the highRisk gate or an APPROVAL', () => {
    // Presence check: any template that publishes must either carry an APPROVAL
    // OR use a highRisk postiz tool (the auto-pause). Both are acceptable per §0.2.
    for (const t of MARKETING_WORKFLOW_TEMPLATES) {
      const { nodes } = graph(t);
      const publishNodes = nodes.filter(
        (n) =>
          n.type === 'TOOL_ACTION' &&
          n.config?.skillKey === 'postiz' &&
          (n.config?.tool === 'publish_now' || n.config?.tool === 'schedule_post'),
      );
      for (const p of publishNodes) {
        const tool = SkillCatalog.getTool('postiz', String(p.config?.tool));
        const hasApproval = nodes.some((n) => n.type === 'APPROVAL');
        expect(Boolean(tool?.highRisk) || hasApproval).toBe(true);
      }
    }
  });
});
