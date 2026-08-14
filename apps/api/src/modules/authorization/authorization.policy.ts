import type { Role } from '@vaep/types';
import {
  ALLOW,
  DENY,
  type AuthzAction,
  type AuthzActor,
  type AuthzDecision,
  type AuthzResource,
} from './authorization.types';

/**
 * WAVE 2 §2.2 — the policy, as a PURE function.
 *
 * Everything here is decidable from values the caller already loaded, so the
 * whole rule set can be tested exhaustively without Postgres, Redis or a Nest
 * context. `AuthorizationService` is the thin I/O shell that fetches the actor's
 * department and the resource's scope and then calls this.
 *
 * ## The one design decision that matters
 *
 * Department isolation is **opt-in per department**. A department with no
 * `scopes` restricts nothing. Every existing tenant has no department scopes
 * configured, so shipping this changes NOTHING for them — which is the only
 * responsible way to introduce an authorization layer over a live system. An
 * authorization change that silently starts denying real users is worse than the
 * gap it closes: it looks like an outage, not a security control.
 *
 * Turning isolation on for a tenant is one write: give the department its scopes.
 */

/** Role hierarchy, identical to `RolesGuard` — OWNER ⊇ ADMIN ⊇ MEMBER. */
const ROLE_RANK: Record<Role, number> = { MEMBER: 0, ADMIN: 1, OWNER: 2 };

/** The minimum company role each action needs, BEFORE any scope check. */
const MIN_ROLE: Record<AuthzAction, Role> = {
  'workflow:read': 'MEMBER',
  'workflow:update': 'MEMBER',
  'workflow:publish': 'MEMBER',
  'workflow:run': 'MEMBER',
  'workflow:delete': 'MEMBER',
  'employee:read': 'MEMBER',
  'employee:manage': 'ADMIN',
  'knowledge:read': 'MEMBER',
  'knowledge:manage': 'MEMBER',
  'skill:connect': 'ADMIN',
  // Routed approvals are decided by ApprovalRoutingService.canDecide, which this
  // layer delegates to rather than duplicating (plan §19: one approval engine).
  // This floor only covers the UNROUTED fallback.
  'approval:decide': 'ADMIN',
  'audit:read': 'ADMIN',
  'organization:manage': 'ADMIN',
  // HR holds special-category PII: OWNER/ADMIN only, READS INCLUDED.
  'hr:read': 'ADMIN',
  'hr:manage': 'ADMIN',
};

export function roleSatisfies(role: Role, minimum: Role): boolean {
  return ROLE_RANK[role] >= ROLE_RANK[minimum];
}

/**
 * The department placement of the acting user, resolved by the service.
 * `scopes` empty (or no department) → the actor is unrestricted by scope.
 */
export interface ActorDepartment {
  id: string;
  name: string;
  scopes: readonly string[];
}

export function decide(input: {
  actor: AuthzActor;
  action: AuthzAction;
  resource: AuthzResource;
  department?: ActorDepartment | null;
}): AuthzDecision {
  const { actor, action, resource, department } = input;

  // 1. Tenant isolation comes first and is absolute. A cross-tenant request is
  //    never a role question, so it must never reach a role rule that an OWNER
  //    would satisfy.
  if (actor.companyId !== resource.companyId) {
    return DENY(
      'tenant',
      'Resource belongs to a different company',
    );
  }

  // 2. The kill switch. A disabled account keeps a valid JWT until it expires,
  //    so every path has to re-check, not just login.
  if (actor.status === 'DISABLED') {
    return DENY('user-status', 'User account is disabled');
  }

  // 3. Company role floor.
  const minimum = MIN_ROLE[action];
  if (!minimum) {
    // Fail CLOSED on an unknown action. A typo'd action string silently
    // allowing everything is the worst possible failure mode for this layer.
    return DENY('unknown-action', `Unknown action "${action}"`);
  }
  if (!roleSatisfies(actor.role, minimum)) {
    return DENY(
      'role',
      `Action "${action}" requires at least ${minimum}; caller is ${actor.role}`,
    );
  }

  // 4. An OWNER is the tenant's root and is never department-scoped. Without
  //    this, an OWNER placed in a department could lock themselves out of their
  //    own company's other departments and nobody could undo it.
  if (actor.role === 'OWNER') {
    return ALLOW('owner', 'Company owner');
  }

  // 5a. DIRECT department ownership (e.g. StaffMember.departmentId).
  //
  // Checked before scope names because it is the stronger statement: the
  // resource names its department outright, so no scope configuration is needed
  // for the rule to be meaningful. Still inert for an actor with no department,
  // which keeps the "ships inert" property for every existing tenant.
  if (
    resource.departmentId &&
    actor.departmentId &&
    resource.departmentId !== actor.departmentId
  ) {
    return DENY(
      'department-owner',
      `This ${resource.type} belongs to another department`,
    );
  }

  // 5b. Department isolation by scope name (plan §7.2:
  //    "Marketing Admin → HR = DENY").
  const scopes = department?.scopes ?? [];
  if (scopes.length === 0) {
    return ALLOW('unscoped-actor', 'Caller is not restricted to a department');
  }
  const resourceScope = resource.scope;
  if (resourceScope == null || resourceScope === '') {
    // Company-wide resources (shared knowledge, an uncategorised workflow) stay
    // readable by everyone: they belong to no department to be isolated from.
    return ALLOW('unscoped-resource', 'Resource is not department-scoped');
  }
  if (!scopes.some((s) => equalsScope(s, resourceScope))) {
    return DENY(
      'department-scope',
      `${department?.name ?? 'Department'} is limited to [${scopes.join(', ')}]; this ${resource.type} is scoped to ${resourceScope}`,
    );
  }

  return ALLOW('department-scope', 'Resource is within the caller’s department');
}

/**
 * Scope names come from three different enums that overlap by name
 * (`EmployeeRole.MARKETING`, `WorkflowCategory.MARKETING`), and departments are
 * configured by humans. Compare case- and separator-insensitively so
 * `Project Manager`, `PROJECT_MANAGER` and `project-manager` are one scope.
 */
function equalsScope(a: string, b: string): boolean {
  return normalizeScope(a) === normalizeScope(b);
}

export function normalizeScope(value: string): string {
  return value.trim().toUpperCase().replace(/[\s-]+/g, '_');
}
