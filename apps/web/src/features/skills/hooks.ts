'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type {
  ConfigureSkillDto,
  ConnectorHealthDto,
  ConnectSkillDto,
  EmployeeSkillDto,
  InstallSkillDto,
  InstalledSkillDto,
  SkillDefinitionDto,
  UpdateInstalledSkillDto,
} from '@vaep/types';
import type { NormalizedApiError } from '@/lib/apiClient';
import { useSessionStore } from '@/stores/session.store';
import {
  assignSkill,
  checkConnectorHealth,
  configureSkill,
  connectSkill,
  disconnectSkill,
  installSkill,
  listCatalog,
  listEmployeeSkills,
  listInstalledSkills,
  unassignSkill,
  uninstallSkill,
  updateInstalledSkill,
  verifyConnection,
  type VerifyConnectionResult,
} from './api';

export const skillKeys = {
  catalog: ['skills', 'catalog'] as const,
  installed: ['skills', 'installed'] as const,
  employeeSkills: (employeeId: string) =>
    ['employees', employeeId, 'skills'] as const,
};

// --- Catalog + installed skills --------------------------------------------

/** The built-in catalog is static, so it never goes stale within a session. */
export function useCatalog() {
  const accessToken = useSessionStore((s) => s.accessToken);
  return useQuery<SkillDefinitionDto[], NormalizedApiError>({
    queryKey: skillKeys.catalog,
    queryFn: listCatalog,
    enabled: Boolean(accessToken),
    staleTime: Infinity,
  });
}

export function useInstalledSkills() {
  const accessToken = useSessionStore((s) => s.accessToken);
  return useQuery<InstalledSkillDto[], NormalizedApiError>({
    queryKey: skillKeys.installed,
    queryFn: listInstalledSkills,
    enabled: Boolean(accessToken),
  });
}

interface InstalledContext {
  previous?: InstalledSkillDto[];
}

/** Install (optimistic): prepend a temp installed skill, roll back on error. */
export function useInstallSkill() {
  const qc = useQueryClient();
  return useMutation<
    InstalledSkillDto,
    NormalizedApiError,
    InstallSkillDto,
    InstalledContext
  >({
    mutationFn: installSkill,
    onMutate: async (payload) => {
      await qc.cancelQueries({ queryKey: skillKeys.installed });
      const previous = qc.getQueryData<InstalledSkillDto[]>(
        skillKeys.installed,
      );
      const optimistic: InstalledSkillDto = {
        id: `temp_${Date.now()}`,
        companyId: '',
        skillKey: payload.skillKey,
        employeeId: payload.employeeId ?? null,
        displayName: payload.displayName ?? payload.skillKey,
        config: payload.config ?? null,
        enabled: true,
        connectionType: null,
        connectionStatus: 'NOT_CONNECTED',
        credentialsSet: false,
        createdAt: new Date().toISOString(),
      };
      qc.setQueryData<InstalledSkillDto[]>(skillKeys.installed, (old) => [
        optimistic,
        ...(old ?? []),
      ]);
      return { previous };
    },
    onError: (_err, _payload, context) => {
      if (context?.previous) {
        qc.setQueryData(skillKeys.installed, context.previous);
      }
    },
    onSettled: () => {
      void qc.invalidateQueries({ queryKey: skillKeys.installed });
    },
  });
}

interface UpdateInstalledVars {
  id: string;
  data: UpdateInstalledSkillDto;
}

/** Update (optimistic enable/disable/config): patch the cached row. */
export function useUpdateInstalledSkill() {
  const qc = useQueryClient();
  return useMutation<
    InstalledSkillDto,
    NormalizedApiError,
    UpdateInstalledVars,
    InstalledContext
  >({
    mutationFn: updateInstalledSkill,
    onMutate: async ({ id, data }) => {
      await qc.cancelQueries({ queryKey: skillKeys.installed });
      const previous = qc.getQueryData<InstalledSkillDto[]>(
        skillKeys.installed,
      );
      qc.setQueryData<InstalledSkillDto[]>(skillKeys.installed, (old) =>
        (old ?? []).map((s) => (s.id === id ? { ...s, ...data } : s)),
      );
      return { previous };
    },
    onError: (_err, _vars, context) => {
      if (context?.previous) {
        qc.setQueryData(skillKeys.installed, context.previous);
      }
    },
    onSettled: () => {
      void qc.invalidateQueries({ queryKey: skillKeys.installed });
    },
  });
}

