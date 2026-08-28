import { MiddlewareConsumer, Module, NestModule } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { ThrottlerModule } from '@nestjs/throttler';
import { AppConfigModule } from './config/config.module';
import { PrismaModule } from './common/prisma/prisma.module';
import { CryptoModule } from './common/crypto/crypto.module';
import { ResilienceModule } from './common/resilience/resilience.module';
import { TenantAwareThrottlerGuard } from './common/resilience/tenant-throttler.guard';
import { ExecutionContextMiddleware } from './common/observability/execution-context.middleware';
import { ObservabilityModule } from './common/observability/observability.module';
import { AuthorizationModule } from './modules/authorization/authorization.module';
import { AuditModule } from './modules/audit/audit.module';
import { UsageModule } from './modules/usage/usage.module';
import { AuthModule } from './modules/auth/auth.module';
import { AdminModule } from './modules/admin/admin.module';
import { UsersModule } from './modules/users/users.module';
import { TenantModule } from './modules/tenant/tenant.module';
import { KnowledgeModule } from './modules/knowledge/knowledge.module';
import { EmployeesModule } from './modules/employees/employees.module';
import { OnboardingModule } from './modules/onboarding/onboarding.module';
import { HandoffModule } from './modules/handoff/handoff.module';
import { SkillsModule } from './modules/skills/skills.module';
import { MarketingModule } from './modules/engines/marketing/marketing.module';
import { MarketingWorkspaceModule } from './modules/marketing/marketing-workspace.module';
import { SupportModule } from './modules/engines/support/support.module';
import { PmModule } from './modules/engines/pm/pm.module';
import { WorkflowsModule } from './modules/workflows/workflows.module';
import { WorkflowRuntimeModule } from './modules/workflow-runtime/workflow-runtime.module';
import { EventsModule } from './modules/events/events.module';
import { ApprovalsModule } from './modules/approvals/approvals.module';
import { AnalyticsModule } from './modules/analytics/analytics.module';
import { BillingModule } from './modules/billing/billing.module';
import { CreditsModule } from './modules/credits/credits.module';
import { MarketplaceModule } from './modules/marketplace/marketplace.module';
import { AssistModule } from './modules/assist/assist.module';
import { WorkflowTemplatesModule } from './modules/workflow-templates/workflow-templates.module';
import { OrganizationModule } from './modules/organization/organization.module';
import { ProductContextModule } from './modules/product-context/product-context.module';
import { SchedulingModule } from './modules/scheduling/scheduling.module';
import { HrModule } from './modules/hr/hr.module';
import { RetentionModule } from './modules/retention/retention.module';
import { HealthModule } from './modules/health/health.module';

@Module({
  imports: [
    AppConfigModule,
    HealthModule,
    // Global safety-net rate limit (docs status audit §3: no rate limiting
    // existed anywhere). Generous default so normal use/tests are unaffected;
    // specific cost-sensitive endpoints (auth login/register, AI workflow
    // generation) carry their own tighter @Throttle() override.
    ThrottlerModule.forRoot([{ name: 'default', ttl: 60_000, limit: 300 }]),
    PrismaModule,
    CryptoModule,
    ResilienceModule,
    // WAVE 5 §5.1/§5.3 — execution context + metrics (global leaf).
    ObservabilityModule,
    // WAVE 2 §2.2 — global leaf: the single authorization layer.
    AuthorizationModule,
    AuditModule,
    UsageModule,
    AuthModule,
    UsersModule,
    TenantModule,
    KnowledgeModule,
    EmployeesModule,
    OnboardingModule,
    HandoffModule,
    SchedulingModule,
    SkillsModule,
    MarketingModule,
    MarketingWorkspaceModule,
    SupportModule,
    PmModule,
    WorkflowsModule,
    WorkflowRuntimeModule,
    EventsModule,
    ApprovalsModule,
    AnalyticsModule,
    BillingModule,
    CreditsModule,
    MarketplaceModule,
    WorkflowTemplatesModule,
    AssistModule,
    OrganizationModule,
    ProductContextModule,
    HrModule,
    RetentionModule,
    AdminModule,
  ],
  providers: [{ provide: APP_GUARD, useClass: TenantAwareThrottlerGuard }],
})
export class AppModule implements NestModule {
  /**
   * WAVE 5 §5.1 — every route runs inside an execution context, so a log line,
   * an audit entry and a metric emitted anywhere downstream share one request
   * and trace id.
   */
  configure(consumer: MiddlewareConsumer): void {
    consumer.apply(ExecutionContextMiddleware).forRoutes('*');
  }
}
