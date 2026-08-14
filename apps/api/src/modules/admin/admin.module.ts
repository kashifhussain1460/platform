import { BullModule } from '@nestjs/bullmq';
import { Module } from '@nestjs/common';
import { ApprovalsModule } from '../approvals/approvals.module';
import { EventsModule } from '../events/events.module';
import { MarketingModule } from '../engines/marketing/marketing.module';
import { HrModule } from '../hr/hr.module';
import { RetentionModule } from '../retention/retention.module';
import { WorkflowsModule } from '../workflows/workflows.module';
import { AlertDispatchService } from './alert-dispatch.service';
import { CronController } from './cron.controller';
import { DlqController } from './dlq.controller';
import { MetricsController } from './metrics.controller';
import { WORKFLOW_RUN_QUEUE } from '../workflows/workflows.constants';
import {
  WF_NODE_ATTEMPT_QUEUE,
  WF_RUN_ADVANCE_QUEUE,
} from '../workflow-runtime/workflow-runtime.constants';

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
    // WAVE 5 §5.3 — PRODUCER-side registration only, so the metrics controller
    // can ask each queue for its depth at scrape time. Registering a queue name
    // in a second module does not create a second consumer.
    BullModule.registerQueue(
      { name: WORKFLOW_RUN_QUEUE },
      { name: WF_RUN_ADVANCE_QUEUE },
      { name: WF_NODE_ATTEMPT_QUEUE },
    ),
  ],
  controllers: [DlqController, CronController, MetricsController],
  // WAVE 9 — alert evaluation + delivery, shared by `GET /admin/alerts` (the
  // view) and `/admin/cron/alerts` (the thing that actually notifies someone).
  providers: [AlertDispatchService],
})
export class AdminModule {}
