import { Injectable } from '@nestjs/common';
import type { EmployeeRole } from '@vaep/types';
import { PrismaService } from '../../../../common/prisma/prisma.service';
import { KnowledgeService } from '../../../knowledge/knowledge.service';
import { resolveTemplate } from '../template';
import type {
  NodeExecContext,
  NodeHandler,
  NodeResult,
} from './node-handler';

/**
 * RETRIEVE: knowledge search of a templated query → context[outputKey].
 *
 * ## §44 — this node used to be a knowledge leak
 *
 * It searched the WHOLE company knowledge base regardless of who was acting,
 * while chat retrieval for the same AI Employee was role-scoped. So a Marketing
 * workflow could read HR documents by adding a RETRIEVE node — the hardening
 * plan §44 names exactly this: *"A workflow RETRIEVE node must not silently see
 * knowledge the acting AI Employee cannot access."*
 *
 * The scoping machinery already existed (`KnowledgeDocument.category`, and the
 * `category` filter `KnowledgeService.search` applies). This node simply never
 * passed it.
 *
 * ## The scope it now applies, most specific first
 *
 * 1. **`employeeId` on the node** → that employee's `role` as the category, and
 *    their `knowledgeAccess`: `NONE` returns nothing at all, exactly as it does
 *    in chat. Same `employeeId` convention as AI_STEP and TOOL_ACTION.
 * 2. **the workflow's `category`** → an HR workflow retrieves HR + Shared, not
 *    Marketing's. This is the case that closes the loophole: without it an
 *    author omits `employeeId` and silently gets everything back.
 * 3. **neither** → company-wide, because an uncategorised workflow with no
 *    acting employee names no scope to enforce. The output records
 *    `scope: null` so this is visible in the run log rather than assumed.
 *
 * A `null` category always matches — company-wide/Shared documents belong to
 * nobody in particular and stay readable, which is the same rule the chat path
 * and the `/knowledge` screen already use.
 *
 * ## Why the categories are mapped and not cast
 *
 * `WorkflowCategory` and `EmployeeRole` are DIFFERENT enums that merely overlap.
 * `KnowledgeDocument.category` is an `EmployeeRole`, so casting a
 * `WorkflowCategory` straight through would send `IT` or `COMPLIANCE` into a
 * `::"EmployeeRole"` cast and fail in Postgres at runtime — a scoping change
 * that breaks retrieval entirely is worse than the leak it fixes.
 *
 * The four categories with no role equivalent scope to SHARED-ONLY rather than
 * falling back to company-wide: no document can be tagged `IT`, so shared is
 * genuinely all the knowledge such a workflow has any claim to, and the
 * fallback would quietly re-open the hole for exactly those workflows.
 */
const CATEGORY_TO_ROLE: Record<string, EmployeeRole | undefined> = {
  HR: 'HR',
  MARKETING: 'MARKETING',
  SALES: 'SALES',
  SUPPORT: 'SUPPORT',
  RECRUITMENT: 'RECRUITER',
  FINANCE: 'ACCOUNTANT',
  // OPERATIONS · IT · COMPLIANCE · CUSTOM → no EmployeeRole exists, so
  // `undefined` here means "shared only", not "unscoped".
};
@Injectable()
export class RetrieveNodeHandler implements NodeHandler {
  readonly type = 'RETRIEVE' as const;

  constructor(
    private readonly knowledge: KnowledgeService,
    private readonly prisma: PrismaService,
  ) {}

  async execute({
    companyId,
    workflowId,
    node,
    context,
  }: NodeExecContext): Promise<NodeResult> {
    const cfg = node.config ?? {};
    const query = resolveTemplate(cfg.query, context).trim();
    const rawK = Number(cfg.k);
    const k = Number.isFinite(rawK) && rawK > 0 ? Math.min(rawK, 50) : 5;

    const scope = await this.resolveScope(companyId, workflowId, cfg, context);
    if (scope.denied) {
      // knowledgeAccess NONE. Returning [] rather than throwing matches chat:
      // an employee with no knowledge access is a configuration, not an error.
      return {
        output: { query, k, count: 0, results: [], scope: null, denied: true },
        contextValue: [],
      };
    }

    const results = query
      ? await this.knowledge.retrieve(
          companyId,
          query,
          k,
          scope.category,
          scope.sharedOnly ?? false,
        )
      : [];
    return {
      output: {
        query,
        k,
        count: results.length,
        results,
        // Recorded so a surprising result count is diagnosable from the run log
        // instead of needing the graph and the employee row side by side.
        scope: scope.category ?? (scope.sharedOnly ? 'SHARED_ONLY' : null),
      },
      contextValue: results,
    };
  }

  private async resolveScope(
    companyId: string,
    workflowId: string,
    cfg: Record<string, unknown>,
    context: Record<string, unknown>,
  ): Promise<{
    category?: EmployeeRole;
    /** The workflow's category has no role equivalent → shared documents only. */
    sharedOnly?: boolean;
    denied?: boolean;
  }> {
    const employeeId = resolveTemplate(cfg.employeeId, context).trim();
    if (employeeId) {
      // Author-supplied id — tenant-checked, like every other node that takes one.
      const employee = await this.prisma.aiEmployee.findFirst({
        where: { id: employeeId, companyId },
        select: { role: true, knowledgeAccess: true },
      });
      if (employee) {
        if (employee.knowledgeAccess === 'NONE') return { denied: true };
        return { category: employee.role };
      }
      // An employee id that resolves to nothing must NOT fall through to
      // company-wide: that would make a typo the widest possible scope.
      return { denied: true };
    }

    const workflow = await this.prisma.workflow.findFirst({
      where: { id: workflowId, companyId },
      select: { category: true },
    });
    // No category at all → nothing to enforce, company-wide (unchanged).
    if (!workflow?.category) return {};

    const role = CATEGORY_TO_ROLE[workflow.category];
    return role ? { category: role } : { sharedOnly: true };
  }
}
