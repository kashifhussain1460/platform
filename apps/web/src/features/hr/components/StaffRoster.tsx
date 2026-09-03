'use client';

import { useState } from 'react';
import type { CreateStaffMemberDto, StaffMemberDto } from '@vaep/types';
import { useDepartments } from '@/features/organization/hooks';
import { useCreateStaff, useStaff } from '../hooks';

const inputCls = 'field-modern text-sm';

/** The employment statuses the backend accepts, in the order HR thinks about them. */
const STATUSES = ['ACTIVE', 'ON_LEAVE', 'SUSPENDED', 'EXITED'] as const;
const EMPLOYMENT_TYPES = ['FULL_TIME', 'PART_TIME', 'CONTRACT', 'INTERN'] as const;

const STATUS_STYLE: Record<string, string> = {
  ACTIVE: 'bg-status-active/15 text-sl-active',
  ON_LEAVE: 'bg-app-raised text-app-ink-2',
  SUSPENDED: 'bg-status-warning/15 text-sl-warning',
  EXITED: 'bg-app-raised text-app-ink-3',
};

function humanise(value: string): string {
  return value
    .toLowerCase()
    .split('_')
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(' ');
}

/**
 * The people this company employs — the roster the entire HR domain hangs off.
 *
 * ## A note on what is shown
 *
 * `personalEmail` and `phone` are special-category personal data, encrypted at
 * rest (`v1:` envelope) and decrypted only on the way out of the API. They are
 * deliberately NOT in this list: a roster is something people leave open on a
 * shared screen, and the work email is what anyone needs to do their job. They
 * remain visible on the individual record where looking at them is a
 * deliberate act.
 */
