import { Module } from '@nestjs/common';
import { MailModule } from '../mail/mail.module';
import { NotificationsService } from './notifications.service';

/**
 * System email notifications (team invites, approvals, account/billing events).
 *
 * A LEAF module: it imports only MailModule (Prisma is global), so any domain
 * module — Users, Approvals, Workflows, Billing, Onboarding — can import it
 * without forming a cycle. Mirrors the ApprovalRoutingModule fork.
 */
@Module({
  imports: [MailModule],
  providers: [NotificationsService],
  exports: [NotificationsService],
})
export class NotificationsModule {}
