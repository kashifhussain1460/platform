import type { Department, SecurityPolicy, Team } from '@prisma/client';
import type {
  DepartmentDto,
  SecurityPolicyDto,
  TeamDto,
} from '@vaep/types';

/** Prisma row → public DTO mappers for the Organization module (P1 #7). */

export function toDepartmentDto(d: Department): DepartmentDto {
  return {
    id: d.id,
    companyId: d.companyId,
    name: d.name,
    description: d.description,
    scopes: d.scopes,
    createdAt: d.createdAt.toISOString(),
  };
}

export function toTeamDto(t: Team): TeamDto {
  return {
    id: t.id,
    companyId: t.companyId,
    name: t.name,
    departmentId: t.departmentId,
    createdAt: t.createdAt.toISOString(),
  };
}

export function toSecurityPolicyDto(p: SecurityPolicy): SecurityPolicyDto {
  return {
    id: p.id,
    companyId: p.companyId,
    passwordMinLength: p.passwordMinLength,
    mfaRequired: p.mfaRequired,
    sessionTimeoutMinutes: p.sessionTimeoutMinutes,
    allowedEmailDomains: p.allowedEmailDomains,
    dataRetentionDays: p.dataRetentionDays,
    createdAt: p.createdAt.toISOString(),
    updatedAt: p.updatedAt.toISOString(),
  };
}
