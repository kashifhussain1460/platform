import {
  BadRequestException,
  ConflictException,
  Inject,
  Injectable,
  Logger,
  UnauthorizedException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createHash, randomBytes } from 'node:crypto';
import type { Company, User } from '@prisma/client';
import type {
  AuthResponse,
  CompanyDto,
  MeDto,
  UserDto,
} from '@vaep/types';
import { PrismaService } from '../../common/prisma/prisma.service';
import { BillingService } from '../billing/billing.service';
import { MailService } from '../mail/mail.service';
import { AuditLogService } from '../audit/audit-log.service';
import {
  AUTH_PROVIDER,
  type AuthProvider,
  type JwtPayload,
} from './auth.provider';
import { LoginDto } from './dto/login.dto';
import { RegisterDto } from './dto/register.dto';

/** How long an OTP is valid, and the minimum gap between resends. */
const VERIFICATION_TTL_MS = 15 * 60_000;
const RESEND_COOLDOWN_MS = 60_000;
const RESET_TTL_MS = 60 * 60_000; // 1 hour
const PASSWORD_RESET_OTP_TTL_MS = 15 * 60_000; // 15 minutes
// Matches the refresh JWT's default 7d life; the JWT expiry is the hard gate,
// this row's expiry just lets a sweep prune revoked/expired rows later.
const REFRESH_TOKEN_TTL_MS = 7 * 24 * 60 * 60_000;

/** SHA-256 of a 256-bit random token — safe for O(1) lookup (no rainbow risk). */
function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

/** Result bundle: the JSON body plus the refresh token the controller cookies. */
export interface AuthOutcome {
  response: AuthResponse;
  refreshToken: string;
}

/**
 * Email is unique per-COMPANY, not globally, so one address can legitimately
 * exist in several tenants. Bound how many candidates we password-check on a
 * login attempt: each check is a deliberately slow hash, so an unbounded loop
 * would be a cheap CPU-exhaustion vector for anyone able to register.
 */
const MAX_LOGIN_CANDIDATES = 5;

/**
 * Emails are stored and compared lowercased. Postgres unique indexes are
 * case-SENSITIVE, so without this "Alice@x.com" and "alice@x.com" would create
 * two separate accounts in the same company and each could only be logged into
 * with the exact casing used at signup.
 */
function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

@Injectable()
export class AuthService {
  private readonly logger = new Logger(AuthService.name);

  constructor(
    private readonly prisma: PrismaService,
    @Inject(AUTH_PROVIDER) private readonly auth: AuthProvider,
    private readonly billing: BillingService,
    private readonly mail: MailService,
    private readonly audit: AuditLogService,
    private readonly config: ConfigService,
  ) {}

