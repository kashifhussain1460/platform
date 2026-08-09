import { Injectable, Logger } from '@nestjs/common';
import type { HrRetentionResultDto } from '@vaep/types';
import { PrismaService } from '../../common/prisma/prisma.service';

const MS_PER_DAY = 24 * 60 * 60 * 1000;

/**
 * HR data retention (P3-01 DoD: "retention honours dataRetentionDays").
 *
 * For every company whose SecurityPolicy sets a positive `dataRetentionDays`, we
 * delete operational HR satellite records (leave, attendance, documents, reviews,
 * onboarding tasks) whose `createdAt` is older than the cut-off. `dataRetentionDays
 * = 0` (the default) means "keep forever" and is skipped.
 *
 * We deliberately do NOT delete the StaffMember roster itself: a person record is
 * a deliberate HR/legal decision (and cascades every satellite), not something a
 * blanket time-based sweep should remove. The sweep prunes transactional records
 * only. Scheduling is handled by HrRetentionProcessor (daily BullMQ repeatable).
 */
@Injectable()
export class HrRetentionService {
  private readonly logger = new Logger(HrRetentionService.name);

  constructor(private readonly prisma: PrismaService) {}

  async runRetention(asOf: Date): Promise<HrRetentionResultDto> {
    const policies = await this.prisma.securityPolicy.findMany({
      where: { dataRetentionDays: { gt: 0 } },
      select: { companyId: true, dataRetentionDays: true },
    });

    const deleted = {
      leaveRequests: 0,
      attendanceRecords: 0,
      staffDocuments: 0,
      performanceReviews: 0,
      onboardingTasks: 0,
    };

    for (const policy of policies) {
      const cutoff = new Date(asOf.getTime() - policy.dataRetentionDays * MS_PER_DAY);
      const where = { companyId: policy.companyId, createdAt: { lt: cutoff } };

      const [leave, attendance, documents, reviews, onboarding] =
        await this.prisma.$transaction([
          this.prisma.leaveRequest.deleteMany({ where }),
          this.prisma.attendanceRecord.deleteMany({ where }),
          this.prisma.staffDocument.deleteMany({ where }),
          this.prisma.performanceReview.deleteMany({ where }),
          this.prisma.onboardingTask.deleteMany({ where }),
        ]);

      deleted.leaveRequests += leave.count;
      deleted.attendanceRecords += attendance.count;
      deleted.staffDocuments += documents.count;
      deleted.performanceReviews += reviews.count;
      deleted.onboardingTasks += onboarding.count;

      const companyTotal =
        leave.count +
        attendance.count +
        documents.count +
        reviews.count +
        onboarding.count;
      if (companyTotal > 0) {
        this.logger.log(
          `hr.retention company=${policy.companyId} days=${policy.dataRetentionDays} ` +
            `cutoff=${cutoff.toISOString()} deleted=${companyTotal} ` +
            `(leave=${leave.count} attendance=${attendance.count} docs=${documents.count} ` +
            `reviews=${reviews.count} onboarding=${onboarding.count})`,
        );
      }
    }

    const total =
      deleted.leaveRequests +
      deleted.attendanceRecords +
      deleted.staffDocuments +
      deleted.performanceReviews +
      deleted.onboardingTasks;
    this.logger.log(
      `hr.retention sweep complete companies=${policies.length} deleted=${total}`,
    );

    return {
      ranAt: asOf.toISOString(),
      companiesProcessed: policies.length,
      deleted,
    };
  }
}
