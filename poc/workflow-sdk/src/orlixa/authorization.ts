/**
 * POC ONLY — NOT PRODUCTION.
 *
 * A stand-in for Orlixa's AuthorizationService. The POC's contract is that this
 * check runs on the Orlixa side of the boundary, INSIDE a step, and the Workflow
 * SDK has no way to reach the provider without passing through it.
 */
import { record } from './recorder';

export class AuthorizationDeniedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AuthorizationDeniedError';
  }
}

/** company -> employee -> the skills that employee may use. */
const GRANTS: Record<string, Record<string, string[]>> = {
  'company-poc': {
    'emp-authorized': ['postiz.publish_now', 'gmail.send'],
    'emp-unauthorized': ['gmail.send'],
  },
};

export interface AuthzSubject {
  companyId: string;
  employeeId: string;
  skillTool: string;
}

export function assertAuthorized(subject: AuthzSubject): void {
  const allowed = GRANTS[subject.companyId]?.[subject.employeeId] ?? [];
  const ok = allowed.includes(subject.skillTool);
  record('authz.decision', { ...subject, allowed: ok });
  if (!ok) {
    throw new AuthorizationDeniedError(
      `Employee ${subject.employeeId} is not permitted to use ${subject.skillTool}`,
    );
  }
}