  /** Register creates the Company + owner User atomically, then issues tokens. */
  async register(dto: RegisterDto): Promise<AuthOutcome> {
    const email = normalizeEmail(dto.email);
    this.logger.log(`register: start companyName="${dto.companyName}" email="${email}"`);

    const slug = await this.uniqueSlug(dto.companyName);
    this.logger.log(`register: slug resolved slug="${slug}"`);

    const passwordHash = await this.auth.hash(dto.password);
    this.logger.log('register: password hashed');

    const { company, user } = await this.prisma.$transaction(async (tx) => {
      const company = await tx.company.create({
        data: {
          name: dto.companyName,
          slug,
          industry: dto.industry ?? null,
          size: dto.size ?? null,
          country: dto.country ?? null,
          timezone: dto.timezone ?? null,
          website: dto.website ?? null,
          logoUrl: dto.logoUrl ?? null,
          description: dto.description ?? null,
        },
      });
      const user = await tx.user.create({
        data: {
          companyId: company.id,
          email,
          name: dto.name,
          phone: dto.phone ?? null,
          passwordHash,
          role: 'OWNER',
        },
      });
      return { company, user };
    });
    this.logger.log(`register: company+user created companyId=${company.id} userId=${user.id}`);

    // Give the new company a default STARTER/ACTIVE subscription (Step 1).
    // Idempotent; response structure is unchanged.
    try {
      await this.billing.ensureDefaultSubscription(company.id);
      this.logger.log(`register: default subscription ensured companyId=${company.id}`);
    } catch (err) {
      this.logger.error(
        `register: ensureDefaultSubscription failed companyId=${company.id}: ${
          err instanceof Error ? err.message : String(err)
        }`,
        err instanceof Error ? err.stack : undefined,
      );
      throw err;
    }

    // Issue the email-verification OTP (stored hashed; sent via MailService,
    // which is a no-op while mail is disabled). Non-fatal: a mail hiccup must
    // not fail registration — the user can resend.
    try {
      await this.issueVerification(user.id, email);
    } catch (err) {
      this.logger.error(
        `register: issueVerification failed userId=${user.id}: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
    await this.audit.record({
      companyId: company.id,
      actorUserId: user.id,
      action: 'user.registered',
      entityType: 'User',
      entityId: user.id,
    });

    const outcome = await this.buildOutcome(user, company);
    this.logger.log(`register: complete userId=${user.id}`);
    return outcome;
  }

  /** Generate an OTP, store it hashed with a TTL, and send it. */
  private async issueVerification(userId: string, email: string): Promise<void> {
    const code = this.mail.generateOtp();
    const verificationCodeHash = await this.auth.hash(code);
    await this.prisma.user.update({
      where: { id: userId },
      data: {
        verificationCodeHash,
        verificationCodeExpiresAt: new Date(Date.now() + VERIFICATION_TTL_MS),
        verificationSentAt: new Date(),
      },
    });
    await this.mail.sendVerificationOtp(email, code);
  }

  /**
   * Confirm the OTP. Idempotent (already-verified → ok). Wrong/expired code →
   * 400 (generic; no oracle about whether the code merely expired). On success
   * the code is consumed (cleared) so it cannot be replayed.
   */
  async verifyEmail(userId: string, code: string): Promise<{ verified: boolean }> {
    const user = await this.prisma.user.findUniqueOrThrow({ where: { id: userId } });
    this.assertActive(user, 'verify-email');
    if (user.emailVerifiedAt) return { verified: true };

    if (
      !user.verificationCodeHash ||
      !user.verificationCodeExpiresAt ||
      user.verificationCodeExpiresAt.getTime() < Date.now()
    ) {
      throw new BadRequestException('Verification code has expired — request a new one.');
    }
    const ok = await this.auth.verify(user.verificationCodeHash, code);
    if (!ok) {
      throw new BadRequestException('That verification code is not valid.');
    }
    await this.prisma.user.update({
      where: { id: userId },
      data: {
        emailVerifiedAt: new Date(),
        verificationCodeHash: null,
        verificationCodeExpiresAt: null,
      },
    });
    await this.audit.record({
      companyId: user.companyId,
      actorUserId: userId,
      action: 'user.email_verified',
      entityType: 'User',
      entityId: userId,
    });
    this.logger.log(`verify-email: verified userId=${userId}`);
    return { verified: true };
  }

  /** Re-send the OTP, with a cooldown to prevent mail flooding. */
  async resendVerification(userId: string): Promise<{ sent: boolean }> {
    const user = await this.prisma.user.findUniqueOrThrow({ where: { id: userId } });
    this.assertActive(user, 'resend-verification');
    if (user.emailVerifiedAt) return { sent: false };
    if (
      user.verificationSentAt &&
      Date.now() - user.verificationSentAt.getTime() < RESEND_COOLDOWN_MS
    ) {
      throw new ConflictException('Please wait a moment before requesting another code.');
    }
    await this.issueVerification(userId, user.email);
    await this.audit.record({
      companyId: user.companyId,
      actorUserId: userId,
      action: 'user.verification_resent',
      entityType: 'User',
      entityId: userId,
    });
    return { sent: true };
  }

  /**
   * Request a password reset — OTP-based (parallel to email verification). ALWAYS
   * returns the same generic result regardless of whether the email matches any
   * account (anti-enumeration). Email is per-tenant, so one address can map to
   * several users; each gets its own reset OTP (a new request overwrites the
   * prior one). While mail is disabled the code is the fixed dev OTP so recovery
   * is testable without an inbox — same as verification.
   */
  async forgotPassword(emailRaw: string): Promise<{ ok: true }> {
    const email = normalizeEmail(emailRaw);
    const users = await this.prisma.user.findMany({
      where: { email },
      take: MAX_LOGIN_CANDIDATES,
    });
    for (const user of users) {
      if (user.status === 'DISABLED') continue;
      const code = this.mail.generateOtp();
      const passwordResetCodeHash = await this.auth.hash(code);
      await this.prisma.user.update({
        where: { id: user.id },
        data: {
          passwordResetCodeHash,
          passwordResetCodeExpiresAt: new Date(Date.now() + PASSWORD_RESET_OTP_TTL_MS),
        },
      });
      await this.mail.sendPasswordResetOtp(user.email, code);
      await this.audit.record({
        companyId: user.companyId,
        actorUserId: user.id,
        action: 'password_reset.requested',
        entityType: 'User',
        entityId: user.id,
      });
    }
    this.logger.log(`forgot-password: processed email="${email}" matches=${users.length}`);
    return { ok: true };
  }

  /**
   * Verify a password-reset OTP and hand back a SINGLE-USE token the reset page
   * consumes. Resolving the right account when an email maps to several users:
   * the code is verified against each candidate's hash, and the first match wins
   * (with real mail each user got a distinct random code, so it's unambiguous;
   * the fixed dev OTP is a dev-only tie). Any failure → one generic 400, so it
   * reveals neither whether the email exists nor whether the code merely expired.
   */
  async verifyPasswordResetOtp(
    emailRaw: string,
    code: string,
  ): Promise<{ token: string }> {
    const email = normalizeEmail(emailRaw);
    const users = await this.prisma.user.findMany({
      where: { email },
      take: MAX_LOGIN_CANDIDATES,
    });
    for (const user of users) {
      if (user.status === 'DISABLED') continue;
      if (
        !user.passwordResetCodeHash ||
        !user.passwordResetCodeExpiresAt ||
        user.passwordResetCodeExpiresAt.getTime() < Date.now()
      ) {
        continue;
      }
      const ok = await this.auth.verify(user.passwordResetCodeHash, code);
      if (!ok) continue;

      // Matched: consume the OTP and mint a single-use reset token (existing
      // token path), invalidating any prior unused tokens for this user.
      const rawToken = randomBytes(32).toString('hex');
      await this.prisma.$transaction([
        this.prisma.user.update({
          where: { id: user.id },
          data: { passwordResetCodeHash: null, passwordResetCodeExpiresAt: null },
        }),
        this.prisma.passwordResetToken.updateMany({
          where: { userId: user.id, usedAt: null },
          data: { usedAt: new Date() },
        }),
        this.prisma.passwordResetToken.create({
          data: {
            userId: user.id,
            tokenHash: sha256(rawToken),
            expiresAt: new Date(Date.now() + RESET_TTL_MS),
          },
        }),
      ]);
      await this.audit.record({
        companyId: user.companyId,
        actorUserId: user.id,
        action: 'password_reset.otp_verified',
        entityType: 'User',
        entityId: user.id,
      });
      this.logger.log(`verify-reset-otp: matched userId=${user.id}`);
      return { token: rawToken };
    }
    throw new BadRequestException(
      'That code is invalid or has expired. Request a new one.',
    );
  }

  /**
   * Complete a reset. Validates the token (exists / not used / not expired),
   * sets the new password, consumes the token, and invalidates the user's other
   * outstanding tokens. Generic 400 on any bad token (no oracle).
   */
  async resetPassword(rawToken: string, password: string): Promise<{ ok: true }> {
    const row = await this.prisma.passwordResetToken.findUnique({
      where: { tokenHash: sha256(rawToken) },
    });
    if (!row || row.usedAt || row.expiresAt.getTime() < Date.now()) {
      throw new BadRequestException('This reset link is invalid or has expired.');
    }
    const passwordHash = await this.auth.hash(password);
    await this.prisma.$transaction([
      this.prisma.user.update({
        where: { id: row.userId },
        data: { passwordHash },
      }),
      this.prisma.passwordResetToken.updateMany({
        where: { userId: row.userId, usedAt: null },
        data: { usedAt: new Date() },
      }),
    ]);
    const user = await this.prisma.user.findUniqueOrThrow({ where: { id: row.userId } });
    // Revoke every refresh session — a reset ends all other logins immediately.
    await this.revokeAllRefreshTokens(row.userId);
    await this.audit.record({
      companyId: user.companyId,
      actorUserId: row.userId,
      action: 'password_reset.completed',
      entityType: 'User',
      entityId: row.userId,
    });
    // Security notice (best-effort — a mail hiccup must not fail the reset).
    await this.mail.sendPasswordChanged(user.email).catch(() => undefined);
    this.logger.log(`reset-password: complete userId=${row.userId}`);
    // Refresh sessions are now revoked; any already-issued access token still
    // lives out its short (≤15m) TTL — the intended access/refresh split.
    return { ok: true };
  }

  private baseUrl(): string {
    return this.config.get<string>('APP_BASE_URL') ?? 'http://localhost:3200';
  }

  async login(dto: LoginDto): Promise<AuthOutcome> {
    const email = normalizeEmail(dto.email);
    this.logger.log(`login: start email="${email}"`);

    // Email is unique per-company, not global, so the same address can exist in
    // several tenants. The previous `findFirst` picked an arbitrary one and
    // checked ONLY that password: a user whose address also existed in another
    // company (or whose first-created account had since been disabled) was told
    // "invalid credentials" even with the right password. Resolve every
    // candidate in a stable order and take the first one the password opens.
    const candidates = await this.prisma.user.findMany({
      where: { email },
      orderBy: { createdAt: 'asc' },
      take: MAX_LOGIN_CANDIDATES,
    });
    if (candidates.length === 0) {
      this.logger.warn(`login: no user found email="${email}"`);
      throw new UnauthorizedException('Invalid credentials');
    }

    let matched: User | null = null;
    for (const candidate of candidates) {
      if (await this.auth.verify(candidate.passwordHash, dto.password)) {
        matched = candidate;
        break;
      }
    }
    if (!matched) {
      this.logger.warn(`login: password mismatch email="${email}"`);
      throw new UnauthorizedException('Invalid credentials');
    }
    this.logger.log(`login: password verified userId=${matched.id}`);

    // Disabled accounts may hold valid credentials but must not authenticate.
    this.assertActive(matched, 'login');

    const company = await this.prisma.company.findUniqueOrThrow({
      where: { id: matched.companyId },
    });
    const outcome = await this.buildOutcome(matched, company);
    this.logger.log(`login: complete userId=${matched.id}`);
    return outcome;
  }

  async refresh(refreshToken: string | undefined): Promise<AuthOutcome> {
    this.logger.log('refresh: start');
    if (!refreshToken) {
      this.logger.warn('refresh: missing refresh token cookie');
      throw new UnauthorizedException('Missing refresh token');
    }
    let payload: JwtPayload;
    try {
      payload = await this.auth.verifyRefresh(refreshToken);
    } catch {
      this.logger.warn('refresh: refresh token failed verification');
      throw new UnauthorizedException('Invalid refresh token');
    }
    this.logger.log(`refresh: token verified userId=${payload.sub}`);

    const user = await this.prisma.user.findUnique({ where: { id: payload.sub } });
    if (!user) {
      this.logger.warn(`refresh: user no longer exists userId=${payload.sub}`);
      throw new UnauthorizedException('User no longer exists');
    }
    // Re-check on every refresh, not just at login. Without this an account
    // disabled mid-session kept minting fresh access tokens for the whole
    // 7-day life of its refresh cookie — the kill switch looked applied in the
    // admin UI but did not actually end the session.
    this.assertActive(user, 'refresh');

    // Revocation + rotation: the presented token must have a live (unrevoked,
    // unexpired) row. A logged-out / reset / already-rotated token has none →
    // 401. On success we rotate: revoke this row, then buildOutcome issues +
    // records a fresh one, so a captured old refresh token can't be reused.
    const stored = await this.prisma.refreshToken.findUnique({
      where: { tokenHash: sha256(refreshToken) },
    });
    if (!stored || stored.revokedAt || stored.expiresAt.getTime() < Date.now()) {
      this.logger.warn(`refresh: token revoked/expired/unknown userId=${user.id}`);
      throw new UnauthorizedException('Invalid refresh token');
    }

    const company = await this.prisma.company.findUniqueOrThrow({
      where: { id: user.companyId },
    });
    const outcome = await this.buildOutcome(user, company);
    await this.prisma.refreshToken.update({
      where: { id: stored.id },
      data: { revokedAt: new Date() },
    });
    this.logger.log(`refresh: complete (rotated) userId=${user.id}`);
    return outcome;
  }

  async me(userId: string): Promise<MeDto> {
    this.logger.log(`me: start userId=${userId}`);
    const user = await this.prisma.user.findUniqueOrThrow({
      where: { id: userId },
    });
    // An access token already issued stays cryptographically valid until it
    // expires, so identity reads re-check status too.
    this.assertActive(user, 'me');

    const company = await this.prisma.company.findUniqueOrThrow({
      where: { id: user.companyId },
    });
    this.logger.log(`me: complete userId=${userId}`);
    return { user: toUserDto(user), company: toCompanyDto(company) };
  }

  /**
   * A DISABLED account must not be able to authenticate OR continue an existing
   * session. Throws the same 401 shape everywhere so callers (and the web
   * client's refresh interceptor) treat it uniformly as "session is over".
   */
  private assertActive(user: User, stage: string): void {
    if (user.status === 'DISABLED') {
      this.logger.warn(`${stage}: account disabled userId=${user.id}`);
      throw new UnauthorizedException('Account is disabled');
    }
  }

  private async buildOutcome(user: User, company: Company): Promise<AuthOutcome> {
    const payload: JwtPayload = {
      sub: user.id,
      companyId: user.companyId,
      role: user.role,
    };
    let accessToken: string;
    let refreshToken: string;
    try {
      ({ accessToken, refreshToken } = await this.auth.issueTokens(payload));
    } catch (err) {
      this.logger.error(
        `buildOutcome: issueTokens failed userId=${user.id}: ${
          err instanceof Error ? err.message : String(err)
        }`,
        err instanceof Error ? err.stack : undefined,
      );
      throw err;
    }
    // Record the issued refresh token so it can be revoked (logout / reset) and
    // rotated (each refresh invalidates the previous one).
    await this.prisma.refreshToken.create({
      data: {
        userId: user.id,
        tokenHash: sha256(refreshToken),
        expiresAt: new Date(Date.now() + REFRESH_TOKEN_TTL_MS),
      },
    });
    this.logger.log(`buildOutcome: tokens issued userId=${user.id}`);
    const response: AuthResponse = {
      user: toUserDto(user),
      company: toCompanyDto(company),
      tokens: { accessToken },
    };
    return { response, refreshToken };
  }

  /** Revoke a single presented refresh token (logout). Idempotent. */
  async revokeRefreshToken(token: string | undefined): Promise<void> {
    if (!token) return;
    await this.prisma.refreshToken.updateMany({
      where: { tokenHash: sha256(token), revokedAt: null },
      data: { revokedAt: new Date() },
    });
  }

  private async revokeAllRefreshTokens(userId: string): Promise<void> {
    await this.prisma.refreshToken.updateMany({
      where: { userId, revokedAt: null },
      data: { revokedAt: new Date() },
    });
  }

  private slugify(name: string): string {
    const base = name
      .toLowerCase()
      .trim()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 40);
    return base || 'company';
  }

  private async uniqueSlug(name: string): Promise<string> {
    const base = this.slugify(name);
    let slug = base;
    for (let i = 0; i < 5; i += 1) {
      const exists = await this.prisma.company.findUnique({ where: { slug } });
      if (!exists) {
        return slug;
      }
      slug = `${base}-${Math.random().toString(36).slice(2, 6)}`;
    }
    return `${base}-${Date.now().toString(36)}`;
  }
}

function toUserDto(user: User): UserDto {
  return {
    id: user.id,
    companyId: user.companyId,
    email: user.email,
    name: user.name,
    phone: user.phone,
    role: user.role,
    status: user.status,
    emailVerified: user.emailVerifiedAt !== null,
    departmentId: user.departmentId ?? null,
    teamId: user.teamId ?? null,
    managerUserId: user.managerUserId ?? null,
    createdAt: user.createdAt.toISOString(),
  };
}

function toCompanyDto(company: Company): CompanyDto {
  return {
    id: company.id,
    name: company.name,
    slug: company.slug,
    industry: company.industry,
    size: company.size,
    country: company.country,
    timezone: company.timezone,
    website: company.website,
    logoUrl: company.logoUrl,
    description: company.description,
    onboardedAt: company.onboardedAt ? company.onboardedAt.toISOString() : null,
    createdAt: company.createdAt.toISOString(),
  };
}
