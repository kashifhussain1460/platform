import type { Prisma } from '@prisma/client';
import type { ApprovalRules } from '@vaep/types';
import { SkillCatalog } from './catalog';
import type { PrismaService } from '../../common/prisma/prisma.service';

/**
 * Credit system Phase 4, Task 4.5 (§7.6 Option C) — a company whose only
 * ledger funding source is a `FREE_SIGNUP`/`PROMOTIONAL` grant (no
 * `PACK_PURCHASE`/`SUBSCRIPTION_GRANT`/`ENTERPRISE_ALLOTMENT` row exists yet,
 * i.e. it has never demonstrated a real payment method) is "credit-only".
 * Async because it is a DB read — callers already sit inside an async
 * context (`ToolExecutorService.call`, both engines' approval gates), so
 * this is computed once per call and threaded into the still-synchronous
 * `toolRequiresApproval` below rather than making that pure policy function
 * itself DB-dependent.
 */
export async function isCreditOnlyCompany(
  prisma: PrismaService,
  companyId: string,
): Promise<boolean> {
  const paidGrant = await prisma.creditLedger.findFirst({
    where: {
      companyId,
      grantKind: { in: ['PACK_PURCHASE', 'SUBSCRIPTION_GRANT', 'ENTERPRISE_ALLOTMENT'] },
    },
    select: { id: true },
  });
  return paidGrant === null;
}

/** Minimal shape needed to evaluate an employee's approval policy. */
export interface ApprovalPolicyEmployee {
  approvalRules?: Prisma.JsonValue | null;
}

/**
 * THE single source of truth for "must this tool call pause for a human?".
 *
 * Lives here — beside the catalog, in the skills module — deliberately. Both
 * callers (`ApprovalService`, used by the chat path, and `WorkflowEngineService`,
 * used by the workflow path) already import from `modules/skills`, so sharing
 * this adds NO new module edge and cannot create the
 * Approvals→Workflows→Approvals cycle the engine is careful to avoid. It is a
 * pure function with no DI, so neither caller needs the other's module.
 *
 * Gap G25 (`docs/architecture/workflow-system/00-overview-and-canonical-contracts.md`)
 * existed precisely because this logic was implemented once, privately, inside
 * ApprovalService — so the workflow engine silently had no gate at all. Any new
 * execution path MUST call this rather than re-deriving the rules.
 *
 * True when the catalog tool is `highRisk`, OR the employee's `approvalRules`
 * require all tools, OR its `requireApprovalForTools` lists `skillKey` or
 * `skillKey:tool`.
 *
 * `employee` is optional: a workflow TOOL_ACTION step that is not scoped to a
 * specific AI Employee has no per-employee rules, so only the catalog's
 * `highRisk` flag applies.
 *
 * `companyIsCreditOnly` (Phase 4, Task 4.5, §7.6 Option C) — when true, every
 * real-send/external-action tool (per `isExternalActionTool`'s existing
 * catalog list below — the same list already used to gate the chat ACT
 * loop against untrusted content, and the right proxy here too: it names
 * exactly the tools that send to a person or mutate an external system,
 * catalog-side, without needing to thread the active executor mode
 * (mock/real/auto) into this pure policy function) routes to a human,
 * regardless of the `highRisk` flag — not just the 3 tools already marked
 * `highRisk`. Defaults `false` so every existing caller/test that doesn't
 * pass it keeps today's behavior unchanged.
 */
export function toolRequiresApproval(
  employee: ApprovalPolicyEmployee | null | undefined,
  skillKey: string,
  tool: string,
  companyIsCreditOnly = false,
): boolean {
  if (SkillCatalog.getTool(skillKey, tool)?.highRisk) {
    return true;
  }
  if (companyIsCreditOnly && isExternalActionTool(skillKey, tool)) {
    return true;
  }
  const rules = parseApprovalRules(employee?.approvalRules);
  if (rules.requireApprovalForAllTools) {
    return true;
  }
  // Phase 1 safety fix — "Require approval for external messages".
  //
  // The Employee Settings panel has written this flag since the panel shipped;
  // no policy read it, so an admin could tick it, save it, see it ticked on
  // reload, and still have the employee email customers unsupervised. It binds
  // to the SAME `isExternalActionTool` set the chat ACT loop already uses for
  // untrusted-content containment — no second definition of "external".
  if (rules.approveExternalMessages && isExternalActionTool(skillKey, tool)) {
    return true;
  }
  const list = rules.requireApprovalForTools ?? [];
  return list.includes(skillKey) || list.includes(`${skillKey}:${tool}`);
}

