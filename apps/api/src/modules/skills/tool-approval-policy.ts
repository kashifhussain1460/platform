import type { Prisma } from '@prisma/client';
import type { ApprovalRules } from '@vaep/types';
import { SkillCatalog } from './catalog';

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
 */
export function toolRequiresApproval(
  employee: ApprovalPolicyEmployee | null | undefined,
  skillKey: string,
  tool: string,
): boolean {
  if (SkillCatalog.getTool(skillKey, tool)?.highRisk) {
    return true;
  }
  const rules = parseApprovalRules(employee?.approvalRules);
  if (rules.requireApprovalForAllTools) {
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

/** Narrow a nullable Json column to the ApprovalRules shape. */
export function parseApprovalRules(
  rules: Prisma.JsonValue | null | undefined,
): ApprovalRules {
  if (rules && typeof rules === 'object' && !Array.isArray(rules)) {
    return rules as ApprovalRules;
  }
  return {};
}
