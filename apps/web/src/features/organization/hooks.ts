'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
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
import type { NormalizedApiError } from '@/lib/apiClient';
import { useCurrentRole, userKeys } from '@/features/users/hooks';
import { useSessionStore } from '@/stores/session.store';
import {
  createDepartment,
  createTeam,
  deleteDepartment,
  departmentDependencies,
  deleteTeam,
  getSecurityPolicy,
  listAuditLog,
  listDepartments,
  listTeams,
  updateDepartment,
  updateSecurityPolicy,
  updateTeam,
} from './api';

export const orgKeys = {
  all: ['organization'] as const,
  departments: ['organization', 'departments'] as const,
  departmentDependencies: (id: string) =>
    ['organization', 'departments', id, 'dependencies'] as const,
  teams: ['organization', 'teams'] as const,
  securityPolicy: ['organization', 'security-policy'] as const,
  auditLog: ['organization', 'audit-log'] as const,
};

/** Whether the current user may manage the org (OWNER/ADMIN). Mirrors RolesGuard. */
export function useCanManageOrg(): boolean {
  const role = useCurrentRole();
  return role === 'OWNER' || role === 'ADMIN';
}

// --- Departments -----------------------------------------------------------

export function useDepartments() {
  const accessToken = useSessionStore((s) => s.accessToken);
  return useQuery<DepartmentDto[], NormalizedApiError>({
    queryKey: orgKeys.departments,
    queryFn: listDepartments,
    enabled: Boolean(accessToken),
  });
}

interface DepartmentsContext {
  previous?: DepartmentDto[];
}

/** Create (optimistic): append a temp department, roll back on error. */
export function useCreateDepartment() {
  const qc = useQueryClient();
  return useMutation<
    DepartmentDto,
    NormalizedApiError,
    CreateDepartmentDto,
    DepartmentsContext
  >({
    mutationFn: createDepartment,
    onMutate: async (payload) => {
      await qc.cancelQueries({ queryKey: orgKeys.departments });
      const previous = qc.getQueryData<DepartmentDto[]>(orgKeys.departments);
      const optimistic: DepartmentDto = {
        id: `temp_${Date.now()}`,
        companyId: '',
        name: payload.name,
        description: payload.description ?? null,
        scopes: payload.scopes ?? [],
        // A department nobody has been placed in yet — the honest starting
        // point, and the refetch in onSettled corrects it if that changes.
        memberCount: 0,
        teamCount: 0,
        createdAt: new Date().toISOString(),
      };
      qc.setQueryData<DepartmentDto[]>(orgKeys.departments, (old) => [
        ...(old ?? []),
        optimistic,
      ]);
      return { previous };
    },
    onError: (_err, _payload, context) => {
      if (context?.previous) {
        qc.setQueryData(orgKeys.departments, context.previous);
      }
    },
    onSettled: () => {
      void qc.invalidateQueries({ queryKey: orgKeys.departments });
    },
  });
}

interface UpdateDeptVars {
  id: string;
  data: UpdateDepartmentDto;
}

/** Update (optimistic): patch the cached row, roll back on error. */
export function useUpdateDepartment() {
  const qc = useQueryClient();
  return useMutation<
    DepartmentDto,
    NormalizedApiError,
    UpdateDeptVars,
    DepartmentsContext
  >({
    mutationFn: updateDepartment,
    onMutate: async ({ id, data }) => {
      await qc.cancelQueries({ queryKey: orgKeys.departments });
      const previous = qc.getQueryData<DepartmentDto[]>(orgKeys.departments);
      qc.setQueryData<DepartmentDto[]>(orgKeys.departments, (old) =>
        (old ?? []).map((d) => (d.id === id ? { ...d, ...data } : d)),
      );
      return { previous };
    },
    onError: (_err, _vars, context) => {
      if (context?.previous) {
        qc.setQueryData(orgKeys.departments, context.previous);
      }
    },
    onSettled: () => {
      void qc.invalidateQueries({ queryKey: orgKeys.departments });
    },
  });
}

/** Preview a department delete. Enabled only when an id is supplied. */
export function useDepartmentDependencies(id: string | null) {
  return useQuery<DepartmentDependenciesDto, NormalizedApiError>({
    queryKey: orgKeys.departmentDependencies(id ?? ''),
    queryFn: () => departmentDependencies(id as string),
    enabled: Boolean(id),
    // Always refetch: the whole point is to show the CURRENT membership at the
    // moment of the decision, not whatever it was earlier in the session.
    staleTime: 0,
  });
}

/**
 * Delete a department.
 *
 * NOT optimistic, deliberately. The server can legitimately answer 409 ("still
 * has members, tell me what to do with them"), and optimistically removing the
 * row would make a refused delete look like it worked until the refetch put it
 * back. Members and teams are invalidated too — a reassignment moves them.
 */
export function useDeleteDepartment() {
  const qc = useQueryClient();
  return useMutation<
    void,
    NormalizedApiError,
    { id: string; reassignTo?: string | null; force?: boolean }
  >({
    mutationFn: deleteDepartment,
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: orgKeys.departments });
      // A delete either unassigns its teams (SetNull) or moves them.
      void qc.invalidateQueries({ queryKey: orgKeys.teams });
      // Members' departmentId changed, which changes what they can see.
      void qc.invalidateQueries({ queryKey: userKeys.list });
    },
  });
}