/**
 * Tools that send to a person, mutate an external system, or egress data.
 * Used to force a human approval for AUTONOMOUS agent tool-use (the chat ACT
 * loop), where untrusted content (a pasted CV/email) could otherwise drive an
 * unapproved external action. Read-only tools (list/get/read/status) are absent
 * on purpose — an agent may still gather context autonomously. This does NOT
 * change explicit TOOL_ACTION workflow nodes (they run through the engine's own
 * highRisk gate + author-placed APPROVAL nodes, not this policy).
 */
const EXTERNAL_ACTION_TOOLS = new Set<string>([
  'gmail:send_email',
  'email:send_email',
  'slack:send_message',
  'http:request',
  'calendar:create_event',
  'gdrive:upload_file',
  'gdrive:move_file',
  'gdrive:create_folder',
  'github:create_issue',
  'github:remove_collaborator',
  'jira:create_issue',
  'hubspot:create_contact',
  'hubspot:update_deal',
  'chatwoot:reply_to_conversation',
  'chatwoot:resolve_conversation',
  'plane:create_issue',
  'postiz:schedule_post',
  'postiz:publish_now',
  'stripe:create_payment_link',
]);

/** True when a tool sends to a person / mutates an external system / egresses data. */
export function isExternalActionTool(skillKey: string, tool: string): boolean {
  return EXTERNAL_ACTION_TOOLS.has(`${skillKey}:${tool}`);
}

/**
 * S-01: `ValidationService.validate()`'s `needsApproval` (confidence/grounding)
 * used to reach only `WorkflowStepRun.output` — a display-only JSON blob a
 * later TOOL_ACTION node in the same run had no way to see, so a low-
 * confidence/ungrounded AI_EMPLOYEE_STEP draft could still be sent
 * autonomously (e.g. an AI Support reply). The engine writes this reserved,
 * per-node context key whenever a node's output carries an unresolved
 * validation concern; both gates below (`pauseIfToolNeedsApproval` for the
 * legacy walk, `evaluateToolAction` for the durable runtime) also require the
 * absence of any such concern, in addition to the catalog/employee-rules
 * check. Never author-settable — no workflow template's `outputKey` should
 * ever start with this prefix.
 */
export const VALIDATION_CONTEXT_PREFIX = '__validation:';

export function validationContextKey(nodeId: string): string {
  return `${VALIDATION_CONTEXT_PREFIX}${nodeId}`;
}

/**
 * Extracts a boolean validation concern from a node's raw `output`. Reads
 * structurally (not by importing AiEmployeeStepHandler, which would create a
 * skills→employees module edge) so any future node that embeds the same
 * `{ validation: { needsApproval } }` shape is picked up automatically.
 */
export function extractValidationConcern(output: unknown): boolean {
  if (!output || typeof output !== 'object') return false;
  const validation = (output as Record<string, unknown>).validation;
  if (!validation || typeof validation !== 'object') return false;
  return (validation as Record<string, unknown>).needsApproval === true;
}

/**
 * True when ANY node earlier in this run left an unresolved validation
 * concern in context. Deliberately scans the whole context rather than
 * requiring a workflow author to wire a precise upstream-node reference — no
 * Support/HR workflow template exists yet that could get that reference
 * wrong, and a scan fails SAFE (over-inclusive, never under-inclusive) if a
 * future graph branches in parallel.
 */
export function contextHasUnresolvedValidationConcern(
  context: Record<string, unknown> | null | undefined,
): boolean {
  if (!context) return false;
  return Object.keys(context).some(
    (key) => key.startsWith(VALIDATION_CONTEXT_PREFIX) && context[key] === true,
  );
}

/** Narrow a nullable Json column to the ApprovalRules shape. */
export function parseApprovalRules(
  rules: Prisma.JsonValue | null | undefined,
): ApprovalRules {
  if (rules && typeof rules === 'object' && !Array.isArray(rules)) {
    return rules as ApprovalRules;
  }
  return {};
}