/** Uninstall (optimistic): remove the row immediately, roll back on error. */
export function useUninstallSkill() {
  const qc = useQueryClient();
  return useMutation<void, NormalizedApiError, string, InstalledContext>({
    mutationFn: uninstallSkill,
    onMutate: async (id) => {
      await qc.cancelQueries({ queryKey: skillKeys.installed });
      const previous = qc.getQueryData<InstalledSkillDto[]>(
        skillKeys.installed,
      );
      qc.setQueryData<InstalledSkillDto[]>(skillKeys.installed, (old) =>
        (old ?? []).filter((s) => s.id !== id),
      );
      return { previous };
    },
    onError: (_err, _id, context) => {
      if (context?.previous) {
        qc.setQueryData(skillKeys.installed, context.previous);
      }
    },
    onSettled: () => {
      void qc.invalidateQueries({ queryKey: skillKeys.installed });
    },
  });
}

interface ConfigureVars {
  id: string;
  data: ConfigureSkillDto;
}

/** Configure (optimistic): merge the submitted config into the cached row. */
export function useConfigureSkill() {
  const qc = useQueryClient();
  return useMutation<
    InstalledSkillDto,
    NormalizedApiError,
    ConfigureVars,
    InstalledContext
  >({
    mutationFn: configureSkill,
    onMutate: async ({ id, data }) => {
      await qc.cancelQueries({ queryKey: skillKeys.installed });
      const previous = qc.getQueryData<InstalledSkillDto[]>(
        skillKeys.installed,
      );
      qc.setQueryData<InstalledSkillDto[]>(skillKeys.installed, (old) =>
        (old ?? []).map((s) =>
          s.id === id
            ? { ...s, config: { ...(s.config ?? {}), ...data.config } }
            : s,
        ),
      );
      return { previous };
    },
    onError: (_err, _vars, context) => {
      if (context?.previous) {
        qc.setQueryData(skillKeys.installed, context.previous);
      }
    },
    onSettled: () => {
      void qc.invalidateQueries({ queryKey: skillKeys.installed });
    },
  });
}

interface ConnectVars {
  id: string;
  data: ConnectSkillDto;
}

/** Connect (optimistic): flip the cached row to CONNECTED. */
export function useConnectSkill() {
  const qc = useQueryClient();
  return useMutation<
    InstalledSkillDto,
    NormalizedApiError,
    ConnectVars,
    InstalledContext
  >({
    mutationFn: connectSkill,
    onMutate: async ({ id }) => {
      await qc.cancelQueries({ queryKey: skillKeys.installed });
      const previous = qc.getQueryData<InstalledSkillDto[]>(
        skillKeys.installed,
      );
      qc.setQueryData<InstalledSkillDto[]>(skillKeys.installed, (old) =>
        (old ?? []).map((s) =>
          s.id === id
            ? { ...s, connectionStatus: 'CONNECTED', credentialsSet: true }
            : s,
        ),
      );
      return { previous };
    },
    onError: (_err, _vars, context) => {
      if (context?.previous) {
        qc.setQueryData(skillKeys.installed, context.previous);
      }
    },
    onSettled: () => {
      void qc.invalidateQueries({ queryKey: skillKeys.installed });
    },
  });
}

/** Disconnect (optimistic): flip the cached row to NOT_CONNECTED. */
export function useDisconnectSkill() {
  const qc = useQueryClient();
  return useMutation<
    InstalledSkillDto,
    NormalizedApiError,
    string,
    InstalledContext
  >({
    mutationFn: disconnectSkill,
    onMutate: async (id) => {
      await qc.cancelQueries({ queryKey: skillKeys.installed });
      const previous = qc.getQueryData<InstalledSkillDto[]>(
        skillKeys.installed,
      );
      qc.setQueryData<InstalledSkillDto[]>(skillKeys.installed, (old) =>
        (old ?? []).map((s) =>
          s.id === id
            ? { ...s, connectionStatus: 'NOT_CONNECTED', credentialsSet: false }
            : s,
        ),
      );
      return { previous };
    },
    onError: (_err, _id, context) => {
      if (context?.previous) {
        qc.setQueryData(skillKeys.installed, context.previous);
      }
    },
    onSettled: () => {
      void qc.invalidateQueries({ queryKey: skillKeys.installed });
    },
  });
}

