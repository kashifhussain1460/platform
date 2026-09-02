import { BullModule } from '@nestjs/bullmq';
import { Module } from '@nestjs/common';
import { queueWorkersEnabled } from '../../common/resilience/queue-workers';
import { ApprovalsModule } from '../approvals/approvals.module';
import { EventsModule } from '../events/events.module';
import { MarketingModule } from '../engines/marketing/marketing.module';
import { MarketingWorkspaceModule } from '../marketing/marketing-workspace.module';
import { HrModule } from '../hr/hr.module';
import { RetentionModule } from '../retention/retention.module';
import { WorkflowsModule } from '../workflows/workflows.module';
import { CreditsModule } from '../credits/credits.module';
import { EngineModeModule } from '../workflow-runtime/engine-mode.module';
import { AlertDispatchService } from './alert-dispatch.service';
import { CronController } from './cron.controller';
import { DlqController } from './dlq.controller';
import { MetricsController } from './metrics.controller';
import { WORKFLOW_RUN_QUEUE } from '../workflows/workflows.constants';
import {
  WF_NODE_ATTEMPT_QUEUE,
  WF_RUN_ADVANCE_QUEUE,
} from '../workflow-runtime/workflow-runtime.constants';
import { CREDIT_RESERVATION_SWEEP_QUEUE } from '../credits/credit-reservation-sweep.constants';
import { PLATFORM_SWEEPS_QUEUE } from './sweeps/platform-sweeps.constants';
import { PlatformSweepsProcessor } from './sweeps/platform-sweeps.processor';
import { PlatformSweepsService } from './sweeps/platform-sweeps.service';

/**
 * Admin module (Unit C): the OWNER/ADMIN resilience surface — DLQ list/replay/
 * discard + connector circuit-breaker states. The services it uses (DlqService,
 * CircuitBreakerRegistry) come from the global ResilienceModule; PrismaService
 * from the global PrismaModule. No providers of its own — just the controller.
 */
@Module({
  // CronController drives the sweeps that are normally BullMQ repeatables, so it
  // needs the services those repeatables call. All three modules already export
  // them; nothing here is a new provider.
  imports: [
    WorkflowsModule,
    ApprovalsModule,
    HrModule,
    RetentionModule,
    EventsModule,
    MarketingModule,
    // The tenant-facing workspace, for CampaignGenerationService — the cron
    // route is the ONLY thing that advances Marketing AI generation on a
    // serverless deployment, where no worker exists.
    MarketingWorkspaceModule,
    CreditsModule,
    // For `GET /admin/runtime`: the truth about whether durable execution is
    // actually on in THIS process. A true leaf module (ConfigService only).
    EngineModeModule,
    // WAVE 5 §5.3 — PRODUCER-side registration only, so the metrics controller
    // can ask each queue for its depth at scrape time. Registering a queue name
    // in a second module does not create a second consumer.
    BullModule.registerQueue(
      { name: WORKFLOW_RUN_QUEUE },
      { name: WF_RUN_ADVANCE_QUEUE },
      { name: WF_NODE_ATTEMPT_QUEUE },
      { name: CREDIT_RESERVATION_SWEEP_QUEUE },
      // Owned here (consumer + producer), unlike the four above which are
      // producer-side registrations for the metrics controller's depth probe.
      { name: PLATFORM_SWEEPS_QUEUE },
    ),
  ],
  controllers: [DlqController, CronController, MetricsController],
  providers: [
    // WAVE 9 — alert evaluation + delivery, shared by `GET /admin/alerts` (the
    // view) and the alerts sweep (the thing that actually notifies someone).
    AlertDispatchService,
    // The eight periodic sweeps with no queue of their own, behind one
    // implementation. `CronController` drives them over HTTP (serverless, or a
    // manual ops run); `PlatformSweepsProcessor` drives them as BullMQ
    // repeatables wherever a worker exists.
    PlatformSweepsService,
    ...(queueWorkersEnabled() ? [PlatformSweepsProcessor] : []),
  ],
})
export class AdminModule {}
