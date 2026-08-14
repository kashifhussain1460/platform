import { Controller, Get, Post, UseGuards } from '@nestjs/common';
import { CurrentTenant } from '../auth/decorators/current-tenant.decorator';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { Roles } from '../auth/decorators/roles.decorator';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { RolesGuard } from '../auth/roles.guard';
import type { AuthenticatedUser } from '../auth/auth.provider';
import { DataRetentionService, type RetentionResult } from './data-retention.service';

/**
 * WAVE 8 §8.3 — the manual half of retention.
 *
 * Scheduled deletion runs from `/admin/cron/data-retention`. This is for the
 * two things a person needs: seeing what the policy would remove before it
 * removes it, and running it now (after shortening a window, or to satisfy an
 * erasure request without waiting for tonight's sweep).
 *
 * OWNER/ADMIN only, and company-scoped from the JWT — deleting a tenant's
 * operational history is not a member-level action, and no caller may name a
 * company other than their own.
 */
@Controller('retention')
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles('OWNER', 'ADMIN')
export class RetentionController {
  constructor(private readonly retention: DataRetentionService) {}

  /**
   * What tonight's sweep would delete. Deletes nothing.
   *
   * A retention window is agreed as a sentence ("keep 90 days") and lands as a
   * number of rows. Seeing the number first is the difference between a policy
   * decision and a surprise.
   */
  @Get('preview')
  preview(@CurrentTenant() companyId: string): Promise<RetentionResult> {
    return this.retention.preview(companyId);
  }

  /** Apply the policy now, for this company only. Audited as a USER action. */
  @Post('run-now')
  runNow(
    @CurrentTenant() companyId: string,
    @CurrentUser() user: AuthenticatedUser,
  ): Promise<RetentionResult> {
    return this.retention.runForCompany(companyId, user.userId);
  }
}
