'use client';

import { useState } from 'react';
import { CheckCircle2, Circle } from 'lucide-react';
import { ONBOARDING_OWNER_TYPES, type OnboardingOwnerType } from '@vaep/types';
import { useCompleteOnboardingTask, useCreateOnboardingTask, useOnboardingTasks, useStaff } from '../hooks';

const inputCls = 'field-modern text-sm';

/**
 * Who is responsible for a checklist item. Imported from the shared contract
 * rather than written out here — the first version of this file guessed
 * `USER`/`DEPARTMENT` and every create 400'd against the backend's `@IsIn`.
 *
 * `AI_EMPLOYEE` is the interesting one: an onboarding item a hired AI Employee
 * owns, which is the whole reason this domain lives in an AI-employee product
 * rather than in a spreadsheet.
 */
const OWNER_LABELS: Record<OnboardingOwnerType, string> = {
  HUMAN: 'A person',
  AI_EMPLOYEE: 'An AI Employee',
};

function dueLabel(dueAt: string | null): { text: string; overdue: boolean } | null {
  if (!dueAt) return null;
  const ms = new Date(dueAt).getTime() - Date.now();
  const days = Math.round(Math.abs(ms) / 86_400_000);
  if (ms < 0) return { text: days === 0 ? 'due today' : `${days}d overdue`, overdue: true };
  return { text: days === 0 ? 'due today' : `due in ${days}d`, overdue: false };
}

/** The joining checklist for each new starter. */
export function OnboardingTasks({ staffId }: { staffId: string | null }) {
  const { data: tasks, isLoading } = useOnboardingTasks(staffId ?? undefined);
  const { data: staff } = useStaff();
  const create = useCreateOnboardingTask();
  const complete = useCompleteOnboardingTask();
  const [title, setTitle] = useState('');
  const [forStaffId, setForStaffId] = useState<string>(staffId ?? '');
  const [ownerType, setOwnerType] = useState<OnboardingOwnerType>('HUMAN');
  const [dueAt, setDueAt] = useState('');

  const nameOf = (id: string) =>
    staff?.find((s) => s.id === id)?.fullName ?? 'Unknown person';

  const target = staffId ?? forStaffId;

  const submit = () => {
    if (!title.trim() || !target) return;
    create.mutate(
      {
        staffId: target,
        title: title.trim(),
        ownerType,
        dueAt: dueAt ? new Date(dueAt).toISOString() : null,
      },
      {
        onSuccess: () => {
          setTitle('');
          setDueAt('');
        },
      },
    );
  };

  const open = (tasks ?? []).filter((t) => !t.completedAt);
  const done = (tasks ?? []).filter((t) => t.completedAt);

  return (
    <div className="space-y-4">
      {/* Adding a task needs a person. With no roster there is nothing to add
          one to, and a form that 400s is worse than one that explains. */}
      {(staff?.length ?? 0) === 0 ? (
        <p className="rounded-2xl border border-dashed border-app-border p-4 text-sm text-app-ink-2">
          Add someone to the roster first — an onboarding task belongs to a person.
        </p>
      ) : (
        <div className="rounded-2xl border border-app-border bg-app-surface p-4">
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
            <div className="lg:col-span-2">
              <label className="mb-1 block text-xs font-medium text-app-ink-2">
                Task
              </label>
              <input
                className={inputCls}
                value={title}
                onChange={(e) => setTitle(e.target.value)}
                placeholder="Set up laptop and accounts"
              />
            </div>
            {!staffId && (
              <div>
                <label className="mb-1 block text-xs font-medium text-app-ink-2">
                  For
                </label>
                <select
                  className={inputCls}
                  value={forStaffId}
                  onChange={(e) => setForStaffId(e.target.value)}
                >
                  <option value="">Choose a person…</option>
                  {(staff ?? []).map((s) => (
                    <option key={s.id} value={s.id}>
                      {s.fullName}
                    </option>
                  ))}
                </select>
              </div>
            )}
            <div>
              <label className="mb-1 block text-xs font-medium text-app-ink-2">
                Who does it
              </label>
              <select
                className={inputCls}
                value={ownerType}
                onChange={(e) =>
                  setOwnerType(e.target.value as OnboardingOwnerType)
                }
              >
                {ONBOARDING_OWNER_TYPES.map((t) => (
                  <option key={t} value={t}>
                    {OWNER_LABELS[t]}
                  </option>
                ))}
              </select>
            </div>
            <div>
              <label className="mb-1 block text-xs font-medium text-app-ink-2">
                Due
              </label>
              <input
                type="date"
                className={inputCls}
                value={dueAt}
                onChange={(e) => setDueAt(e.target.value)}
              />
            </div>
          </div>
          {create.isError && (
            <p className="mt-2 text-xs text-sl-failed">{create.error.message}</p>
          )}
          <button
            type="button"
            onClick={submit}
            disabled={!title.trim() || !target || create.isPending}
            className="mt-3 rounded-lg bg-violet px-4 py-1.5 text-sm font-medium text-white disabled:opacity-50"
          >
            {create.isPending ? 'Adding…' : 'Add task'}
          </button>
        </div>
      )}

      {isLoading ? (
        <p className="text-sm text-app-ink-3">Loading tasks…</p>
      ) : (tasks?.length ?? 0) === 0 ? (
        <p className="text-sm text-app-ink-3">
          No onboarding tasks yet.
        </p>
      ) : (
        <ul className="divide-y divide-app-border rounded-2xl border border-app-border bg-app-surface">
          {[...open, ...done].map((task) => {
            const due = dueLabel(task.dueAt);
            const isDone = Boolean(task.completedAt);
            return (
              <li key={task.id} className="flex items-start gap-3 p-4">
                <button
                  type="button"
                  onClick={() => !isDone && complete.mutate(task.id)}
                  disabled={isDone || complete.isPending}
                  aria-label={isDone ? 'Completed' : 'Mark complete'}
                  className="mt-0.5 shrink-0 text-app-ink-3 transition-colors hover:text-sl-active disabled:cursor-default"
                >
                  {isDone ? (
                    <CheckCircle2 className="h-4 w-4 text-sl-active" />
                  ) : (
                    <Circle className="h-4 w-4" />
                  )}
                </button>
                <div className="min-w-0 flex-1">
                  <p
                    className={`text-sm ${
                      isDone ? 'text-app-ink-3 line-through' : 'text-app-ink'
                    }`}
                  >
                    {task.title}
                  </p>
                  <p className="mt-0.5 text-xs text-app-ink-3">
                    {nameOf(task.staffId)}
                    {due && !isDone && (
                      <span className={due.overdue ? 'text-sl-failed' : undefined}>
                        {' '}
                        · {due.text}
                      </span>
                    )}
                    {/* A task an AI Employee produced from a workflow run —
                        worth surfacing, because it explains where it came from. */}
                    {task.runId && ' · created by a workflow run'}
                  </p>
                </div>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
