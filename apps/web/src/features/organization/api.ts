import { apiClient } from '@/lib/apiClient';
import type {
  AuditLogDto,
  CreateDepartmentDto,
  CreateTeamDto,
  DepartmentDependenciesDto,
  DepartmentDto,
  SecurityPolicyDto,
  TeamDto,
  UpdateDepartmentDto,
  UpdateSecurityPolicyDto,
  UpdateTeamDto,
} from '@vaep/types';

// --- Departments -----------------------------------------------------------

export async function listDepartments(): Promise<DepartmentDto[]> {
  const { data } = await apiClient.get<DepartmentDto[]>('/departments');
  return data;
}

export async function createDepartment(
  payload: CreateDepartmentDto,
): Promise<DepartmentDto> {
  const { data } = await apiClient.post<DepartmentDto>('/departments', payload);
  return data;
}

export async function updateDepartment(vars: {
  id: string;
  data: UpdateDepartmentDto;
}): Promise<DepartmentDto> {
  const { data } = await apiClient.patch<DepartmentDto>(
    `/departments/${vars.id}`,
    vars.data,
  );
  return data;
}

/** Who and what a delete would affect — read BEFORE offering the delete. */
export async function departmentDependencies(
  id: string,
): Promise<DepartmentDependenciesDto> {
  const { data } = await apiClient.get<DepartmentDependenciesDto>(
    `/departments/${id}/dependencies`,
  );
  return data;
}

/**
 * Remove a department.
 *
 * `reassignTo` moves its people and teams somewhere else first (the safe path).
 * `force` accepts that its members become company-wide. With neither, the API
 * answers 409 rather than silently widening access.
 */
export async function deleteDepartment(vars: {
  id: string;
  reassignTo?: string | null;
  force?: boolean;
}): Promise<void> {
  const params = new URLSearchParams();
  if (vars.reassignTo) params.set('reassignTo', vars.reassignTo);
  if (vars.force) params.set('force', 'true');
  const query = params.toString();
  await apiClient.delete(`/departments/${vars.id}${query ? `?${query}` : ''}`);
}

// --- Teams -----------------------------------------------------------------

export async function listTeams(): Promise<TeamDto[]> {
  const { data } = await apiClient.get<TeamDto[]>('/teams');
  return data;
}

export async function createTeam(payload: CreateTeamDto): Promise<TeamDto> {
  const { data } = await apiClient.post<TeamDto>('/teams', payload);
  return data;
}

export async function updateTeam(vars: {
  id: string;
  data: UpdateTeamDto;
}): Promise<TeamDto> {
  const { data } = await apiClient.patch<TeamDto>(`/teams/${vars.id}`, vars.data);
  return data;
}

export async function deleteTeam(id: string): Promise<void> {
  await apiClient.delete(`/teams/${id}`);
}

// --- Security policy -------------------------------------------------------

export async function getSecurityPolicy(): Promise<SecurityPolicyDto> {
  const { data } = await apiClient.get<SecurityPolicyDto>('/security-policy');
  return data;
}

export async function updateSecurityPolicy(
  payload: UpdateSecurityPolicyDto,
): Promise<SecurityPolicyDto> {
  const { data } = await apiClient.patch<SecurityPolicyDto>(
    '/security-policy',
    payload,
  );
  return data;
}

// --- Audit log ---------------------------------------------------------------

export async function listAuditLog(): Promise<AuditLogDto[]> {
  const { data } = await apiClient.get<AuditLogDto[]>('/audit-log');
  return data;
}