export function StaffRoster({
  onSelect,
  selectedId,
}: {
  onSelect: (id: string | null) => void;
  selectedId: string | null;
}) {
  const { data: staff, isLoading } = useStaff();
  const { data: departments } = useDepartments();
  const create = useCreateStaff();
  const [adding, setAdding] = useState(false);
  const [form, setForm] = useState<CreateStaffMemberDto>({ fullName: '' });

  const departmentName = (id: string | null) =>
    departments?.find((d) => d.id === id)?.name ?? null;

  const submit = () => {
    if (!form.fullName.trim()) return;
    create.mutate(
      {
        ...form,
        fullName: form.fullName.trim(),
        // Empty strings would be stored as empty strings; the column means
        // "unknown", which is null.
        workEmail: form.workEmail?.trim() || null,
        jobTitle: form.jobTitle?.trim() || null,
        departmentId: form.departmentId || null,
        employmentType: form.employmentType || null,
      },
      {
        onSuccess: () => {
          setForm({ fullName: '' });
          setAdding(false);
        },
      },
    );
  };

  return (
    <section>
      <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
        <h2 className="font-display text-base font-semibold text-app-ink">
          People ({staff?.length ?? 0})
        </h2>
        <button
          type="button"
          onClick={() => setAdding((v) => !v)}
          className="rounded-lg border border-app-border-strong px-3 py-1.5 text-sm font-medium text-app-ink hover:bg-app-raised"
        >
          {adding ? 'Cancel' : 'Add a person'}
        </button>
      </div>

      {adding && (
        <div className="mb-4 rounded-2xl border border-app-border bg-app-surface p-4">
          <div className="grid gap-3 sm:grid-cols-2">
            <div>
              <label className="mb-1 block text-xs font-medium text-app-ink-2">
                Full name
              </label>
              <input
                className={inputCls}
                value={form.fullName}
                onChange={(e) => setForm({ ...form, fullName: e.target.value })}
                placeholder="Priya Sharma"
              />
            </div>
            <div>
              <label className="mb-1 block text-xs font-medium text-app-ink-2">
                Work email
              </label>
              <input
                className={inputCls}
                value={form.workEmail ?? ''}
                onChange={(e) => setForm({ ...form, workEmail: e.target.value })}
                placeholder="priya@company.com"
              />
            </div>
            <div>
              <label className="mb-1 block text-xs font-medium text-app-ink-2">
                Job title
              </label>
              <input
                className={inputCls}
                value={form.jobTitle ?? ''}
                onChange={(e) => setForm({ ...form, jobTitle: e.target.value })}
                placeholder="Senior Designer"
              />
            </div>
            <div>
              <label className="mb-1 block text-xs font-medium text-app-ink-2">
                Department
              </label>
              <select
                className={inputCls}
                value={form.departmentId ?? ''}
                onChange={(e) =>
                  setForm({ ...form, departmentId: e.target.value || null })
                }
              >
                <option value="">Not set</option>
                {(departments ?? []).map((d) => (
                  <option key={d.id} value={d.id}>
                    {d.name}
                  </option>
                ))}
              </select>
            </div>
            <div>
              <label className="mb-1 block text-xs font-medium text-app-ink-2">
                Employment type
              </label>
              <select
                className={inputCls}
                value={form.employmentType ?? ''}
                onChange={(e) =>
                  setForm({ ...form, employmentType: e.target.value || null })
                }
              >
                <option value="">Not set</option>
                {EMPLOYMENT_TYPES.map((t) => (
                  <option key={t} value={t}>
                    {humanise(t)}
                  </option>
                ))}
              </select>
            </div>
            <div>
              <label className="mb-1 block text-xs font-medium text-app-ink-2">
                Start date
              </label>
              <input
                type="date"
                className={inputCls}
                value={form.hiredAt?.slice(0, 10) ?? ''}
                onChange={(e) =>
                  setForm({
                    ...form,
                    hiredAt: e.target.value
                      ? new Date(e.target.value).toISOString()
                      : null,
                  })
                }
              />
            </div>
          </div>
          {create.isError && (
            <p className="mt-2 text-xs text-sl-failed">{create.error.message}</p>
          )}
          <button
            type="button"
            onClick={submit}
            disabled={!form.fullName.trim() || create.isPending}
            className="mt-3 rounded-lg bg-violet px-4 py-1.5 text-sm font-medium text-white disabled:opacity-50"
          >
            {create.isPending ? 'Adding…' : 'Add'}
          </button>
        </div>
      )}

      {isLoading ? (
        <p className="text-sm text-app-ink-3">Loading people…</p>
      ) : !staff || staff.length === 0 ? (
        <div className="rounded-2xl border border-dashed border-app-border p-6 text-center">
          <p className="text-sm text-app-ink-2">Nobody on the roster yet.</p>
          <p className="mt-1 text-xs text-app-ink-3">
            Add the people you employ so your HR AI Employee can handle their leave,
            onboarding and reviews.
          </p>
        </div>
      ) : (
        <div className="overflow-x-auto rounded-2xl border border-app-border">
          <table className="w-full min-w-[640px] text-left text-sm">
            <thead className="bg-app-surface text-xs uppercase tracking-wide text-app-ink-3">
              <tr>
                <th className="px-4 py-3 font-medium">Name</th>
                <th className="px-4 py-3 font-medium">Job title</th>
                <th className="px-4 py-3 font-medium">Department</th>
                <th className="px-4 py-3 font-medium">Status</th>
                <th className="px-4 py-3 font-medium" />
              </tr>
            </thead>
            <tbody className="divide-y divide-app-border">
              {staff.map((person: StaffMemberDto) => (
                <tr
                  key={person.id}
                  className={`transition-colors hover:bg-app-raised ${
                    selectedId === person.id ? 'bg-app-raised' : ''
                  }`}
                >
                  <td className="px-4 py-3">
                    <p className="font-medium text-app-ink">{person.fullName}</p>
                    {person.workEmail && (
                      <p className="text-xs text-app-ink-3">{person.workEmail}</p>
                    )}
                  </td>
                  <td className="px-4 py-3 text-app-ink-2">
                    {person.jobTitle ?? '—'}
                  </td>
                  <td className="px-4 py-3 text-app-ink-2">
                    {departmentName(person.departmentId) ?? '—'}
                  </td>
                  <td className="px-4 py-3">
                    <span
                      className={`rounded-full px-2 py-0.5 text-xs font-medium ${
                        STATUS_STYLE[person.status] ?? 'bg-app-raised text-app-ink-2'
                      }`}
                    >
                      {humanise(person.status)}
                    </span>
                  </td>
                  <td className="px-4 py-3 text-right">
                    <button
                      type="button"
                      onClick={() =>
                        onSelect(selectedId === person.id ? null : person.id)
                      }
                      className="text-sm font-medium text-violet hover:text-app-ink"
                    >
                      {selectedId === person.id ? 'Clear filter' : 'View their items'}
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}

export { humanise, STATUSES };
