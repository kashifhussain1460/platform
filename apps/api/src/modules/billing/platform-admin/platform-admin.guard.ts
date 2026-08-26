import {
  CanActivate,
  ExecutionContext,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { PrismaService } from '../../../common/prisma/prisma.service';
import { PlatformAdminAuthService } from './platform-admin-auth.service';

/** Attached to the request by the guard on success. */
export interface AuthenticatedPlatformOperator {
  id: string;
  email: string;
  name: string;
}

/**
 * Credit system Phase 10, Task 10.1 (§31.5/§32.3) — guards every
 * `/internal/platform-admin/*` route. Rejects on token signature/audience
 * BEFORE consulting any claim: `PlatformAdminAuthService.verify` uses
 * `PLATFORM_ADMIN_JWT_SECRET`, a secret distinct from `JWT_ACCESS_SECRET`, so
 * a company JWT fails signature verification here regardless of its `role`
 * claim — there is no code path in this guard that reads `role` at all. A
 * bug that let a company `Role` satisfy this guard is structurally
 * impossible, not just policy-prevented.
 */
@Injectable()
export class PlatformAdminGuard implements CanActivate {
  constructor(
    private readonly auth: PlatformAdminAuthService,
    private readonly prisma: PrismaService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const req = context.switchToHttp().getRequest();
    const header = req.headers?.authorization as string | undefined;
    const token = header?.startsWith('Bearer ') ? header.slice('Bearer '.length) : null;
    if (!token) {
      throw new UnauthorizedException('Missing platform-admin token');
    }

    // Throws on bad signature/expiry/wrong audience — never reaches the DB
    // lookup below with an unverified claim.
    const claims = await this.auth.verify(token);

    const operator = await this.prisma.platformOperator.findUnique({
      where: { id: claims.sub },
    });
    if (!operator || operator.status !== 'ACTIVE') {
      throw new UnauthorizedException('Unknown or inactive platform operator');
    }

    const identity: AuthenticatedPlatformOperator = {
      id: operator.id,
      email: operator.email,
      name: operator.name,
    };
    req.platformOperator = identity;
    return true;
  }
}
