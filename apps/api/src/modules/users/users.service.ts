import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Inject,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { Prisma, type User } from '@prisma/client';
import type { UserDto } from '@vaep/types';
import { PrismaService } from '../../common/prisma/prisma.service';
import { AuditLogService } from '../audit/audit-log.service';
import { SecurityPolicyService } from '../authorization/security-policy.service';
import {
  AUTH_PROVIDER,
  type AuthenticatedUser,
  type AuthProvider,
} from '../auth/auth.provider';
import { AuthService } from '../auth/auth.service';
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
  private readonly logger = new Logger(UsersService.name);

  constructor(
    private readonly prisma: PrismaService,
    @Inject(AUTH_PROVIDER) private readonly auth: AuthProvider,
    private readonly auditLog: AuditLogService,
    private readonly notifications: NotificationsService,
    private readonly securityPolicy: SecurityPolicyService,
    // For the invited member's verification code. AuthModule is already
    // imported here and does not import UsersModule → no cycle.
    private readonly authService: AuthService,
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
      // Issue the email-verification code, exactly as registration does. An
      // invited member is parked at `/verify-email` on first sign-in, and that
      // screen tells them a code has been sent — so one has to actually be
      // sent, or the invite dead-ends. Best-effort like register's: a mail
      // failure must not lose the created user, and Resend still works.
      try {
        await this.authService.issueVerification(user.id, user.email);
      } catch (err) {
        this.logger.error(
          `create: issueVerification failed userId=${user.id}: ${
            err instanceof Error ? err.message : String(err)
          }`,
        );
      }
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

    // WAVE 2 — a department/team must belong to THIS company. Without the check
    // an admin could place their own users under another tenant's department id,
    // and the authorization policy compares ids: the placement would silently
    // scope them against a department they cannot see.
    if (dto.departmentId) {
      const dept = await this.prisma.department.findFirst({
        where: { id: dto.departmentId, companyId },
        select: { id: true },
      });
      if (!dept) throw new NotFoundException('Department not found');
    }
    if (dto.teamId) {
      const team = await this.prisma.team.findFirst({
        where: { id: dto.teamId, companyId },
        select: { id: true },
      });
      if (!team) throw new NotFoundException('Team not found');
    }

    const user = await this.prisma.user.update({
      where: { id: target.id },
      data: {
        name: dto.name,
        role: dto.role,
        status: dto.status,
        // undefined leaves it alone; explicit null removes the placement.
        departmentId: dto.departmentId === undefined ? undefined : dto.departmentId,
        teamId: dto.teamId === undefined ? undefined : dto.teamId,
      },
    });

    // A department change alters what this person can SEE, so it is an
    // authorization event and belongs in the trail alongside role changes.
    if (
      dto.departmentId !== undefined &&
      dto.departmentId !== target.departmentId
    ) {
      await this.auditLog.record({
        companyId,
        actorUserId: caller.userId,
        action: 'user.department_changed',
        entityType: 'User',
        entityId: user.id,
        metadata: { from: target.departmentId, to: dto.departmentId },
      });
    }
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
   * WAVE 2 §2.4 — delegates to the single SecurityPolicyService.
   *
   * This used to be a local copy of the rules, which is how password reset ended
   * up bypassing `passwordMinLength` entirely: the copy here was kept current
   * and the other paths never had one.
   */
  private async enforceSecurityPolicy(
    companyId: string,
    dto: CreateUserDto,
  ): Promise<void> {
    await this.securityPolicy.assertPasswordMeetsPolicy(companyId, dto.password);
    await this.securityPolicy.assertEmailDomainAllowed(companyId, dto.email);
  }
}
