import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { Prisma, type Department, type SecurityPolicy, type Team } from '@prisma/client';
import type {
  DepartmentDependenciesDto,
  DepartmentDto,
  SecurityPolicyDto,
  TeamDto,
} from '@vaep/types';
import { normalizeScope } from '../authorization/authorization.policy';
import { SecurityPolicyService } from '../authorization/security-policy.service';
import { PrismaService } from '../../common/prisma/prisma.service';
import { AuditLogService } from '../audit/audit-log.service';
import { CreateDepartmentDto } from './dto/create-department.dto';
import { CreateTeamDto } from './dto/create-team.dto';
import { UpdateDepartmentDto } from './dto/update-department.dto';
import { UpdateSecurityPolicyDto } from './dto/update-security-policy.dto';
import { UpdateTeamDto } from './dto/update-team.dto';
import {
  toDepartmentDto,
  toSecurityPolicyDto,
  toTeamDto,
} from './organization.mapper';

/**
 * Organization module (Security Policies / Teams / Departments, P1 #7). Every
 * query is scoped by companyId (from the JWT) so tenants never touch each
 * other's org structure. Mutations are gated OWNER/ADMIN at the controllers;
 * reads are open to any authenticated member. The single SecurityPolicy is
 * self-healed (defaults created on first read) so a company always has one.
 */
