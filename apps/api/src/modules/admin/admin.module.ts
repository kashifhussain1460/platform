import { Module } from '@nestjs/common';
import { ApprovalsModule } from '../approvals/approvals.module';
import { EventsModule } from '../events/events.module';
import { MarketingModule } from '../engines/marketing/marketing.module';
import { HrModule } from '../hr/hr.module';
import { WorkflowsModule } from '../workflows/workflows.module';
import { CronController } from './cron.controller';
import { DlqController } from './dlq.controller';

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
  imports: [WorkflowsModule, ApprovalsModule, HrModule, EventsModule, MarketingModule],
  controllers: [DlqController, CronController],
})
export class AdminModule {}
