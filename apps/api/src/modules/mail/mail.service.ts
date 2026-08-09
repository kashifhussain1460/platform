import { randomInt } from 'node:crypto';
import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

/**
 * Transactional email for system messages (verification, password reset).
 *
 * SMTP-based, but **disabled by default** (`MAIL_ENABLED` unset/`false`): while
 * disabled, `send` logs instead of delivering, and OTPs are the FIXED dev code
 * (`DEV_OTP_CODE`, default `123456`) so the verify flow works end-to-end without
 * a live mailbox. Flip `MAIL_ENABLED=true` + set `SMTP_*` to send for real —
 * `nodemailer` is imported lazily so the disabled path (and tests) never load it.
 *
 * This mirrors the codebase's swappable-provider convention (LLM/BILLING/STORAGE):
 * a real, deterministic dev implementation, not a stub.
 */
@Injectable()
export class MailService {
  private readonly logger = new Logger(MailService.name);

  constructor(private readonly config: ConfigService) {}

  /** True only when the operator has explicitly turned real sending on. */
  enabled(): boolean {
    return this.config.get<string>('MAIL_ENABLED') === 'true';
  }

  /**
   * The one-time code. While mail is disabled this is the fixed dev OTP so a
   * developer/tester can verify without an inbox; when enabled it is a
   * cryptographically-random 6-digit code. NEVER store this plaintext — the
   * caller hashes it.
   */
  generateOtp(): string {
    if (!this.enabled()) {
      return this.config.get<string>('DEV_OTP_CODE') || '123456';
    }
    return String(randomInt(0, 1_000_000)).padStart(6, '0');
  }

  async sendVerificationOtp(to: string, code: string): Promise<void> {
    await this.send(
      to,
      'Verify your Orlixa account',
      `Your Orlixa verification code is ${code}. It expires in 15 minutes. ` +
        `If you didn't create an account you can ignore this email.`,
    );
  }

  /** OTP-based password recovery code. Fixed dev OTP + no-op while disabled. */
  async sendPasswordResetOtp(to: string, code: string): Promise<void> {
    await this.send(
      to,
      'Your Orlixa password reset code',
      `Your Orlixa password reset code is ${code}. It expires in 15 minutes. ` +
        `If you didn't request this, you can safely ignore this email.`,
    );
  }

  async sendPasswordReset(to: string, link: string): Promise<void> {
    // Unlike the fixed OTP, the reset token is random — so while mail is
    // disabled we surface the link in the logs (dev only) so a developer can
    // still complete the flow. Never do this when mail is actually enabled.
    if (!this.enabled()) {
      this.logger.warn(`mail disabled — password-reset link (dev only): ${link}`);
      return;
    }
    await this.send(
      to,
      'Reset your Orlixa password',
      `Reset your password using this link (valid for 1 hour): ${link}. ` +
        `If you didn't request this, you can ignore this email.`,
    );
  }

  /** Security notice after a successful password reset. Safe no-op when disabled. */
  async sendPasswordChanged(to: string): Promise<void> {
    await this.send(
      to,
      'Your Orlixa password was changed',
      `Your Orlixa password was just changed. If this was you, no action is needed. ` +
        `If it wasn't, reset your password immediately and contact an administrator.`,
    );
  }

  async send(to: string, subject: string, text: string): Promise<void> {
    if (!this.enabled()) {
      // Disabled: do NOT deliver, and do NOT log the code/body (avoids leaking
      // even a dev OTP into shared logs) — just record that a send was skipped.
      this.logger.warn(`mail disabled — skipped send to=${to} subject="${subject}"`);
      return;
    }
    // Lazy import: only loaded when real sending is on, so the default/test path
    // has no nodemailer dependency at all.
    const nodemailer = (await import('nodemailer')) as typeof import('nodemailer');
    const transport = nodemailer.createTransport({
      host: this.config.getOrThrow<string>('SMTP_HOST'),
      port: Number(this.config.get<string>('SMTP_PORT') ?? '587'),
      secure: this.config.get<string>('SMTP_SECURE') === 'true',
      auth: {
        user: this.config.getOrThrow<string>('SMTP_USER'),
        pass: this.config.getOrThrow<string>('SMTP_PASS'),
      },
    });
    await transport.sendMail({
      from: this.config.get<string>('MAIL_FROM') ?? 'Orlixa <no-reply@orlixa.com>',
      to,
      subject,
      text,
    });
    this.logger.log(`mail sent to=${to} subject="${subject}"`);
  }
}
