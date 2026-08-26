'use client';

import { useState } from 'react';
import { Search } from 'lucide-react';
import { useCurrentUser } from '@/features/auth/hooks';
import { useDepartments } from '@/features/organization/hooks';
import { formatScope } from '@/features/organization/labels';
import {
  useCanManageUsers,
  useCurrentRole,
  useDeleteUser,
  useUpdateUser,
  useUsers,
} from '../hooks';
import { ROLE_BADGE, ROLE_LABEL, STATUS_BADGE, STATUS_LABEL } from '../labels';
import { type Role, type UserDto } from '../schemas';

const ADMIN_ASSIGNABLE: Role[] = ['MEMBER', 'ADMIN'];
const OWNER_ASSIGNABLE: Role[] = ['MEMBER', 'ADMIN', 'OWNER'];

function initials(name: string): string {
  const parts = name.trim().split(/\s+/);
  return ((parts[0]?.[0] ?? '') + (parts[1]?.[0] ?? '')).toUpperCase() || 'U';
}

/** Company roster: role/status per user, with OWNER/ADMIN-gated mutation controls. */
export function UserList() {
  const { data: users, isLoading, isError, error } = useUsers();
  const { data: me } = useCurrentUser();
  const canManage = useCanManageUsers();
  const callerRole = useCurrentRole();
  // Any member may read the department list, so this needs no extra gating.
  const { data: departments } = useDepartments();
  const update = useUpdateUser();
  const del = useDeleteUser();
  const [query, setQuery] = useState('');

  const meId = me?.user.id;
  const roleOptions = callerRole === 'OWNER' ? OWNER_ASSIGNABLE : ADMIN_ASSIGNABLE;

  if (isLoading) {
    return (
      <div className="rounded-2xl border border-app-border bg-app-surface p-6">
        <p className="text-sm text-app-ink-3">Loading team…</p>
      </div>
    );
  }
  if (isError) {
    return (
      <div className="rounded-2xl border border-app-border bg-app-surface p-6">
        <p className="text-sm text-red-600">
          {error?.message ?? 'Could not load users'}
        </p>
      </div>
    );
  }

  const allUsers = users ?? [];
  const q = query.trim().toLowerCase();
  const rows = q
    ? allUsers.filter(
        (u) => u.name.toLowerCase().includes(q) || u.email.toLowerCase().includes(q),
      )
    : allUsers;

  // A row is editable when the caller can manage, it is not the caller's own
  // row, and the caller has authority over the target (only an OWNER edits an
  // OWNER). Mirrors the server-side guardrails so the UI never offers a no-op.
  const canEditRow = (u: UserDto): boolean =>
    canManage &&
    u.id !== meId &&
    !(u.role === 'OWNER' && callerRole !== 'OWNER');

  return (
    <div>
      <div className="relative mb-4 max-w-sm">
        <Search className="pointer-events-none absolute left-3.5 top-1/2 h-4 w-4 -translate-y-1/2 text-app-ink-3" />
        <input
          type="text"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Search members..."
          aria-label="Search members"
          className="field-modern"
          style={{ paddingLeft: '2.75rem' }}
        />
      </div>

      <div className="overflow-x-auto rounded-2xl border border-app-border bg-app-surface">
        <table className="min-w-full divide-y divide-app-border text-sm">
          <thead className="bg-app-surface text-left text-xs font-medium uppercase tracking-wide text-app-ink-3">
            <tr>
              <th className="px-4 py-3">Member</th>
              <th className="px-4 py-3">Role</th>
              <th className="px-4 py-3">Department</th>
              <th className="px-4 py-3">Status</th>
              {canManage && <th className="px-4 py-3 text-right">Actions</th>}
            </tr>
          </thead>
          <tbody className="divide-y divide-app-border">
            {rows.map((u) => {
              const editable = canEditRow(u);
              const isSelf = u.id === meId;
              return (
                <tr key={u.id} className="transition-colors hover:bg-app-raised">
                  <td className="px-4 py-3">
                    <div className="flex items-center gap-3">
                      <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-[linear-gradient(135deg,#6a30ec_0%,#5216dd_100%)] text-xs font-semibold text-white">
                        {initials(u.name)}
                      </span>
                      <div className="min-w-0">
                        <div className="truncate font-medium text-app-ink">
                          {u.name}
                          {isSelf && (
                            <span className="ml-2 text-xs font-normal text-app-ink-3">
                              (you)
                            </span>
                          )}
                        </div>
                        <div className="truncate text-xs text-app-ink-3">{u.email}</div>
                      </div>
                    </div>
                  </td>

                  <td className="px-4 py-3">
                    {editable ? (
                      <select
                        aria-label={`Role for ${u.name}`}
                        className="rounded-lg border border-app-border bg-app-surface px-2 py-1.5 text-xs text-app-ink transition-colors hover:border-app-border-strong focus:border-[#7c5cf0] focus:outline-none"
                        value={u.role}
                        disabled={update.isPending}
                        onChange={(e) =>
                          update.mutate({
                            id: u.id,
                            data: { role: e.target.value as Role },
                          })
                        }
                      >
                        {/* Keep the current role selectable even if outside the
                            assignable set (e.g. an existing OWNER). */}
                        {Array.from(new Set([u.role, ...roleOptions])).map((r) => (
                          <option key={r} value={r}>
                            {ROLE_LABEL[r]}
                          </option>
                        ))}
                      </select>
                    ) : (
                      <span
                        className={`inline-flex rounded-full px-2.5 py-1 text-xs font-semibold ${ROLE_BADGE[u.role]}`}
                      >
                        {ROLE_LABEL[u.role]}
                      </span>
                    )}
                  </td>

                  {/*
                    Department placement — the control that was missing.

                    `User.departmentId` has been in the schema, in the update
                    DTO and in the authorization policy since WAVE 2, and there
                    was no input for it anywhere in the product. That single
                    gap is what made department-scoped authorization, DEPARTMENT
                    approval routing and DEPARTMENT workflow permissions all
                    unreachable: none of them can resolve for a user who is in
                    no department, and nobody could put a user in one.

                    The backend validates that the department belongs to this
                    tenant (users.service), so a cross-tenant id is rejected
                    server-side, not merely absent from this list.
                  */}
                  <td className="px-4 py-3">
                    {editable ? (
                      <select
                        aria-label={`Department for ${u.name}`}
                        className="rounded-lg border border-app-border bg-app-surface px-2 py-1.5 text-xs text-app-ink transition-colors hover:border-app-border-strong focus:border-[#7c5cf0] focus:outline-none"
                        value={u.departmentId ?? ''}
                        disabled={update.isPending}
                        onChange={(e) =>
                          update.mutate({
                            id: u.id,
                            data: { departmentId: e.target.value || null },
                          })
                        }
                      >
                        <option value="">No department</option>
                        {(departments ?? []).map((d) => (
                          <option key={d.id} value={d.id}>
                            {d.name}
                            {d.scopes.length > 0 ? ` · ${d.scopes.map(formatScope).join(', ')}` : ''}
                          </option>
                        ))}
                      </select>
                    ) : (
                      <span className="text-xs text-app-ink-3">
                        {departments?.find((d) => d.id === u.departmentId)?.name ?? '—'}
                      </span>
                    )}
                  </td>

                  <td className="px-4 py-3">
                    <span
                      className={`inline-flex rounded-full px-2.5 py-1 text-xs font-semibold ${STATUS_BADGE[u.status]}`}
                    >
                      {STATUS_LABEL[u.status]}
                    </span>
                  </td>

                  {canManage && (
                    <td className="px-4 py-3">
                      <div className="flex items-center justify-end gap-2">
                        {editable && (
                          <>
                            <button
                              type="button"
                              disabled={update.isPending}
                              onClick={() =>
                                update.mutate({
                                  id: u.id,
                                  data: {
                                    status:
                                      u.status === 'ACTIVE' ? 'DISABLED' : 'ACTIVE',
                                  },
                                })
                              }
                              className="rounded-lg border border-app-border px-2.5 py-1 text-xs font-medium text-app-ink-2 transition-colors hover:border-app-border-strong hover:text-app-ink disabled:cursor-not-allowed disabled:opacity-50"
                            >
                              {u.status === 'ACTIVE' ? 'Disable' : 'Enable'}
                            </button>
                            <button
                              type="button"
                              disabled={del.isPending}
                              onClick={() => {
                                if (
                                  typeof window !== 'undefined' &&
                                  !window.confirm(`Remove ${u.name}?`)
                                ) {
                                  return;
                                }
                                del.mutate(u.id);
                              }}
                              className="rounded-lg border border-red-500/30 px-2.5 py-1 text-xs font-medium text-red-600 transition-colors hover:border-red-500/50 hover:bg-red-500/10 disabled:cursor-not-allowed disabled:opacity-50"
                            >
                              Remove
                            </button>
                          </>
                        )}
                      </div>
                    </td>
                  )}
                </tr>
              );
            })}
            {rows.length === 0 && (
              <tr>
                <td
                  colSpan={canManage ? 4 : 3}
                  className="px-4 py-6 text-center text-sm text-app-ink-3"
                >
                  {query ? 'No members match your search.' : 'No team members yet.'}
                </td>
              </tr>
            )}
          </tbody>
        </table>

        {(update.isError || del.isError) && (
          <p className="border-t border-app-border px-4 py-3 text-sm text-red-600">
            {update.error?.message ?? del.error?.message ?? 'Action failed'}
          </p>
        )}
      </div>
    </div>
  );
}
