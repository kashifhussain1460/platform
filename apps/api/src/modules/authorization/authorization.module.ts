import { Global, Module } from '@nestjs/common';
import { AuthorizationGuard } from './authorization.guard';
import { AuthorizationService } from './authorization.service';
import { SecurityPolicyService } from './security-policy.service';

/**
 * WAVE 2 §2.2 / §16 — the single authorization layer.
 *
 * `@Global` so every module can inject `AuthorizationService` without adding an
 * import edge. Authorization is genuinely cross-cutting, and the alternative —
 * each of ~15 feature modules importing it — is a lot of new edges for a service
 * that depends on nothing but Prisma. Being a true leaf is what makes that safe:
 * it can never participate in a cycle.
 */
@Global()
@Module({
  providers: [AuthorizationService, AuthorizationGuard, SecurityPolicyService],
  exports: [AuthorizationService, AuthorizationGuard, SecurityPolicyService],
})
export class AuthorizationModule {}
