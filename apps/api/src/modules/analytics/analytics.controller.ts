import { Controller, Get, Query, UseGuards } from '@nestjs/common';
import type {
  ActivityFeedDto,
  EmployeeKpiDto,
  OverviewDto,
} from '@vaep/types';
import { CurrentTenant } from '../auth/decorators/current-tenant.decorator';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import type { AuthenticatedUser } from '../auth/auth.provider';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { AuthorizationGuard } from '../authorization/authorization.guard';
import { RequirePermission } from '../authorization/require-permission.decorator';
import { normalizeRange } from './analytics.constants';
import { AnalyticsService } from './analytics.service';

/**
 * Analytics / KPI dashboard: read-only aggregations over existing data. All
 * routes are tenant-scoped by companyId (from the JWT) and JWT-guarded. The
 * optional `?range=today|7d|30d|all` (default 7d) bounds activity metrics.
 *
 * ## Phase 1 — authorization
 *
 * These routes were JWT-only: no role floor, no department scope, no filtering.
 * Any MEMBER could read per-employee KPI rows for the whole company, including
 * employees `GET /employees` correctly hides from them.
 *
 * `@RequirePermission('employee:read')` supplies the role floor through the
 * SAME policy the roster uses, and the acting user is now threaded into the
 * service so every aggregate is bounded by what that user may actually see.
 * Two layers on purpose: the guard rejects a caller who may read no employee at
 * all, the service scopes the caller who may read some.
 */
@Controller('analytics')
@UseGuards(JwtAuthGuard, AuthorizationGuard)
export class AnalyticsController {
  constructor(private readonly analytics: AnalyticsService) {}

  /** Company-wide KPIs (raw counts + illustrative derived estimates). */
  @Get('overview')
  @RequirePermission('employee:read')
  overview(
    @CurrentTenant() companyId: string,
    @CurrentUser() user: AuthenticatedUser,
    @Query('range') range?: string,
  ): Promise<OverviewDto> {
    return this.analytics.overview(companyId, normalizeRange(range), user.userId);
  }

  /** Per-employee KPI rows. */
  @Get('employees')
  @RequirePermission('employee:read')
  employees(
    @CurrentTenant() companyId: string,
    @CurrentUser() user: AuthenticatedUser,
    @Query('range') range?: string,
  ): Promise<EmployeeKpiDto[]> {
    return this.analytics.employees(companyId, normalizeRange(range), user.userId);
  }

  /** "Today's AI Activity" feed: per-employee grouped skill/tool + message counts. */
  @Get('activity')
  @RequirePermission('employee:read')
  activity(
    @CurrentTenant() companyId: string,
    @CurrentUser() user: AuthenticatedUser,
    @Query('range') range?: string,
  ): Promise<ActivityFeedDto[]> {
    return this.analytics.activity(companyId, normalizeRange(range), user.userId);
  }
}
