import {
  BadRequestException,
  Injectable,
  Logger,
  UnauthorizedException,
} from '@nestjs/common';
import { PrismaService } from '../../common/prisma/prisma.service';

/** Safe defaults for a company that has never saved a policy. */
const DEFAULT_PASSWORD_MIN_LENGTH = 8;

export interface EffectiveSecurityPolicy {
  passwordMinLength: number;
  mfaRequired: boolean;
  sessionTimeoutMinutes: number;
  allowedEmailDomains: string[];
  dataRetentionDays: number;
}

/**
 * WAVE 2 §2.4 — makes the stored security policy EXECUTABLE.
 *
 * The plan's rule for this section is the whole reason it exists: *a
 * configuration value must not imply protection unless enforcement exists.*
 * Before this, `SecurityPolicy` had five fields and exactly two of them did
 * anything, in exactly one place (`UsersService.create`):
 *
 * | field | before |
 * |---|---|
 * | `passwordMinLength` | enforced when an admin invites a user — NOT on password reset, so any user could reset to a 1-character password and bypass it |
 * | `allowedEmailDomains` | same |
 * | `sessionTimeoutMinutes` | stored, never read — a company could set 15 minutes and sessions still lived 7 days |
 * | `mfaRequired` | stored, never read — and there is no MFA implementation at all, so the toggle was purely decorative |
 * | `dataRetentionDays` | enforced (HR retention sweep) |
 *
 * A settings screen that reports protection the runtime does not apply is worse
 * than no setting: it converts an open risk into one the customer believes is
 * closed.
 */
@Injectable()
export class SecurityPolicyService {
  private readonly logger = new Logger(SecurityPolicyService.name);

  constructor(private readonly prisma: PrismaService) {}

  async effective(companyId: string): Promise<EffectiveSecurityPolicy> {
    const policy = await this.prisma.securityPolicy.findUnique({
      where: { companyId },
    });
    return {
      passwordMinLength:
        policy?.passwordMinLength ?? DEFAULT_PASSWORD_MIN_LENGTH,
      mfaRequired: policy?.mfaRequired ?? false,
      sessionTimeoutMinutes: policy?.sessionTimeoutMinutes ?? 0,
      allowedEmailDomains: policy?.allowedEmailDomains ?? [],
      dataRetentionDays: policy?.dataRetentionDays ?? 0,
    };
  }

  /**
   * Enforce `passwordMinLength`. Applies to EVERY path that sets a password —
   * invite, reset and change — not just the first one someone remembered.
   */
  async assertPasswordMeetsPolicy(
    companyId: string,
    password: string,
  ): Promise<void> {
    const { passwordMinLength } = await this.effective(companyId);
    if (password.length < passwordMinLength) {
      throw new BadRequestException(
        `Password must be at least ${passwordMinLength} characters`,
      );
    }
  }

  /** Enforce `allowedEmailDomains`. An empty list means "any domain". */
  async assertEmailDomainAllowed(
    companyId: string,
    email: string,
  ): Promise<void> {
    const { allowedEmailDomains } = await this.effective(companyId);
    if (allowedEmailDomains.length === 0) return;
    const domain = email.split('@')[1]?.toLowerCase() ?? '';
    const allowed = allowedEmailDomains.map((d) => d.toLowerCase().trim());
    if (!allowed.includes(domain)) {
      throw new BadRequestException(
        `Email domain must be one of: ${allowedEmailDomains.join(', ')}`,
      );
    }
  }

  /**
   * Enforce `sessionTimeoutMinutes` as an INACTIVITY timeout.
   *
   * Measured from the presented refresh token's `createdAt`. Refresh rotates the
   * token, so that timestamp resets on every use — which makes this "time since
   * the session was last active", the thing an admin actually means by session
   * timeout, rather than a hard cap that logs out a user mid-task.
   *
   * `0` = disabled (the default), so this is inert until configured.
   */
  async assertSessionWithinTimeout(
    companyId: string,
    lastActivityAt: Date,
  ): Promise<void> {
    const { sessionTimeoutMinutes } = await this.effective(companyId);
    if (sessionTimeoutMinutes <= 0) return;
    const idleMs = Date.now() - lastActivityAt.getTime();
    if (idleMs > sessionTimeoutMinutes * 60_000) {
      this.logger.log(
        `session expired by policy company=${companyId} idle=${Math.round(idleMs / 60_000)}m limit=${sessionTimeoutMinutes}m`,
      );
      throw new UnauthorizedException(
        'Session expired due to inactivity — please sign in again',
      );
    }
  }

  /**
   * Refuse to store a setting nothing enforces.
   *
   * `mfaRequired` has no implementation anywhere in the platform: no enrolment,
   * no challenge, no verification. Accepting `true` would tell an admin their
   * company requires MFA when every user can still sign in with a password
   * alone. Rejecting it is the honest behaviour until MFA ships, and it is
   * exactly what §2.4 asks for. Turning it OFF is always allowed.
   */
  assertPolicyIsEnforceable(update: { mfaRequired?: boolean }): void {
    if (update.mfaRequired === true) {
      throw new BadRequestException(
        'MFA is not implemented yet, so it cannot be required. Enabling this ' +
          'would report a protection the platform does not apply.',
      );
    }
  }
}
