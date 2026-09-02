import {
  Controller,
  Delete,
  Get,
  HttpCode,
  Param,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import type {
  ConnectorCircuitDto,
  DlqJobDto,
  DlqSummaryEntryDto,
} from '@vaep/types';
import { PrismaService } from '../../common/prisma/prisma.service';
import { CircuitBreakerRegistry } from '../../common/resilience/circuit-breaker.registry';
import { DlqService } from '../../common/resilience/dlq.service';
import { queueWorkersEnabled } from '../../common/resilience/queue-workers';
import { workflowExecutionMode } from '../../common/resilience/workflow-execution-mode';
import { EngineModeService } from '../workflow-runtime/engine-mode';
import { PLATFORM_SWEEPS } from './sweeps/platform-sweeps.constants';
import { CurrentTenant } from '../auth/decorators/current-tenant.decorator';
import { Roles } from '../auth/decorators/roles.decorator';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { RolesGuard } from '../auth/roles.guard';

/**
 * Admin resilience surface (Unit C, docs §4.4/§9). OWNER/ADMIN only, and every
 * result is tenant-scoped to the caller's companyId (the DlqService filters
 * failed jobs by payload companyId; the circuit view lists only the company's
 * own connectors). MEMBERs get 403; unauthenticated callers 401.
 */
@Controller('admin')
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles('OWNER', 'ADMIN')
export class DlqController {
  constructor(
    private readonly dlq: DlqService,
    private readonly breakers: CircuitBreakerRegistry,
    private readonly prisma: PrismaService,
    private readonly engineMode: EngineModeService,
  ) {}

  /**
   * What this process is ACTUALLY doing, as opposed to what it was configured
   * to do.
   *
   * ## Why this endpoint exists
   *
   * `EngineModeService.isDurableActive()` was written for exactly this — its own
   * doc comment says *"exposed so health/status surfaces can report the truth
   * rather than the intent"* — and then nothing ever called it. The 2026-09-02
   * audit found the consequence: `WORKFLOW_ENGINE_MODE=state_machine` looks like
   * durable execution, but `WORKFLOW_EXECUTION_MODE=inline` silently forces
   * every run onto the legacy walker, and the only signal was one ERROR line in
   * a boot log nobody reads.
   *
   * `durableExecution` is the single field to check after deploying a worker.
   * If it is `false`, there is no crash recovery in this process no matter what
   * the environment variables say.
   *
   * OWNER/ADMIN only (inherited from the controller): it reports deployment
   * shape, not tenant data, but it is still operational detail.
   */
  @Get('runtime')
  runtime(): {
    executionMode: 'queue' | 'inline';
    queueWorkersEnabled: boolean;
    engineMode: 'legacy_walk' | 'state_machine';
    durableExecution: boolean;
    scheduledSweeps: { driver: 'bullmq' | 'http-cron'; jobs: number };
    warnings: string[];
  } {
    const executionMode = workflowExecutionMode();
    const workers = queueWorkersEnabled();
    const durable = this.engineMode.isDurableActive();
    const warnings: string[] = [];

    if (!durable) {
      warnings.push(
        executionMode === 'inline'
          ? 'WORKFLOW_EXECUTION_MODE=inline forces every run onto the legacy walker: ' +
            'no attempts, no leases, no automatic recovery. Deploy an always-on worker ' +
            'with QUEUE_WORKERS_ENABLED and WORKFLOW_EXECUTION_MODE=queue.'
          : 'WORKFLOW_ENGINE_MODE is legacy_walk, so durable execution is off for this process.',
      );
    }
    if (!workers) {
      warnings.push(
        `QUEUE_WORKERS_ENABLED is off, so the ${PLATFORM_SWEEPS.length} platform sweeps ` +
          '(alerts, retention, credit renewal and reconciliation) only run if something ' +
          'is calling /admin/cron/* on a schedule. Verify your scheduler.',
      );
    }

    return {
      executionMode,
      queueWorkersEnabled: workers,
      engineMode: durable ? 'state_machine' : 'legacy_walk',
      durableExecution: durable,
      scheduledSweeps: {
        driver: workers ? 'bullmq' : 'http-cron',
        jobs: PLATFORM_SWEEPS.length,
      },
      warnings,
    };
  }

  /**
   * Per-queue failed-job counts for the company (alert-friendly monitoring).
   * Declared before `GET /dlq` so the static `summary` segment matches first.
   */
  @Get('dlq/summary')
  summary(
    @CurrentTenant() companyId: string,
  ): Promise<DlqSummaryEntryDto[]> {
    return this.dlq.summary(companyId);
  }

  /** Dead-lettered (failed) jobs for the company, optionally for one queue. */
  @Get('dlq')
  list(
    @CurrentTenant() companyId: string,
    @Query('queue') queue?: string,
    @Query('limit') limit?: string,
  ): Promise<DlqJobDto[]> {
    const parsed = limit == null ? undefined : Number(limit);
    return this.dlq.list(companyId, queue || undefined, parsed);
  }

  /** Re-enqueue (retry) a dead-lettered job owned by the company. */
  @Post('dlq/:queue/:jobId/replay')
  @HttpCode(200)
  replay(
    @CurrentTenant() companyId: string,
    @Param('queue') queue: string,
    @Param('jobId') jobId: string,
  ) {
    return this.dlq.replay(companyId, queue, jobId);
  }

  /** Permanently discard a dead-lettered job owned by the company. */
  @Delete('dlq/:queue/:jobId')
  @HttpCode(200)
  discard(
    @CurrentTenant() companyId: string,
    @Param('queue') queue: string,
    @Param('jobId') jobId: string,
  ) {
    return this.dlq.discard(companyId, queue, jobId);
  }

  /**
   * Circuit-breaker state for each of the company's connectors (InstalledSkills).
   * Read-only; reflects an elapsed cooldown as HALF_OPEN. Light panel data.
   */
  @Get('circuit')
  async circuits(
    @CurrentTenant() companyId: string,
  ): Promise<ConnectorCircuitDto[]> {
    const connectors = await this.prisma.installedSkill.findMany({
      where: { companyId },
      select: { id: true, skillKey: true },
      orderBy: { createdAt: 'asc' },
    });
    return Promise.all(
      connectors.map(async (c) => ({
        connectorId: c.id,
        skillKey: c.skillKey,
        state: await this.breakers.getState(c.id),
      })),
    );
  }
}
