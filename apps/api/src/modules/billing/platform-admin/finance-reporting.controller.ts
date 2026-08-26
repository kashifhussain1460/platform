import { Controller, Get, Query, UseGuards } from '@nestjs/common';
import { CreditRollupService, type DailyRollupRow } from '../../credits/credit-rollup.service';
import { PlatformAdminGuard } from './platform-admin.guard';

/**
 * Credit system Phase 10, Task 10.4 (§24/§27) — the first genuinely
 * cross-tenant read surface in this codebase. `PlatformAdminGuard`-only,
 * never a company role (§32.2) — queries ONLY the pre-aggregated
 * `CreditUsageDailyRollup` table, never the raw ledger, for cross-tenant
 * scans (§24.3's scale reasoning: an unindexed cross-tenant `GROUP BY` over
 * the raw ledger is exactly the query shape that gets slow first).
 *
 * §24.4's caveat applies to every figure returned here: "credits consumed"
 * is real, but any USD/margin figure derived from it downstream is only as
 * real as `usage-rates.ts`'s flat illustrative rate — this endpoint returns
 * credits, not dollars, so that caveat lives in the client that converts,
 * not silently inside this response.
 */
@Controller('internal/platform-admin/finance')
@UseGuards(PlatformAdminGuard)
export class FinanceReportingController {
  constructor(private readonly rollup: CreditRollupService) {}

  @Get('rollup')
  async rollupReport(
    @Query('since') since?: string,
    @Query('until') until?: string,
    @Query('companyId') companyId?: string,
  ): Promise<{ rows: DailyRollupRow[]; note: string }> {
    const rows = await this.rollup.query({
      since: since ? new Date(since) : undefined,
      until: until ? new Date(until) : undefined,
      companyId,
    });
    return {
      rows,
      note: 'Credits are exact; any USD/margin figure derived from these is estimated (illustrative flat per-token rate), not an exact bill or invoiced cost.',
    };
  }
}
