'use client';

import { zodResolver } from '@hookform/resolvers/zod';
import { useState } from 'react';
import { useForm } from 'react-hook-form';
import { DEPARTMENT_PRESETS } from '@vaep/types';
import { Button } from '@/components/ui/Button';
import {
  useCanManageOrg,
  useCreateDepartment,
  useDepartments,
  useUpdateDepartment,
} from '../hooks';
import { DeleteDepartmentDialog } from './DeleteDepartmentDialog';
import { DepartmentScopeEditor } from './DepartmentScopeEditor';
import { formatScope } from '../labels';
import {
  createDepartmentSchema,
  type CreateDepartmentDto,
  type DepartmentDto,
} from '../schemas';

const secondaryBtnClass =
  'rounded-lg border border-app-border-strong bg-app-surface px-3.5 py-1.5 text-sm font-medium text-app-ink-2 transition-colors hover:border-app-border-strong hover:bg-app-raised disabled:cursor-not-allowed disabled:opacity-50';
const dangerBtnClass =
  'rounded-lg border border-app-border-strong bg-app-surface px-3.5 py-1.5 text-sm font-medium text-red-600 transition-colors hover:border-red-400/40 hover:bg-red-500/10 disabled:cursor-not-allowed disabled:opacity-50';
const labelClass = 'mb-1 block text-sm font-medium text-app-ink-2';

