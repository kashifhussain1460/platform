import { Injectable, UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PassportStrategy } from '@nestjs/passport';
import { ExtractJwt, Strategy } from 'passport-jwt';
import { enrichContext } from '../../common/observability/execution-context';
import { PrismaService } from '../../common/prisma/prisma.service';
import type { AuthenticatedUser, JwtPayload } from './auth.provider';

/**
 * Passport JWT strategy reading the access token from the Authorization header.
 * `validate` returns the tenant-scoped identity attached to `req.user`.
 *
 * SECURITY (kill-switch): the access token alone is NOT trusted for status/role.
 * Every request re-reads the user so that disabling an account or changing a
 * role takes effect immediately — not only after the ≤15-min token TTL. Without
 * this, a fired employee (or a demoted admin) kept full old-role access to
 * tenant data, HR PII and approvals until the token naturally expired. Role +
 * companyId are taken from the DB, never the (stale) token claims.
 */
@Injectable()
export class JwtStrategy extends PassportStrategy(Strategy) {
  constructor(
    config: ConfigService,
    private readonly prisma: PrismaService,
  ) {
    super({
      jwtFromRequest: ExtractJwt.fromAuthHeaderAsBearerToken(),
      ignoreExpiration: false,
      secretOrKey: config.getOrThrow<string>('JWT_ACCESS_SECRET'),
    });
  }

  async validate(payload: JwtPayload): Promise<AuthenticatedUser> {
    const user = await this.prisma.user.findUnique({
      where: { id: payload.sub },
      select: { id: true, companyId: true, role: true, status: true },
    });
    if (!user || user.status === 'DISABLED') {
      throw new UnauthorizedException('Account is not active');
    }
    // Correlation (WAVE 5 §5.1): attach the VERIFIED identity to the ambient
    // context, so every log line, audit entry and metric emitted downstream of
    // this request carries it. Done here rather than in the middleware because
    // this is the first point where the identity is trustworthy — taking it
    // from a header would put attacker-controlled values in every log line.
    enrichContext({ userId: user.id, companyId: user.companyId });

    return {
      userId: user.id,
      companyId: user.companyId,
      role: user.role,
    };
  }
}
