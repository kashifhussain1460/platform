'use client';

import { zodResolver } from '@hookform/resolvers/zod';
import { useState } from 'react';
import { useForm } from 'react-hook-form';
import { Button } from '@/components/ui/Button';
import {
  useCanManageOrg,
  useCreateTeam,
  useDeleteTeam,
  useDepartments,
  useTeams,
  useUpdateTeam,
} from '../hooks';
import {
  createTeamSchema,
  type CreateTeamDto,
  type DepartmentDto,
  type TeamDto,
} from '../schemas';

const secondaryBtnClass =
  'rounded-lg border border-app-border-strong bg-app-surface px-3.5 py-1.5 text-sm font-medium text-app-ink-2 transition-colors hover:border-app-border-strong hover:bg-app-raised disabled:cursor-not-allowed disabled:opacity-50';
const dangerBtnClass =
  'rounded-lg border border-app-border-strong bg-app-surface px-3.5 py-1.5 text-sm font-medium text-red-600 transition-colors hover:border-red-400/40 hover:bg-red-500/10 disabled:cursor-not-allowed disabled:opacity-50';
const labelClass = 'mb-1 block text-sm font-medium text-app-ink-2';

/** '' (no selection) → null so the nullable schema/API accept "no department". */
const toDeptId = (v: unknown): string | null =>
  v === '' || v === null || v === undefined ? null : (v as string);

/** One team row: display + (OWNER/ADMIN) inline edit / remove. */
function TeamRow({
  team,
  departments,
  canManage,
}: {
  team: TeamDto;
  departments: DepartmentDto[];
  canManage: boolean;
}) {
  const update = useUpdateTeam();
  const del = useDeleteTeam();
  const [editing, setEditing] = useState(false);
  const [name, setName] = useState(team.name);
  const [departmentId, setDepartmentId] = useState(team.departmentId ?? '');

  const deptName =
    departments.find((d) => d.id === team.departmentId)?.name ?? null;

  const save = () => {
    const trimmed = name.trim();
    if (!trimmed) return;
    update.mutate(
      { id: team.id, data: { name: trimmed, departmentId: toDeptId(departmentId) } },
      { onSuccess: () => setEditing(false) },
    );
  };

  if (editing) {
    return (
      <li className="flex flex-col gap-2 px-4 py-3 sm:flex-row sm:items-center">
        <input
          aria-label={`Name for ${team.name}`}
          className="field-modern sm:max-w-xs"
          value={name}
          onChange={(e) => setName(e.target.value)}
        />
        <select
          aria-label={`Department for ${team.name}`}
          className="field-modern sm:max-w-xs"
          value={departmentId}
          onChange={(e) => setDepartmentId(e.target.value)}
        >
          <option value="">No department</option>
          {departments.map((d) => (
            <option key={d.id} value={d.id}>
              {d.name}
            </option>
          ))}
        </select>
        <div className="flex shrink-0 gap-2">
          <Button type="button" variant="violet" onClick={save} disabled={update.isPending}>
            {update.isPending ? 'Saving…' : 'Save'}
          </Button>
          <button
            type="button"
            className={secondaryBtnClass}
            onClick={() => {
              setName(team.name);
              setDepartmentId(team.departmentId ?? '');
              setEditing(false);
            }}
          >
            Cancel
          </button>
        </div>
      </li>
    );
  }

  return (
    <li className="flex items-center justify-between gap-3 px-4 py-3">
      <div>
        <div className="font-medium text-app-ink">{team.name}</div>
        <div className="text-xs text-app-ink-3">
          {deptName ? deptName : <span className="text-app-ink-3">No department</span>}
        </div>
      </div>
      {canManage && (
        <div className="flex shrink-0 gap-2">
          <button type="button" className={secondaryBtnClass} onClick={() => setEditing(true)}>
            Edit
          </button>
          <button
            type="button"
            className={dangerBtnClass}
            disabled={del.isPending}
            onClick={() => {
              if (
                typeof window !== 'undefined' &&
                !window.confirm(`Remove team "${team.name}"?`)
              ) {
                return;
              }
              del.mutate(team.id);
            }}
          >
            Remove
          </button>
        </div>
      )}
    </li>
  );
}

/** Teams CRUD section (P1 #7). Mutations OWNER/ADMIN; reads open to all. */
export function TeamSection() {
  const { data: teams, isLoading, isError, error } = useTeams();
  const { data: departments } = useDepartments();
  const canManage = useCanManageOrg();
  const create = useCreateTeam();

  const {
    register,
    handleSubmit,
    reset,
    formState: { errors },
  } = useForm<CreateTeamDto>({
    resolver: zodResolver(createTeamSchema),
    defaultValues: { name: '', departmentId: null },
  });

  const onSubmit = handleSubmit((values) => {
    create.mutate(
      { name: values.name.trim(), departmentId: values.departmentId ?? null },
      { onSuccess: () => reset() },
    );
  });

  const depts = departments ?? [];
  const rows = teams ?? [];

  return (
    <section className="rounded-2xl border border-app-border bg-app-surface p-5">
      <h2 className="mb-4 text-sm font-medium text-app-ink-2">Teams</h2>

      {canManage && (
        <form onSubmit={onSubmit} className="mb-4 space-y-3" noValidate>
          <div className="grid gap-3 sm:grid-cols-2">
            <div>
              <label htmlFor="team-name" className={labelClass}>
                Name
              </label>
              <input
                id="team-name"
                className="field-modern"
                placeholder="e.g. Platform"
                {...register('name')}
              />
              {errors.name && (
                <p className="mt-1 text-sm text-red-600">{errors.name.message}</p>
              )}
            </div>
            <div>
              <label htmlFor="team-dept" className={labelClass}>
                Department <span className="text-app-ink-3">(optional)</span>
              </label>
              <select
                id="team-dept"
                className="field-modern"
                {...register('departmentId', { setValueAs: toDeptId })}
              >
                <option value="">No department</option>
                {depts.map((d) => (
                  <option key={d.id} value={d.id}>
                    {d.name}
                  </option>
                ))}
              </select>
            </div>
          </div>
          {create.isError && (
            <p className="text-sm text-red-600">
              {create.error?.message ?? 'Could not add team'}
            </p>
          )}
          <Button type="submit" variant="violet" disabled={create.isPending}>
            {create.isPending ? 'Adding…' : 'Add team'}
          </Button>
        </form>
      )}

      {isLoading ? (
        <p className="text-sm text-app-ink-3">Loading teams…</p>
      ) : isError ? (
        <p className="text-sm text-red-600">
          {error?.message ?? 'Could not load teams'}
        </p>
      ) : rows.length === 0 ? (
        <p className="text-sm text-app-ink-3">No teams yet.</p>
      ) : (
        <ul className="divide-y divide-app-border rounded-xl border border-app-border">
          {rows.map((t) => (
            <TeamRow key={t.id} team={t} departments={depts} canManage={canManage} />
          ))}
        </ul>
      )}
    </section>
  );
}