/** One department row: display + (OWNER/ADMIN) inline edit / access / remove. */
function DepartmentRow({
  dept,
  allDepartments,
  canManage,
}: {
  dept: DepartmentDto;
  allDepartments: DepartmentDto[];
  canManage: boolean;
}) {
  const update = useUpdateDepartment();
  const [editing, setEditing] = useState(false);
  const [scoping, setScoping] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [name, setName] = useState(dept.name);
  const [description, setDescription] = useState(dept.description ?? '');

  const save = () => {
    const trimmed = name.trim();
    if (!trimmed) return;
    update.mutate(
      {
        id: dept.id,
        data: { name: trimmed, description: description.trim() || null },
      },
      { onSuccess: () => setEditing(false) },
    );
  };

  if (editing) {
    return (
      <li className="flex flex-col gap-2 px-4 py-3 sm:flex-row sm:items-center">
        <input
          aria-label={`Name for ${dept.name}`}
          className="field-modern sm:max-w-xs"
          value={name}
          onChange={(e) => setName(e.target.value)}
        />
        <input
          aria-label={`Description for ${dept.name}`}
          className="field-modern"
          placeholder="Description (optional)"
          value={description}
          onChange={(e) => setDescription(e.target.value)}
        />
        <div className="flex shrink-0 gap-2">
          <Button type="button" variant="violet" onClick={save} disabled={update.isPending}>
            {update.isPending ? 'Saving…' : 'Save'}
          </Button>
          <button
            type="button"
            className={secondaryBtnClass}
            onClick={() => {
              setName(dept.name);
              setDescription(dept.description ?? '');
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
    <li className="px-4 py-3">
      <div className="flex items-center justify-between gap-3">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <span className="font-medium text-app-ink">{dept.name}</span>
            {/* The access state, always visible — not hidden behind an edit
                click. "Sees everything" is the honest label for no scopes. */}
            <span
              className={`rounded-full px-2 py-0.5 text-[11px] font-medium ${
                dept.scopes.length > 0
                  ? 'bg-violet/15 text-violet'
                  : 'bg-app-raised text-app-ink-3'
              }`}
            >
              {dept.scopes.length > 0
                ? `Limited to ${dept.scopes.map(formatScope).join(', ')}`
                : 'Sees everything'}
            </span>
          </div>
          {dept.description && (
            <div className="mt-0.5 text-xs text-app-ink-3">{dept.description}</div>
          )}
          <div className="mt-0.5 text-xs text-app-ink-3">
            {dept.memberCount} {dept.memberCount === 1 ? 'person' : 'people'}
            {dept.teamCount > 0 &&
              ` · ${dept.teamCount} ${dept.teamCount === 1 ? 'team' : 'teams'}`}
          </div>
        </div>
        {canManage && (
          <div className="flex shrink-0 gap-2">
            <button type="button" className={secondaryBtnClass} onClick={() => setEditing(true)}>
              Edit
            </button>
            <button
              type="button"
              className={secondaryBtnClass}
              onClick={() => setScoping((v) => !v)}
            >
              Access
            </button>
            <button
              type="button"
              className={dangerBtnClass}
              onClick={() => setDeleting(true)}
            >
              Remove
            </button>
          </div>
        )}
      </div>

      {scoping && (
        <div className="mt-3">
          <DepartmentScopeEditor dept={dept} onDone={() => setScoping(false)} />
        </div>
      )}

      {deleting && (
        <DeleteDepartmentDialog
          dept={dept}
          allDepartments={allDepartments}
          onClose={() => setDeleting(false)}
        />
      )}
    </li>
  );
}

/** Departments CRUD section (P1 #7). Mutations OWNER/ADMIN; reads open to all. */
export function DepartmentSection() {
  const { data: departments, isLoading, isError, error } = useDepartments();
  const canManage = useCanManageOrg();
  const create = useCreateDepartment();

  const {
    register,
    handleSubmit,
    reset,
    formState: { errors },
  } = useForm<CreateDepartmentDto>({
    resolver: zodResolver(createDepartmentSchema),
    defaultValues: { name: '', description: '' },
  });

  const onSubmit = handleSubmit((values) => {
    create.mutate(
      {
        name: values.name.trim(),
        description: values.description?.trim() || undefined,
      },
      { onSuccess: () => reset() },
    );
  });

  const rows = departments ?? [];

  // Presets not already created — a one-click way to add the common ones
  // without re-typing them. Purely a shortcut: a preset department is created
  // exactly like a typed one, with no scopes and therefore no restrictions.
  const missingPresets = DEPARTMENT_PRESETS.filter(
    (p) => !rows.some((d) => d.name.toLowerCase() === p.toLowerCase()),
  );

  return (
    <section className="rounded-2xl border border-app-border bg-app-surface p-5">
      <h2 className="mb-1 text-sm font-medium text-app-ink-2">Departments</h2>
      <p className="mb-4 text-xs text-app-ink-3">
        Group your people and decide what each group can work on. A new department
        can see everything until you limit it.
      </p>

      {canManage && missingPresets.length > 0 && (
        <div className="mb-4 flex flex-wrap items-center gap-2">
          <span className="text-xs text-app-ink-3">Quick add:</span>
          {missingPresets.map((preset) => (
            <button
              key={preset}
              type="button"
              className="rounded-full border border-app-border bg-app-surface px-3 py-1 text-xs font-medium text-app-ink-2 transition-colors hover:border-app-border-strong hover:bg-app-raised disabled:opacity-50"
              disabled={create.isPending}
              onClick={() => create.mutate({ name: preset })}
            >
              + {preset}
            </button>
          ))}
        </div>
      )}

      {canManage && (
        <form onSubmit={onSubmit} className="mb-4 space-y-3" noValidate>
          <div className="grid gap-3 sm:grid-cols-2">
            <div>
              <label htmlFor="dept-name" className={labelClass}>
                Name
              </label>
              <input
                id="dept-name"
                className="field-modern"
                placeholder="e.g. Engineering"
                {...register('name')}
              />
              {errors.name && (
                <p className="mt-1 text-sm text-red-600">{errors.name.message}</p>
              )}
            </div>
            <div>
              <label htmlFor="dept-desc" className={labelClass}>
                Description <span className="text-app-ink-3">(optional)</span>
              </label>
              <input
                id="dept-desc"
                className="field-modern"
                {...register('description')}
              />
            </div>
          </div>
          {create.isError && (
            <p className="text-sm text-red-600">
              {create.error?.message ?? 'Could not add department'}
            </p>
          )}
          <Button type="submit" variant="violet" disabled={create.isPending}>
            {create.isPending ? 'Adding…' : 'Add department'}
          </Button>
        </form>
      )}

      {isLoading ? (
        <p className="text-sm text-app-ink-3">Loading departments…</p>
      ) : isError ? (
        <p className="text-sm text-red-600">
          {error?.message ?? 'Could not load departments'}
        </p>
      ) : rows.length === 0 ? (
        <p className="text-sm text-app-ink-3">No departments yet.</p>
      ) : (
        <ul className="divide-y divide-app-border rounded-xl border border-app-border">
          {rows.map((d) => (
            <DepartmentRow
              key={d.id}
              dept={d}
              allDepartments={rows}
              canManage={canManage}
            />
          ))}
        </ul>
      )}
    </section>
  );
}
