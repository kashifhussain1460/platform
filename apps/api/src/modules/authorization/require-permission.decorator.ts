import { SetMetadata } from '@nestjs/common';
import type { AuthzAction } from './authorization.types';

export const PERMISSION_KEY = 'authz:permission';

/**
 * WAVE 2 §2.2 — declare the CAPABILITY a route needs, not the role.
 *
 * `@Roles('ADMIN')` states an implementation detail: it says who happens to be
 * allowed today, and every future rule change means editing every decorator. A
 * capability states the requirement, and the answer to "who satisfies it" lives
 * in one policy — which is the whole point of §16's "do not scatter role checks".
 *
 * Route-level checks can only cover what is knowable before the handler runs:
 * the actor's role and tenant. A rule that depends on the RESOURCE (its
 * department scope, its owner) needs the row loaded first, so the handler calls
 * `AuthorizationService.assert(...)` with the real resource. The guard is the
 * floor, not the whole policy.
 */
export const RequirePermission = (action: AuthzAction) =>
  SetMetadata(PERMISSION_KEY, action);
