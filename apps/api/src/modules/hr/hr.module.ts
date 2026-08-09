import { BullModule } from '@nestjs/bullmq';
import { Module } from '@nestjs/common';
import { queueWorkersEnabled } from '../../common/resilience/queue-workers';
import { HR_RETENTION_QUEUE } from './hr.constants';
import { HrRetentionController } from './hr-retention.controller';
import { HrRetentionProcessor } from './hr-retention.processor';
import { HrRetentionService } from './hr-retention.service';
import { LeaveController } from './leave.controller';
import { LeaveService } from './leave.service';
import { PerformanceReviewController } from './performance-review.controller';
import { PerformanceReviewService } from './performance-review.service';
import { StaffController } from './staff.controller';
import { StaffDocumentController } from './staff-document.controller';
import { StaffDocumentService } from './staff-document.service';
import {
  AttendanceController,
  OnboardingController,
} from './staff-satellites.controller';
import { StaffService } from './staff.service';

/**
 * HR staff-records module (Wave P3-01). Tenant-scoped CRUD over the 6 HR models,
 * with special-category / personal PII encrypted at rest via the global
 * CryptoService and a daily data-retention sweep honouring
 * SecurityPolicy.dataRetentionDays.
 *
 * PrismaService, CryptoService and AuditLogService are all @Global singletons, so
 * only the retention BullMQ queue needs registering here. The retention worker is
 * only instantiated when queue workers are enabled (skipped on the Vercel
 * serverless entry — same gate as WorkflowProcessor).
 */
@Module({
  imports: [BullModule.registerQueue({ name: HR_RETENTION_QUEUE })],
  controllers: [
    StaffController,
    AttendanceController,
    OnboardingController,
    LeaveController,
    StaffDocumentController,
    PerformanceReviewController,
    HrRetentionController,
  ],
  providers: [
    StaffService,
    LeaveService,
    StaffDocumentService,
    PerformanceReviewService,
    HrRetentionService,
    ...(queueWorkersEnabled() ? [HrRetentionProcessor] : []),
  ],
  exports: [
    StaffService,
    LeaveService,
    StaffDocumentService,
    PerformanceReviewService,
    HrRetentionService,
  ],
})
export class HrModule {}
