import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Inject,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { Prisma, type User } from '@prisma/client';
import type { UserDto } from '@vaep/types';
import { PrismaService } from '../../common/prisma/prisma.service';
import { AuditLogService } from '../audit/audit-log.service';
import {
  AUTH_PROVIDER,
  type AuthenticatedUser,
  type AuthProvider,
} from '../auth/auth.provider';
import { NotificationsService } from '../notifications/notifications.service';
import { CreateUserDto } from './dto/create-user.dto';
import { UpdateUserDto } from './dto/update-user.dto';
import { toUserDto } from './users.mapper';

/**
 * Company-scoped user management (RBAC, P0 governance). Every query is scoped by
 * companyId (from the JWT) so tenants never touch each other's users. Guardrails:
 * only an OWNER may create/grant OWNER; you cannot change your own role; the last
 * OWNER cannot be demoted, disabled or deleted; you cannot delete yourself.
 * Password hashing reuses the shared AuthProvider (argon2). Never exposes
 * passwordHash.
 */
@Injectable()
export class UsersService {
  constructor(
    private readonly prisma: PrismaService,
    @Inject(AUTH_PROVIDER) private readonly auth: AuthProvider,
    private readonly auditLog: AuditLogService,
    private readonly notifications: NotificationsService,
  ) {}

  /** All users in the caller's company (oldest first, so the owner leads). */
  async list(companyId: string): Promise<UserDto[]> {
    const users = await this.prisma.user.findMany({
      where: { companyId },
      orderBy: { createdAt: 'asc' },
    });
    return users.map(toUserDto);
  }

  /** Create a user in the caller's company. Only an OWNER may create an OWNER. */
  async create(
    companyId: string,
    caller: AuthenticatedUser,
    dto: CreateUserDto,
  ): Promise<UserDto> {
    if (dto.role === 'OWNER' && caller.role !== 'OWNER') {
      throw new ForbiddenException('Only an owner can create an owner');
    }
    // Enforce the company's security policy (P1 #7): password length + allowed
    // email domains. A missing policy → defaults (min length 8, no domain
    // restriction), so existing companies/tests are unaffected.
    await this.enforceSecurityPolicy(companyId, dto);
    const passwordHash = await this.auth.hash(dto.password);
    try {
      const user = await this.prisma.user.create({
        data: {
          companyId,
          email: dto.email,
          name: dto.name,
          role: dto.role,
          passwordHash,
        },
      });
      // Tell the new member they've been added (never emails the password —
      // they set/reset their own). Best-effort inside NotificationsService.
      await this.notifications.teamInvite(companyId, {
        email: user.email,
        name: user.name,
      });
      return toUserDto(user);
    } catch (err) {
      // Unique [companyId, email] violation → a user already owns this email.
      if (
        err instanceof Prisma.PrismaClientKnownRequestError &&
        err.code === 'P2002'
      ) {
        throw new ConflictException('A user with this email already exists');
      }
      throw err;
    }
  }

  /** Update name/role/status with the governance guardrails. */
  async update(
    companyId: string,
    caller: AuthenticatedUser,
    id: string,
    dto: UpdateUserDto,
  ): Promise<UserDto> {
    const target = await this.findOwnedUser(companyId, id);

    // You cannot change your OWN role (prevents self-escalation / lock-out).
    if (
      dto.role !== undefined &&
      dto.role !== target.role &&
      id === caller.userId
    ) {
      throw new ForbiddenException('You cannot change your own role');
    }
    // Only an OWNER may grant OWNER.
    if (dto.role === 'OWNER' && caller.role !== 'OWNER') {
      throw new ForbiddenException('Only an owner can grant the owner role');
    }
    // Protect the last active OWNER from demotion or being disabled.
    const isDemotion =
      dto.role !== undefined && dto.role !== 'OWNER' && target.role === 'OWNER';
    const isDisabling =
      dto.status === 'DISABLED' &&
      target.role === 'OWNER' &&
      target.status === 'ACTIVE';
    if ((isDemotion || isDisabling) && target.status === 'ACTIVE') {
      const activeOwners = await this.prisma.user.count({
        where: { companyId, role: 'OWNER', status: 'ACTIVE' },
      });
      if (activeOwners <= 1) {
        throw new BadRequestException(
          'Cannot demote or disable the last owner',
        );
      }
    }

    const user = await this.prisma.user.update({
      where: { id: target.id },
      data: { name: dto.name, role: dto.role, status: dto.status },
    });
    if (dto.role !== undefined && dto.role !== target.role) {
      await this.auditLog.record({
        companyId,
        actorUserId: caller.userId,
        action: 'user.role_changed',
        entityType: 'User',
        entityId: user.id,
        metadata: { from: target.role, to: dto.role },
      });
      await this.notifications.accountStatusChanged(
        companyId,
        { email: user.email, name: user.name },
        { role: dto.role },
      );
    }
    // A status-only change (the security kill-switch) must be audited too — it
    // was previously silent unless bundled with a role change.
    if (dto.status !== undefined && dto.status !== target.status) {
      await this.auditLog.record({
        companyId,
        actorUserId: caller.userId,
        action:
          dto.status === 'DISABLED' ? 'user.disabled' : 'user.reactivated',
        entityType: 'User',
        entityId: user.id,
        metadata: { from: target.status, to: dto.status },
      });
      await this.notifications.accountStatusChanged(
        companyId,
        { email: user.email, name: user.name },
        dto.status === 'DISABLED' ? { disabled: true } : { reactivated: true },
      );
    }
    return toUserDto(user);
  }

  /** Delete a user. Cannot delete yourself or the last OWNER. */
  async remove(
    companyId: string,
    caller: AuthenticatedUser,
    id: string,
  ): Promise<void> {
    const target = await this.findOwnedUser(companyId, id);
    if (target.id === caller.userId) {
      throw new BadRequestException('You cannot delete your own account');
    }
    if (target.role === 'OWNER') {
      const owners = await this.prisma.user.count({
        where: { companyId, role: 'OWNER' },
      });
      if (owners <= 1) {
        throw new BadRequestException('Cannot delete the last owner');
      }
    }
    await this.prisma.user.delete({ where: { id: target.id } });
  }

  /** Fetch a user scoped to the tenant or 404. */
  private async findOwnedUser(companyId: string, id: string): Promise<User> {
    const user = await this.prisma.user.findFirst({
      where: { id, companyId },
    });
    if (!user) {
      throw new NotFoundException('User not found');
    }
    return user;
  }

  /**
   * LIGHT security-policy enforcement on user creation (P1 #7). Reads the
   * company's SecurityPolicy (falling back to safe defaults when none exists):
   * rejects passwords shorter than `passwordMinLength` (default 8) and, when
   * `allowedEmailDomains` is non-empty, emails whose domain isn't listed.
   */
  private async enforceSecurityPolicy(
    companyId: string,
    dto: CreateUserDto,
  ): Promise<void> {
    const policy = await this.prisma.securityPolicy.findUnique({
      where: { companyId },
    });
    const minLength = policy?.passwordMinLength ?? 8;
    if (dto.password.length < minLength) {
      throw new BadRequestException(
        `Password must be at least ${minLength} characters`,
      );
    }
    const allowedDomains = policy?.allowedEmailDomains ?? [];
    if (allowedDomains.length > 0) {
      const domain = dto.email.split('@')[1]?.toLowerCase() ?? '';
      const allowed = allowedDomains.map((d) => d.toLowerCase());
      if (!allowed.includes(domain)) {
        throw new BadRequestException(
          `Email domain must be one of: ${allowedDomains.join(', ')}`,
        );
      }
    }
  }
}
