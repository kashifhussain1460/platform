import { Injectable, UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import { PrismaService } from '../../../common/prisma/prisma.service';

/** The `aud` claim every platform-admin token carries — an extra, independent
 * signal alongside the separate signing secret (belt-and-braces, not the
 * primary defense — the secret alone already makes a company JWT unable to
 * verify here at all). */
export const PLATFORM_ADMIN_AUDIENCE = 'platform-admin';

export interface PlatformOperatorClaims {
  sub: string;
  aud: typeof PLATFORM_ADMIN_AUDIENCE;
}

/**
 * Credit system Phase 10, Task 10.1 (§31.5/§32.3). Deliberately has NO
 * password-login method — `PlatformOperator` has no `passwordHash` column at
 * all. A token is minted exactly once, by `seed-platform-operator.ts`, and
 * handed to the operator out-of-band (same story as `ENCRYPTION_KEY`); there
 * is no HTTP endpoint that can mint one, so there is nothing here for an
 * attacker to brute-force.
 */
@Injectable()
export class PlatformAdminAuthService {
  constructor(
    private readonly jwt: JwtService,
    private readonly config: ConfigService,
    private readonly prisma: PrismaService,
  ) {}

  /** Mint a long-lived token for an existing, ACTIVE PlatformOperator row. */
  async issueToken(operatorId: string): Promise<string> {
    const operator = await this.prisma.platformOperator.findUnique({
      where: { id: operatorId },
    });
    if (!operator || operator.status !== 'ACTIVE') {
      throw new UnauthorizedException('Unknown or inactive platform operator');
    }
    const payload: PlatformOperatorClaims = { sub: operator.id, aud: PLATFORM_ADMIN_AUDIENCE };
    return this.jwt.signAsync(payload, {
      secret: this.config.getOrThrow<string>('PLATFORM_ADMIN_JWT_SECRET'),
      // Long-lived by design: re-running the seed script to mint a fresh
      // token is the intended rotation path (mirrors ENCRYPTION_KEY, not the
      // short-TTL company access token — there is no refresh flow here to
      // silently extend a stolen token's life instead).
      expiresIn: '365d',
    });
  }

  /**
   * Verify a bearer token against the SEPARATE platform-admin secret +
   * audience. A company access token (signed with `JWT_ACCESS_SECRET`) fails
   * `verifyAsync` here on signature mismatch alone, before the `aud` check
   * ever runs — caught and re-thrown as 401 rather than surfacing as a 500,
   * since `jsonwebtoken`'s own errors aren't Nest HTTP exceptions.
   */
  async verify(token: string): Promise<PlatformOperatorClaims> {
    let payload: PlatformOperatorClaims;
    try {
      payload = await this.jwt.verifyAsync<PlatformOperatorClaims>(token, {
        secret: this.config.getOrThrow<string>('PLATFORM_ADMIN_JWT_SECRET'),
      });
    } catch {
      throw new UnauthorizedException('Invalid platform-admin token');
    }
    if (payload.aud !== PLATFORM_ADMIN_AUDIENCE) {
      throw new UnauthorizedException('Not a platform-admin token');
    }
    return payload;
  }
}
