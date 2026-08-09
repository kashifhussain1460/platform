import { Module } from '@nestjs/common';
import { MailService } from './mail.service';

/**
 * System transactional email (verification, password reset). SMTP-based, but
 * disabled by default — see MailService. Exported so AuthModule can send OTPs.
 */
@Module({
  providers: [MailService],
  exports: [MailService],
})
export class MailModule {}
