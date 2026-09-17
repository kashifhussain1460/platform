import type {
  EmployeeSkill,
  InstalledSkill,
  SkillExecution,
} from '@prisma/client';
import type {
  EmployeeSkillDto,
  InstalledSkillDto,
  SkillExecutionDto,
} from '@vaep/types';

/** Prisma row → public DTO mappers for the skills module. */

export function toInstalledSkillDto(s: InstalledSkill): InstalledSkillDto {
  // SECRETS: credentials are stored as an encrypted envelope ({ enc: ... }) and
  // are NEVER returned — neither the plaintext nor the envelope. Only a masked
  // boolean flag (true when any credentials are present) is exposed.
  const creds = s.credentials as Record<string, unknown> | null;
  const credentialsSet = Boolean(
    creds && typeof creds === 'object' && Object.keys(creds).length > 0,
  );
  return {
    id: s.id,
    companyId: s.companyId,
    skillKey: s.skillKey,
    employeeId: s.employeeId,
    displayName: s.displayName,
    config: (s.config as Record<string, unknown> | null) ?? null,
    enabled: s.enabled,
    connectionType:
      (s.connectionType as InstalledSkillDto['connectionType']) ?? null,
    connectionStatus: s.connectionStatus as InstalledSkillDto['connectionStatus'],
    credentialsSet,
    createdAt: s.createdAt.toISOString(),
  };
}

export function toEmployeeSkillDto(s: EmployeeSkill): EmployeeSkillDto {
  return {
    id: s.id,
    companyId: s.companyId,
    employeeId: s.employeeId,
    installedSkillId: s.installedSkillId,
    createdAt: s.createdAt.toISOString(),
  };
}

export function toSkillExecutionDto(s: SkillExecution): SkillExecutionDto {
  return {
    id: s.id,
    companyId: s.companyId,
    employeeId: s.employeeId,
    conversationId: s.conversationId,
    skillKey: s.skillKey,
    tool: s.tool,
    args: (s.args as Record<string, unknown>) ?? {},
    result: s.result ?? null,
    status: s.status,
    error: s.error,
    createdAt: s.createdAt.toISOString(),
    simulated: s.simulated,
  };
}
