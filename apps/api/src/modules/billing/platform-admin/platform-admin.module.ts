import { Module } from '@nestjs/common';
import { JwtModule } from '@nestjs/jwt';
import { PlatformAdminAuthService } from './platform-admin-auth.service';
import { PlatformAdminGuard } from './platform-admin.guard';

/**
 * Credit system Phase 10 — every `/internal/platform-admin/*` controller
 * (manual adjustments, reconciliation views, finance reporting, the
 * enforcement-cohort surface) imports this module for the shared guard.
 * `JwtModule.register({})` mirrors `AuthModule`'s own registration — the
 * actual secret is read per-call from `ConfigService`, never baked into
 * module options, so it can differ from the company `JWT_ACCESS_SECRET`
 * without any risk of the two being confused at the module-wiring level.
 */
@Module({
  imports: [JwtModule.register({})],
  providers: [PlatformAdminAuthService, PlatformAdminGuard],
  exports: [PlatformAdminAuthService, PlatformAdminGuard],
})
export class PlatformAdminModule {}