// --- Teams -----------------------------------------------------------------

export function useTeams() {
  const accessToken = useSessionStore((s) => s.accessToken);
  return useQuery<TeamDto[], NormalizedApiError>({
    queryKey: orgKeys.teams,
    queryFn: listTeams,
    enabled: Boolean(accessToken),
  });
}

interface TeamsContext {
  previous?: TeamDto[];
}

/** Create (optimistic): append a temp team, roll back on error. */
export function useCreateTeam() {
  const qc = useQueryClient();
  return useMutation<TeamDto, NormalizedApiError, CreateTeamDto, TeamsContext>({
    mutationFn: createTeam,
    onMutate: async (payload) => {
      await qc.cancelQueries({ queryKey: orgKeys.teams });
      const previous = qc.getQueryData<TeamDto[]>(orgKeys.teams);
      const optimistic: TeamDto = {
        id: `temp_${Date.now()}`,
        companyId: '',
        name: payload.name,
        departmentId: payload.departmentId ?? null,
        createdAt: new Date().toISOString(),
      };
      qc.setQueryData<TeamDto[]>(orgKeys.teams, (old) => [
        ...(old ?? []),
        optimistic,
      ]);
      return { previous };
    },
    onError: (_err, _payload, context) => {
      if (context?.previous) {
        qc.setQueryData(orgKeys.teams, context.previous);
      }
    },
    onSettled: () => {
      void qc.invalidateQueries({ queryKey: orgKeys.teams });
    },
  });
}

interface UpdateTeamVars {
  id: string;
  data: UpdateTeamDto;
}

/** Update (optimistic): patch the cached row, roll back on error. */
export function useUpdateTeam() {
  const qc = useQueryClient();
  return useMutation<TeamDto, NormalizedApiError, UpdateTeamVars, TeamsContext>({
    mutationFn: updateTeam,
    onMutate: async ({ id, data }) => {
      await qc.cancelQueries({ queryKey: orgKeys.teams });
      const previous = qc.getQueryData<TeamDto[]>(orgKeys.teams);
      qc.setQueryData<TeamDto[]>(orgKeys.teams, (old) =>
        (old ?? []).map((t) => (t.id === id ? { ...t, ...data } : t)),
      );
      return { previous };
    },
    onError: (_err, _vars, context) => {
      if (context?.previous) {
        qc.setQueryData(orgKeys.teams, context.previous);
      }
    },
    onSettled: () => {
      void qc.invalidateQueries({ queryKey: orgKeys.teams });
    },
  });
}

/** Delete (optimistic): remove the row immediately, roll back on error. */
export function useDeleteTeam() {
  const qc = useQueryClient();
  return useMutation<void, NormalizedApiError, string, TeamsContext>({
    mutationFn: deleteTeam,
    onMutate: async (id) => {
      await qc.cancelQueries({ queryKey: orgKeys.teams });
      const previous = qc.getQueryData<TeamDto[]>(orgKeys.teams);
      qc.setQueryData<TeamDto[]>(orgKeys.teams, (old) =>
        (old ?? []).filter((t) => t.id !== id),
      );
      return { previous };
    },
    onError: (_err, _id, context) => {
      if (context?.previous) {
        qc.setQueryData(orgKeys.teams, context.previous);
      }
    },
    onSettled: () => {
      void qc.invalidateQueries({ queryKey: orgKeys.teams });
    },
  });
}

// --- Security policy -------------------------------------------------------

export function useSecurityPolicy() {
  const accessToken = useSessionStore((s) => s.accessToken);
  return useQuery<SecurityPolicyDto, NormalizedApiError>({
    queryKey: orgKeys.securityPolicy,
    queryFn: getSecurityPolicy,
    enabled: Boolean(accessToken),
  });
}

interface PolicyContext {
  previous?: SecurityPolicyDto;
}

/** Update (optimistic merge): patch the cached policy, roll back on error. */
export function useUpdateSecurityPolicy() {
  const qc = useQueryClient();
  return useMutation<
    SecurityPolicyDto,
    NormalizedApiError,
    UpdateSecurityPolicyDto,
    PolicyContext
  >({
    mutationFn: updateSecurityPolicy,
    onMutate: async (payload) => {
      await qc.cancelQueries({ queryKey: orgKeys.securityPolicy });
      const previous = qc.getQueryData<SecurityPolicyDto>(orgKeys.securityPolicy);
      if (previous) {
        qc.setQueryData<SecurityPolicyDto>(orgKeys.securityPolicy, {
          ...previous,
          ...payload,
        });
      }
      return { previous };
    },
    onError: (_err, _payload, context) => {
      if (context?.previous) {
        qc.setQueryData(orgKeys.securityPolicy, context.previous);
      }
    },
    onSettled: () => {
      void qc.invalidateQueries({ queryKey: orgKeys.securityPolicy });
    },
  });
}

// --- Audit log ---------------------------------------------------------------

/** Who-did-what feed. Backend restricts GET /audit-log to OWNER/ADMIN
 * (RolesGuard) -- only fetch when the current user can actually see it. */
export function useAuditLog() {
  const accessToken = useSessionStore((s) => s.accessToken);
  const canManage = useCanManageOrg();
  return useQuery<AuditLogDto[], NormalizedApiError>({
    queryKey: orgKeys.auditLog,
    queryFn: listAuditLog,
    enabled: Boolean(accessToken && canManage),
  });
}
