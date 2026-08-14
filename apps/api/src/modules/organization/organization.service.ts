import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { Prisma, type Department, type SecurityPolicy, type Team } from '@prisma/client';
import type {
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

  async listDepartments(companyId: string): Promise<DepartmentDto[]> {
    const rows = await this.prisma.department.findMany({
      where: { companyId },
      orderBy: { createdAt: 'asc' },
    });
    return rows.map(toDepartmentDto);
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

  async removeDepartment(companyId: string, id: string): Promise<void> {
    await this.findOwnedDepartment(companyId, id);
    // Teams reference departmentId with onDelete: SetNull → teams survive, unassigned.
    await this.prisma.department.delete({ where: { id } });
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