/**
 * Run a connector health check (Unit B): probe now, then refetch the installed
 * list so the status badge reflects any transition (e.g. DEGRADED → CONNECTED).
 * The mutation result carries the fresh ConnectorHealthDto for inline display.
 */
export function useCheckConnectorHealth() {
  const qc = useQueryClient();
  return useMutation<ConnectorHealthDto, NormalizedApiError, string>({
    mutationFn: checkConnectorHealth,
    onSettled: () => {
      void qc.invalidateQueries({ queryKey: skillKeys.installed });
    },
  });
}

/**
 * Run the connection verification (plan §3). Invalidates the installed list
 * because a pass/fail CHANGES `connectionStatus` server-side — the wizard and
 * the skill row must not disagree about whether the connector is live.
 */
export function useVerifyConnection() {
  const qc = useQueryClient();
  return useMutation<
    VerifyConnectionResult,
    NormalizedApiError,
    { id: string; sendTest?: boolean; testTo?: string }
  >({
    mutationFn: verifyConnection,
    onSettled: () => {
      void qc.invalidateQueries({ queryKey: skillKeys.installed });
      // The AI Assist skill card reads a different key; a verified connection
      // must clear its "not connected" state too.
      void qc.invalidateQueries({ queryKey: ['skill-requirements'] });
    },
  });
}

// --- Employee ↔ skill assignments ------------------------------------------

export function useEmployeeSkills(employeeId: string) {
  const accessToken = useSessionStore((s) => s.accessToken);
  return useQuery<EmployeeSkillDto[], NormalizedApiError>({
    queryKey: skillKeys.employeeSkills(employeeId),
    queryFn: () => listEmployeeSkills(employeeId),
    enabled: Boolean(accessToken && employeeId),
  });
}

interface EmployeeSkillsContext {
  previous?: EmployeeSkillDto[];
}

/** Assign (optimistic): append a temp assignment for this employee. */
export function useAssignSkill(employeeId: string) {
  const qc = useQueryClient();
  const key = skillKeys.employeeSkills(employeeId);
  return useMutation<
    EmployeeSkillDto,
    NormalizedApiError,
    { installedSkillId: string },
    EmployeeSkillsContext
  >({
    mutationFn: ({ installedSkillId }) =>
      assignSkill({ employeeId, installedSkillId }),
    onMutate: async ({ installedSkillId }) => {
      await qc.cancelQueries({ queryKey: key });
      const previous = qc.getQueryData<EmployeeSkillDto[]>(key);
      const optimistic: EmployeeSkillDto = {
        id: `temp_${Date.now()}`,
        companyId: '',
        employeeId,
        installedSkillId,
        createdAt: new Date().toISOString(),
      };
      qc.setQueryData<EmployeeSkillDto[]>(key, (old) => [
        ...(old ?? []),
        optimistic,
      ]);
      return { previous };
    },
    onError: (_err, _vars, context) => {
      if (context?.previous) {
        qc.setQueryData(key, context.previous);
      }
    },
    onSettled: () => {
      void qc.invalidateQueries({ queryKey: key });
    },
  });
}

/** Unassign (optimistic): drop the assignment for this employee. */
export function useUnassignSkill(employeeId: string) {
  const qc = useQueryClient();
  const key = skillKeys.employeeSkills(employeeId);
  return useMutation<
    void,
    NormalizedApiError,
    { installedSkillId: string },
    EmployeeSkillsContext
  >({
    mutationFn: ({ installedSkillId }) =>
      unassignSkill({ employeeId, installedSkillId }),
    onMutate: async ({ installedSkillId }) => {
      await qc.cancelQueries({ queryKey: key });
      const previous = qc.getQueryData<EmployeeSkillDto[]>(key);
      qc.setQueryData<EmployeeSkillDto[]>(key, (old) =>
        (old ?? []).filter((s) => s.installedSkillId !== installedSkillId),
      );
      return { previous };
    },
    onError: (_err, _vars, context) => {
      if (context?.previous) {
        qc.setQueryData(key, context.previous);
      }
    },
    onSettled: () => {
      void qc.invalidateQueries({ queryKey: key });
    },
  });
}
