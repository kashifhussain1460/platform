import { Module } from '@nestjs/common';
import { ApprovalRoutingModule } from '../approval-routing/approval-routing.module';
import { NotificationsModule } from '../notifications/notifications.module';
import { HandoffController } from './handoff.controller';
import { HandoffService } from './handoff.service';

/**
 * S-13/C-06 — see handoff.service.ts's doc comment for why this module
 * imports only the two already-dependency-light forks (ApprovalRoutingModule,
 * NotificationsModule) and nothing that could reopen a cycle with
 * EmployeesModule/SkillsModule.
 */
@Module({
  imports: [ApprovalRoutingModule, NotificationsModule],
  controllers: [HandoffController],
  providers: [HandoffService],
  exports: [HandoffService],
})
export class HandoffModule {}
