import { Module } from '@nestjs/common';
import { DashboardComposerService } from './dashboard-composer.service';
import { ProductContextController } from './product-context.controller';
import { ProductContextService } from './product-context.service';

/**
 * Capability resolution (Phase 3).
 *
 * A LEAF module on purpose: it depends on the global `PrismaService` and the
 * global `AuthorizationService`, plus two pure code registries
 * (`SkillCapabilities`, `SkillCatalog`, `PLAN_CATALOG`) that carry no DI. It
 * imports no feature module, so it can never participate in a cycle — the same
 * property that makes `AuthorizationModule` safe to inject everywhere.
 *
 * That matters more than it sounds: a "context" service that reached into
 * Employees, Skills, Workflows and Billing to ask each of them a question would
 * end up imported by all of them in turn, and the module graph would be a ring.
 * Reading the rows directly, and the POLICY through the one service that owns
 * it, keeps this a leaf.
 */
@Module({
  controllers: [ProductContextController],
  providers: [ProductContextService, DashboardComposerService],
})
export class ProductContextModule {}
