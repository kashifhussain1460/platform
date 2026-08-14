import type { Role } from '@vaep/types';

/**
 * WAVE 2 §2.2 — the vocabulary of the central authorization layer.
 *
 * Kept in its own file so a controller can import an ACTION name without pulling
 * in the service (and, through it, Prisma). Actions are strings rather than a
 * TypeScript enum on purpose: a DB-stored grant has to name one, and an enum
 * would need a migration every time a capability is added.
 */

/**
 * `<resource>:<verb>`. The plan's §2.2 examples (`canRunWorkflow()`,
 * `canReadKnowledge()`, …) map one-to-one onto these.
 */
export type AuthzAction =
  | 'workflow:read'
  | 'workflow:update'
  | 'workflow:publish'
  | 'workflow:run'
  | 'workflow:delete'
  | 'employee:read'
  | 'employee:manage'
  | 'knowledge:read'
  | 'knowledge:manage'
  | 'skill:connect'
  | 'approval:decide'
  | 'audit:read'
  | 'organization:manage'
  | 'hr:read'
  | 'hr:manage';

export type AuthzResourceType =
  | 'workflow'
  | 'employee'
  | 'knowledge'
  | 'skill'
  | 'approval'
  | 'audit'
  | 'organization'
  | 'hr';

/** Who is acting. Assembled from the JWT plus the user's org placement. */
export interface AuthzActor {
  userId: string;
  companyId: string;
  role: Role;
  /** null when the user is not placed in a department (the common case today). */
  departmentId?: string | null;
  teamId?: string | null;
  /** DISABLED users are denied everything, regardless of role. */
  status?: 'ACTIVE' | 'DISABLED';
}

/**
 * What is being acted on.
 *
 * `scope` is the discriminator that makes department isolation possible. It is a
 * plain string holding whatever axis the resource already carries —
 * `Workflow.category`, `AiEmployee.role`, `KnowledgeDocument.category`. Those are
 * three different enums that happen to share names (HR, MARKETING, SALES…), so a
 * string is the honest common type; inventing a fourth enum to unify them would
 * be a migration on every table for no behavioural gain.
 *
 * `scope: null` means "not scoped to any department" — company-wide, and
 * therefore visible to everyone the role check allows.
 */
export interface AuthzResource {
  type: AuthzResourceType;
  companyId: string;
  id?: string;
  scope?: string | null;
  /** Creator/owner, where the resource has one (e.g. `Workflow.ownerUserId`). */
  ownerUserId?: string | null;
  /**
   * The department this resource BELONGS to, by id.
   *
   * Distinct from `scope`, which is a scope NAME matched against the
   * department's configured `scopes`. Some resources — `StaffMember` most
   * obviously — carry a real `departmentId`, and for those the honest rule is a
   * direct match: an HR admin for Engineering has no business reading
   * Marketing's staff records, and no scope-name indirection expresses that as
   * cleanly.
   */
  departmentId?: string | null;
}

export interface AuthzContext {
  /** Extra facts a rule may need, e.g. a pre-resolved approval decision. */
  [key: string]: unknown;
}

export interface AuthzDecision {
  allowed: boolean;
  /**
   * Why. Surfaced in the 403 and in the audit trail — "Insufficient role for
   * this action" with no further detail is the reason authorization bugs take
   * days to diagnose.
   */
  reason: string;
  /** Which rule decided, for debugging a surprising allow or deny. */
  rule: string;
}

export const ALLOW = (rule: string, reason = 'allowed'): AuthzDecision => ({
  allowed: true,
  reason,
  rule,
});

export const DENY = (rule: string, reason: string): AuthzDecision => ({
  allowed: false,
  reason,
  rule,
});