@Injectable()
export class OrganizationService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly auditLog: AuditLogService,
    private readonly securityPolicy: SecurityPolicyService,
  ) {}

  // --- Departments ---------------------------------------------------------

  /**
   * Departments with their member/team counts.
   *
   * Two `groupBy` aggregates for the whole list rather than a count per row —
   * the management screen renders every department at once, and the counts are
   * what make a delete's consequence visible before the click rather than
   * after it.
   */
  async listDepartments(companyId: string): Promise<DepartmentDto[]> {
    const [rows, memberRows, teamRows] = await Promise.all([
      this.prisma.department.findMany({
        where: { companyId },
        orderBy: { createdAt: 'asc' },
      }),
      this.prisma.user.groupBy({
        by: ['departmentId'],
        where: { companyId, departmentId: { not: null } },
        _count: { _all: true },
      }),
      this.prisma.team.groupBy({
        by: ['departmentId'],
        where: { companyId, departmentId: { not: null } },
        _count: { _all: true },
      }),
    ]);
    const members = new Map(
      memberRows.map((r) => [r.departmentId as string, r._count._all]),
    );
    const teams = new Map(
      teamRows.map((r) => [r.departmentId as string, r._count._all]),
    );
    return rows.map((d) =>
      toDepartmentDto(d, {
        memberCount: members.get(d.id) ?? 0,
        teamCount: teams.get(d.id) ?? 0,
      }),
    );
  }

  /**
   * What removing this department would affect.
   *
   * Exists because the delete below refuses to run blind. Tenant-scoped through
   * `findOwnedDepartment`, so this cannot be used to enumerate another
   * company's people.
   */
  async departmentDependencies(
    companyId: string,
    id: string,
  ): Promise<DepartmentDependenciesDto> {
    const dept = await this.findOwnedDepartment(companyId, id);
    const [members, teams] = await Promise.all([
      this.prisma.user.findMany({
        where: { companyId, departmentId: id },
        select: { id: true, name: true, email: true, role: true },
        orderBy: { name: 'asc' },
      }),
      this.prisma.team.findMany({
        where: { companyId, departmentId: id },
        select: { id: true, name: true },
        orderBy: { name: 'asc' },
      }),
    ]);
    return {
      departmentId: dept.id,
      name: dept.name,
      members,
      teams,
      scopes: dept.scopes,
      // The case that must never happen silently: a department that actually
      // restricts something, with people in it. Deleting it turns every one of
      // them into an unrestricted, company-wide reader.
      wouldWidenAccess: dept.scopes.length > 0 && members.length > 0,
    };
  }

  async createDepartment(
    companyId: string,
    dto: CreateDepartmentDto,
  ): Promise<DepartmentDto> {
    try {
      const dept = await this.prisma.department.create({
        data: {
          companyId,
          name: dto.name,
          description: dto.description ?? null,
          // WAVE 2 §2.1 — normalised so `Project Manager`, `PROJECT_MANAGER`
          // and `project-manager` are one scope regardless of how they are typed.
          scopes: (dto.scopes ?? []).map(normalizeScope),
        },
      });
      return toDepartmentDto(dept);
    } catch (err) {
      this.rethrowUnique(err, 'A department with this name already exists');
    }
  }

  async updateDepartment(
    companyId: string,
    id: string,
    dto: UpdateDepartmentDto,
  ): Promise<DepartmentDto> {
    await this.findOwnedDepartment(companyId, id);
    try {
      const dept = await this.prisma.department.update({
        where: { id },
        // undefined → leave unchanged; explicit null → clear the description.
        data: {
          name: dto.name,
          description:
            dto.description === undefined ? undefined : dto.description,
          // Replaces the whole list; `[]` turns department isolation back OFF.
          scopes:
            dto.scopes === undefined ? undefined : dto.scopes.map(normalizeScope),
        },
      });
      return toDepartmentDto(dept);
    } catch (err) {
      this.rethrowUnique(err, 'A department with this name already exists');
    }
  }

  /**
   * Remove a department — safely.
   *
   * ## What this used to do, and why that was wrong
   *
   * `await this.prisma.department.delete({ where: { id } })`, with one comment
   * about teams surviving. The comment was true and beside the point: the
   * dangerous edge is `User.departmentId onDelete: SetNull`. Deleting a
   * department with `scopes: ['HR']` and three members placed in it silently
   * turned all three into UNSCOPED users — company-wide readers of Marketing,
   * Finance and everything else — with no prompt, no audit detail and nothing
   * on screen to suggest access had just been widened.
   *
   * Privilege escalation by deletion is still privilege escalation.
   *
   * ## What it does now
   *
   * A department with members requires an explicit decision:
   *   - `reassignTo` — move every member AND team to another department of the
   *     same tenant (the safe default the UI offers first), or
   *   - `force` — proceed, accepting that members become company-wide.
   * With neither, it returns 409 naming exactly who would be affected.
   *
   * An EMPTY department (no members) deletes freely: there is no one to widen.
   * Teams alone never block it — they carry no authorization weight, they just
   * get unassigned, which is what `SetNull` already did.
   */
  async removeDepartment(
    companyId: string,
    id: string,
    actorUserId?: string,
    opts: { reassignTo?: string | null; force?: boolean } = {},
  ): Promise<void> {
    const dept = await this.findOwnedDepartment(companyId, id);
    const deps = await this.departmentDependencies(companyId, id);

    // Tenant isolation: a reassignment target must be a department of THIS
    // company. Without this an admin could hand their users to another tenant's
    // department id, and the policy compares ids — the placement would scope
    // them against a department they cannot see (the same hole `users.service`
    // already closes for direct assignment).
    let target: Department | null = null;
    if (opts.reassignTo) {
      if (opts.reassignTo === id) {
        throw new BadRequestException(
          'Cannot reassign a department to itself — pick a different department.',
        );
      }
      target = await this.findOwnedDepartment(companyId, opts.reassignTo);
    }

    if (deps.members.length > 0 && !target && !opts.force) {
      throw new ConflictException(
        `"${dept.name}" still has ${deps.members.length} member(s)` +
          (deps.scopes.length > 0
            ? `, and it limits them to [${deps.scopes.join(', ')}]. Deleting it would give them ` +
              'company-wide access. '
            : '. ') +
          'Move them to another department first, or confirm you want them to become company-wide.',
      );
    }

    await this.prisma.$transaction(async (tx) => {
      if (target) {
        // Move people and teams BEFORE the delete, so the SetNull cascade has
        // nothing left to blank out.
        await tx.user.updateMany({
          where: { companyId, departmentId: id },
          data: { departmentId: target.id },
        });
        await tx.team.updateMany({
          where: { companyId, departmentId: id },
          data: { departmentId: target.id },
        });
      }
      await tx.department.delete({ where: { id } });
    });

    await this.auditLog.record({
      companyId,
      actorUserId,
      action: 'department.deleted',
      entityType: 'Department',
      entityId: id,
      metadata: {
        name: dept.name,
        scopes: dept.scopes,
        memberCount: deps.members.length,
        teamCount: deps.teams.length,
        reassignedToDepartmentId: target?.id ?? null,
        reassignedToName: target?.name ?? null,
        // The security-relevant fact, recorded explicitly rather than left to
        // be inferred from the absence of a reassignment target.
        accessWidened: !target && deps.wouldWidenAccess,
      },
    });
  }

  // --- Teams ---------------------------------------------------------------

  async listTeams(companyId: string): Promise<TeamDto[]> {
    const rows = await this.prisma.team.findMany({
      where: { companyId },
      orderBy: { createdAt: 'asc' },
    });
    return rows.map(toTeamDto);
  }

  async createTeam(companyId: string, dto: CreateTeamDto): Promise<TeamDto> {
    const departmentId = await this.resolveDepartment(companyId, dto.departmentId);
    try {
      const team = await this.prisma.team.create({
        data: { companyId, name: dto.name, departmentId },
      });
      return toTeamDto(team);
    } catch (err) {
      this.rethrowUnique(err, 'A team with this name already exists');
    }
  }

  async updateTeam(
    companyId: string,
    id: string,
    dto: UpdateTeamDto,
  ): Promise<TeamDto> {
    await this.findOwnedTeam(companyId, id);
    // undefined → leave unchanged; null → unassign; string → validate ownership.
    const departmentId =
      dto.departmentId === undefined
        ? undefined
        : await this.resolveDepartment(companyId, dto.departmentId);
    try {
      const team = await this.prisma.team.update({
        where: { id },
        data: { name: dto.name, departmentId },
      });
      return toTeamDto(team);
    } catch (err) {
      this.rethrowUnique(err, 'A team with this name already exists');
    }
  }

  async removeTeam(companyId: string, id: string): Promise<void> {
    await this.findOwnedTeam(companyId, id);
    await this.prisma.team.delete({ where: { id } });
  }

  // --- Security policy -----------------------------------------------------

  /** GET: return the policy, self-healing a default row when none exists. */
  async getSecurityPolicy(companyId: string): Promise<SecurityPolicyDto> {
    return toSecurityPolicyDto(await this.ensureSecurityPolicy(companyId));
  }

  async updateSecurityPolicy(
    companyId: string,
    dto: UpdateSecurityPolicyDto,
    actorUserId?: string,
  ): Promise<SecurityPolicyDto> {
    // WAVE 2 §2.4 — refuse to persist a setting nothing enforces. Storing
    // `mfaRequired: true` with no MFA implementation would report a protection
    // the platform does not apply, which is worse than leaving it off.
    this.securityPolicy.assertPolicyIsEnforceable(dto);
    await this.ensureSecurityPolicy(companyId);
    const policy = await this.prisma.securityPolicy.update({
      where: { companyId },
      data: {
        passwordMinLength: dto.passwordMinLength,
        mfaRequired: dto.mfaRequired,
        sessionTimeoutMinutes: dto.sessionTimeoutMinutes,
        allowedEmailDomains: dto.allowedEmailDomains,
        dataRetentionDays: dto.dataRetentionDays,
      },
    });
    await this.auditLog.record({
      companyId,
      actorUserId,
      action: 'security_policy.update',
      entityType: 'SecurityPolicy',
      entityId: policy.id,
      metadata: { changedFields: Object.keys(dto) },
    });
    return toSecurityPolicyDto(policy);
  }

  /** Create the default security policy for a company if none exists (idempotent). */
  private ensureSecurityPolicy(companyId: string): Promise<SecurityPolicy> {
    return this.prisma.securityPolicy.upsert({
      where: { companyId },
      update: {},
      create: { companyId },
    });
  }

  // --- Ownership + helpers -------------------------------------------------

  private async findOwnedDepartment(
    companyId: string,
    id: string,
  ): Promise<Department> {
    const dept = await this.prisma.department.findFirst({
      where: { id, companyId },
    });
    if (!dept) {
      throw new NotFoundException('Department not found');
    }
    return dept;
  }

  private async findOwnedTeam(companyId: string, id: string): Promise<Team> {
    const team = await this.prisma.team.findFirst({ where: { id, companyId } });
    if (!team) {
      throw new NotFoundException('Team not found');
    }
    return team;
  }

  /** Validate an optional departmentId belongs to the tenant; null/undefined → null. */
  private async resolveDepartment(
    companyId: string,
    departmentId?: string | null,
  ): Promise<string | null> {
    if (!departmentId) return null;
    const dept = await this.prisma.department.findFirst({
      where: { id: departmentId, companyId },
    });
    if (!dept) {
      throw new BadRequestException('Department not found');
    }
    return dept.id;
  }

  /** Map a unique-constraint violation (P2002) to a 409; rethrow everything else. */
  private rethrowUnique(err: unknown, message: string): never {
    if (
      err instanceof Prisma.PrismaClientKnownRequestError &&
      err.code === 'P2002'
    ) {
      throw new ConflictException(message);
    }
    throw err;
  }
}
