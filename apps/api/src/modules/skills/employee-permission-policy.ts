import type { Prisma } from '@prisma/client';
import type {
  EmployeePermissionKey,
  EmployeePermissions,
  SkillCapability,
} from '@vaep/types';
import { EMPLOYEE_PERMISSION_KEYS } from '@vaep/types';
import { SkillCapabilities } from './capabilities';

/**
 * THE single source of truth for "may this AI Employee's configured
 * permissions allow this tool call?".
 *
 * ## Why this file exists
 *
 * The Employee Settings panel has always written
 * `AiEmployee.permissions = { sendEmail, contactCustomers, makePayments,
 * accessKnowledge }`. Nothing read it. `employees.mapper.ts` echoed the JSON
 * back to the UI and that was the entire lifecycle — a customer could untick
 * "Make payments", watch it save, reload and see it unticked, and the employee
 * would still create Stripe payment links. Four safety controls that were
 * pure decoration.
 *
 * ## Why it maps to CAPABILITIES, not to tools
 *
 * `capabilities.ts` already answers "which (skill, tool) pairs satisfy
 * EMAIL_SEND?" and is already guarded against drift by `capabilities.spec.ts`.
 * Enumerating tool names here instead would mean a second list to forget: add
 * Outlook as an EMAIL_SEND provider tomorrow and a `sendEmail: false` employee
 * would silently regain the ability to send mail. Going through the capability
 * layer makes new providers covered by construction.
 *
 * ## Semantics (three-valued, deliberately)
 *
 * - key **absent**  → ALLOWED. Every employee that predates enforcement has no
 *   permissions object at all; an upgrade that flipped those to "denied" would
 *   read as an outage, not a security fix.
 * - `true`          → ALLOWED.
 * - `false`         → DENIED, enforced at `SkillsService.runTool`.
 *
 * Note the deliberate consequence: this is a RESTRICTION layer, not a grant
 * layer. The grant layer already exists and is separate — `EmployeeSkill`
 * (doc 09 §9.D, enforced by `employeeMayUseSkill`). An employee still needs the
 * skill assigned; these flags can only take capability away, never add it.
 */

/**
 * Permission key → the capabilities it governs.
 *
 * Every mapping below is derived from the flag's own UI label plus vocabulary
 * that already exists in this codebase — no new product semantics were
 * invented:
 *
 * - `sendEmail` ("Send email") → EMAIL_SEND, the capability of that exact name.
 * - `contactCustomers` ("Contact customers") → the capabilities that reach a
 *   PERSON. `tool-approval-policy.ts` already defines that idea for the chat
 *   ACT loop ("tools that send to a person"); the capability-level expression
 *   of it is EMAIL_SEND + MESSAGING_SEND + SUPPORT_REPLY. SOCIAL_PUBLISH is
 *   deliberately excluded — broadcasting to a feed is publishing, not
 *   contacting a customer, and it already has its own highRisk gate.
 * - `makePayments` ("Make payments") → PAYMENTS_WRITE. PAYMENTS_READ is
 *   excluded: reading a balance moves no money.
 * - `accessKnowledge` ("Access knowledge base") → no capability. It gates
 *   RETRIEVAL, not a tool, and is enforced in `RetrievalService` alongside the
 *   existing `knowledgeAccess` enum. Present here as an empty set so the
 *   registry stays exhaustive over `EMPLOYEE_PERMISSION_KEYS`.
 */
export const EMPLOYEE_PERMISSION_CAPABILITIES: Record<
  EmployeePermissionKey,
  readonly SkillCapability[]
> = {
  sendEmail: ['EMAIL_SEND'],
  contactCustomers: ['EMAIL_SEND', 'MESSAGING_SEND', 'SUPPORT_REPLY'],
  makePayments: ['PAYMENTS_WRITE'],
  accessKnowledge: [],
};

/** Human label per key, for the denial message the caller actually sees. */
const PERMISSION_LABEL: Record<EmployeePermissionKey, string> = {
  sendEmail: 'Send email',
  contactCustomers: 'Contact customers',
  makePayments: 'Make payments',
  accessKnowledge: 'Access knowledge base',
};

/** Narrow a nullable Json column to the EmployeePermissions shape. */
export function parseEmployeePermissions(
  value: Prisma.JsonValue | null | undefined,
): EmployeePermissions {
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    return value as EmployeePermissions;
  }
  return {};
}

/** True when the flag is explicitly `false`. Absent/true/garbage → allowed. */
function isDenied(
  permissions: EmployeePermissions,
  key: EmployeePermissionKey,
): boolean {
  return permissions[key] === false;
}

export interface PermissionDenial {
  /** The flag that denied the call. */
  permission: EmployeePermissionKey;
  /** Its UI label, so the error names the checkbox the admin actually unticked. */
  label: string;
  /** The capability that made it relevant (null for non-tool permissions). */
  capability: SkillCapability | null;
  /** Message surfaced to the caller and written to the SkillExecution audit row. */
  reason: string;
}

/**
 * Evaluate an employee's permission flags against ONE tool call.
 *
 * Returns the denial (so the caller can log WHICH control fired) or null when
 * the call is permitted. Pure — no DI, no I/O — mirroring
 * `toolRequiresApproval` in the sibling `tool-approval-policy.ts`.
 */
export function permissionDenialFor(
  permissionsJson: Prisma.JsonValue | null | undefined,
  skillKey: string,
  tool: string,
): PermissionDenial | null {
  const permissions = parseEmployeePermissions(permissionsJson);
  const capability = SkillCapabilities.forTool(skillKey, tool);
  if (!capability) {
    // A tool outside the capability map (e.g. `http.request`, `gdrive.*`) is
    // not governed by any of today's four flags. Returning null here is NOT a
    // silent allow of an unknown action: the call still passes through the
    // EmployeeSkill grant check, the approval gate and the suppression list.
    return null;
  }
  for (const key of EMPLOYEE_PERMISSION_KEYS) {
    if (!isDenied(permissions, key)) continue;
    if (!EMPLOYEE_PERMISSION_CAPABILITIES[key].includes(capability)) continue;
    return {
      permission: key,
      label: PERMISSION_LABEL[key],
      capability,
      reason:
        `Blocked by this AI employee's permissions: "${PERMISSION_LABEL[key]}" is turned off, ` +
        `and ${skillKey}.${tool} needs it (${capability}). ` +
        `Turn the permission on in the employee's Settings to allow this.`,
    };
  }
  return null;
}

/**
 * Knowledge retrieval gate. Separate from the tool path because retrieval is
 * not a tool call — it is the RETRIEVE step of the runtime and the RETRIEVE
 * workflow node.
 *
 * ANDed with the existing `knowledgeAccess` enum rather than replacing it: both
 * controls are visible in the same settings panel, so "Knowledge access: NONE"
 * and "Access knowledge base: off" must each be sufficient on their own. The
 * stricter of the two wins.
 */
export function knowledgeRetrievalAllowed(employee: {
  knowledgeAccess: 'ALL' | 'NONE';
  permissions?: Prisma.JsonValue | null;
}): boolean {
  if (employee.knowledgeAccess === 'NONE') return false;
  return !isDenied(parseEmployeePermissions(employee.permissions), 'accessKnowledge');
}
