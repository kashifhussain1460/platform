'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { CreateUserDto, Role, UpdateUserDto, UserDto } from '@vaep/types';
import type { NormalizedApiError } from '@/lib/apiClient';
import { useCurrentUser } from '@/features/auth/hooks';
import { useSessionStore } from '@/stores/session.store';
import { createUser, deleteUser, listUsers, updateUser } from './api';

export const userKeys = {
  all: ['users'] as const,
  list: ['users', 'list'] as const,
};

// --- Role helpers ----------------------------------------------------------

/** The current caller's role (from /auth/me, falling back to the session store). */
export function useCurrentRole(): Role | null {
  const { data: me } = useCurrentUser();
  const sessionUser = useSessionStore((s) => s.user);
  return me?.user.role ?? sessionUser?.role ?? null;
}

/** Whether the current user may manage the team (OWNER/ADMIN). Mirrors RolesGuard. */
export function useCanManageUsers(): boolean {
  const role = useCurrentRole();
  return role === 'OWNER' || role === 'ADMIN';
}

// --- Queries ---------------------------------------------------------------

/** The company's users. Enabled only when authenticated. */
export function useUsers() {
  const accessToken = useSessionStore((s) => s.accessToken);
  return useQuery<UserDto[], NormalizedApiError>({
    queryKey: userKeys.list,
    queryFn: listUsers,
    enabled: Boolean(accessToken),
  });
}

interface UsersContext {
  previous?: UserDto[];
}

// --- Mutations (optimistic) ------------------------------------------------

/** Create (optimistic): append a temp user, roll back on error, settle-invalidate. */
export function useCreateUser() {
  const qc = useQueryClient();
  return useMutation<UserDto, NormalizedApiError, CreateUserDto, UsersContext>({
    mutationFn: createUser,
    onMutate: async (payload) => {
      await qc.cancelQueries({ queryKey: userKeys.list });
      const previous = qc.getQueryData<UserDto[]>(userKeys.list);
      const optimistic: UserDto = {
        id: `temp_${Date.now()}`,
        companyId: '',
        email: payload.email,
        name: payload.name,
        phone: null,
        role: payload.role,
        status: 'ACTIVE',
        emailVerified: false,
        departmentId: null,
        teamId: null,
        managerUserId: null,
        createdAt: new Date().toISOString(),
      };
      qc.setQueryData<UserDto[]>(userKeys.list, (old) => [
        ...(old ?? []),
        optimistic,
      ]);
      return { previous };
    },
    onError: (_err, _payload, context) => {
      if (context?.previous) {
        qc.setQueryData(userKeys.list, context.previous);
      }
    },
    onSettled: () => {
      void qc.invalidateQueries({ queryKey: userKeys.list });
    },
  });
}

interface UpdateVars {
  id: string;
  data: UpdateUserDto;
}

/** Update (optimistic role/status/name): patch the cached row, roll back on error. */
export function useUpdateUser() {
  const qc = useQueryClient();
  return useMutation<UserDto, NormalizedApiError, UpdateVars, UsersContext>({
    mutationFn: updateUser,
    onMutate: async ({ id, data }) => {
      await qc.cancelQueries({ queryKey: userKeys.list });
      const previous = qc.getQueryData<UserDto[]>(userKeys.list);
      qc.setQueryData<UserDto[]>(userKeys.list, (old) =>
        (old ?? []).map((u) => (u.id === id ? { ...u, ...data } : u)),
      );
      return { previous };
    },
    onError: (_err, _vars, context) => {
      if (context?.previous) {
        qc.setQueryData(userKeys.list, context.previous);
      }
    },
    onSettled: () => {
      void qc.invalidateQueries({ queryKey: userKeys.list });
    },
  });
}

/** Delete (optimistic): remove the row immediately, roll back on error. */
export function useDeleteUser() {
  const qc = useQueryClient();
  return useMutation<void, NormalizedApiError, string, UsersContext>({
    mutationFn: deleteUser,
    onMutate: async (id) => {
      await qc.cancelQueries({ queryKey: userKeys.list });
      const previous = qc.getQueryData<UserDto[]>(userKeys.list);
      qc.setQueryData<UserDto[]>(userKeys.list, (old) =>
        (old ?? []).filter((u) => u.id !== id),
      );
      return { previous };
    },
    onError: (_err, _id, context) => {
      if (context?.previous) {
        qc.setQueryData(userKeys.list, context.previous);
      }
    },
    onSettled: () => {
      void qc.invalidateQueries({ queryKey: userKeys.list });
    },
  });
}
