import { Module } from '@nestjs/common';
import { EmployeesModule } from '../employees/employees.module';
import { NotificationsModule } from '../notifications/notifications.module';
import { CreditsModule } from '../credits/credits.module';
import { OnboardingController } from './onboarding.controller';
import { OnboardingService } from './onboarding.service';

/**
 * Onboarding module. Imports EmployeesModule so the wizard can hire AI
 * employees by reusing EmployeesService.create (single source of truth for
 * employee creation). PrismaService is global. CreditsModule (Phase 4,
 * Task 4.4 — the onboarding-complete free-credit grant) is imported
 * directly rather than relied on via EmployeesModule's own import, since
 * EmployeesModule does not re-export it.
 */
@Module({
  imports: [EmployeesModule, NotificationsModule, CreditsModule],
  controllers: [OnboardingController],
  providers: [OnboardingService],
})
export class OnboardingModule {}
