'use client';

import { zodResolver } from '@hookform/resolvers/zod';
import { useState } from 'react';
import { useForm } from 'react-hook-form';
import type { AiEmployeeDto } from '@vaep/types';
import { Button } from '@/components/ui/Button';
import { useUpdateEmployee } from '../hooks';
import { APPROVAL_RULE_OPTIONS, PERMISSION_OPTIONS } from '../labels';
import {
  KNOWLEDGE_ACCESSES,
  employeeSettingsSchema,
  type EmployeeSettingsDto,
  type KpiTargets,
} from '../schemas';

const inputClass = 'field-modern';
const secondaryBtnClass =
  'rounded-xl border border-app-border-strong bg-app-surface px-4 py-2 text-sm font-medium text-app-ink-2 transition-colors hover:border-app-border-strong hover:bg-app-raised disabled:cursor-not-allowed disabled:opacity-50';

/**
 * Turn a stored record into a full {key: boolean} map for the checkboxes.
 *
 * `whenUnset` is the Phase 1 fix, and it matters more than it looks.
 *
 * This helper used to hard-code `Boolean(record?.[key])`, so an employee with
 * NO stored permissions rendered four unticked boxes — and merely opening
 * Settings and pressing Save persisted `{sendEmail:false, …}`, i.e. "deny
 * everything". That was harmless only because nothing enforced the flags.
 * Now that they ARE enforced, the same default would silently revoke email,
 * messaging and payment tools from every employee an admin ever looked at.
 *
 * So permissions default to GRANTED when unset (matching the API's "key absent
 * = allowed" rule), while approval rules default to OFF (absent = no extra
 * gate). Same widget, opposite safe direction, because one grants and the
 * other restricts.
 */
function toFlags<K extends string>(
  record: Partial<Record<K, boolean>> | null,
  options: readonly { key: K }[],
  whenUnset: boolean,
): Record<K, boolean> {
  const out = {} as Record<K, boolean>;
  for (const { key } of options) {
    const stored = record?.[key];
    out[key] = typeof stored === 'boolean' ? stored : whenUnset;
  }
  return out;
}

/** Empty string / null / undefined → undefined; otherwise a Number. */
const numOrUndef = (v: unknown): number | undefined =>
  v === '' || v === null || v === undefined ? undefined : Number(v);

/** Keep only the numeric KPI targets that were actually set; null when none. */
function cleanTargets(t?: KpiTargets | null): KpiTargets | null {
  if (!t) return null;
  const out: KpiTargets = {};
  if (typeof t.tasksPerWeek === 'number' && !Number.isNaN(t.tasksPerWeek))
    out.tasksPerWeek = t.tasksPerWeek;
  if (typeof t.successRatePct === 'number' && !Number.isNaN(t.successRatePct))
    out.successRatePct = t.successRatePct;
  if (typeof t.approvalsMax === 'number' && !Number.isNaN(t.approvalsMax))
    out.approvalsMax = t.approvalsMax;
  return Object.keys(out).length > 0 ? out : null;
}

/** Employee Settings panel (Step 4/5 + P1 #6): rich per-employee configuration. */
export function EmployeeSettings({ employee }: { employee: AiEmployeeDto }) {
  const update = useUpdateEmployee();
  const [newGoal, setNewGoal] = useState('');
  const {
    register,
    handleSubmit,
    watch,
    setValue,
    formState: { errors, isDirty },
  } = useForm<EmployeeSettingsDto>({
    resolver: zodResolver(employeeSettingsSchema),
    defaultValues: {
      name: employee.name,
      department: employee.department ?? '',
      managerName: employee.managerName ?? '',
      workingHoursStart: employee.workingHoursStart ?? '',
      workingHoursEnd: employee.workingHoursEnd ?? '',
      timezone: employee.timezone ?? '',
      language: employee.language ?? '',
      knowledgeAccess: employee.knowledgeAccess,
      budgetLimit: employee.budgetLimit,
      maxCreditsPerExecution: employee.maxCreditsPerExecution,
      maxCreditsPerTask: employee.maxCreditsPerTask,
      // Unset permission = allowed; unset approval rule = no extra gate.
      permissions: toFlags(employee.permissions, PERMISSION_OPTIONS, true),
      approvalRules: toFlags(employee.approvalRules, APPROVAL_RULE_OPTIONS, false),
      goals: employee.goals ?? [],
      kpiTargets: {
        tasksPerWeek: employee.kpiTargets?.tasksPerWeek,
        successRatePct: employee.kpiTargets?.successRatePct,
        approvalsMax: employee.kpiTargets?.approvalsMax,
      },
    },
  });

  const goals = watch('goals') ?? [];

  const addGoal = () => {
    const g = newGoal.trim();
    if (!g) return;
    setValue('goals', [...goals, g].slice(0, 50), { shouldDirty: true });
    setNewGoal('');
  };
  const removeGoal = (idx: number) => {
    setValue(
      'goals',
      goals.filter((_, i) => i !== idx),
      { shouldDirty: true },
    );
  };

  const onSubmit = handleSubmit((values) => {
    // Strip empty optional strings so we store null rather than "".
    const clean = (s?: string) => (s && s.trim() ? s.trim() : undefined);
    update.mutate({
      id: employee.id,
      data: {
        name: values.name.trim(),
        department: clean(values.department),
        managerName: clean(values.managerName),
        workingHoursStart: clean(values.workingHoursStart),
        workingHoursEnd: clean(values.workingHoursEnd),
        timezone: clean(values.timezone),
        language: clean(values.language),
        knowledgeAccess: values.knowledgeAccess,
        budgetLimit: values.budgetLimit ?? null,
        maxCreditsPerExecution: values.maxCreditsPerExecution ?? null,
        maxCreditsPerTask: values.maxCreditsPerTask ?? null,
        permissions: values.permissions,
        approvalRules: values.approvalRules,
        goals: values.goals ?? [],
        kpiTargets: cleanTargets(values.kpiTargets),
      },
    });
  });

  return (
    <section className="rounded-2xl border border-app-border bg-app-surface p-5">
      <h2 className="mb-4 text-sm font-medium text-app-ink">Employee settings</h2>
      <form onSubmit={onSubmit} className="space-y-4" noValidate>
        <div className="grid gap-4 sm:grid-cols-2">
          <div>
            <label htmlFor="s-name" className="mb-1.5 block text-sm font-medium text-app-ink-2">
              Name
            </label>
            <input id="s-name" className={inputClass} {...register('name')} />
            {errors.name && (
              <p className="mt-1 text-sm text-red-600">{errors.name.message}</p>
            )}
          </div>
          <div>
            <label htmlFor="s-department" className="mb-1.5 block text-sm font-medium text-app-ink-2">
              Department
            </label>
            <input
              id="s-department"
              className={inputClass}
              {...register('department')}
            />
          </div>
          <div>
            <label htmlFor="s-manager" className="mb-1.5 block text-sm font-medium text-app-ink-2">
              Manager
            </label>
            <input
              id="s-manager"
              className={inputClass}
              {...register('managerName')}
            />
          </div>
          <div>
            <label htmlFor="s-language" className="mb-1.5 block text-sm font-medium text-app-ink-2">
              Language
            </label>
            <input
              id="s-language"
              className={inputClass}
              placeholder="e.g. English"
              {...register('language')}
            />
          </div>
          <div>
            <label htmlFor="s-start" className="mb-1.5 block text-sm font-medium text-app-ink-2">
              Working hours start
            </label>
            <input
              id="s-start"
              type="time"
              className={inputClass}
              {...register('workingHoursStart')}
            />
          </div>
          <div>
            <label htmlFor="s-end" className="mb-1.5 block text-sm font-medium text-app-ink-2">
              Working hours end
            </label>
            <input
              id="s-end"
              type="time"
              className={inputClass}
              {...register('workingHoursEnd')}
            />
          </div>
          <div>
            <label htmlFor="s-timezone" className="mb-1.5 block text-sm font-medium text-app-ink-2">
              Time zone
            </label>
            <input
              id="s-timezone"
              className={inputClass}
              placeholder="e.g. Europe/London"
              {...register('timezone')}
            />
          </div>
          <div>
            <label
              htmlFor="s-knowledge"
              className="mb-1.5 block text-sm font-medium text-app-ink-2"
            >
              Knowledge access
            </label>
            <select
              id="s-knowledge"
              className={inputClass}
              {...register('knowledgeAccess')}
            >
              {KNOWLEDGE_ACCESSES.map((k) => (
                <option key={k} value={k}>
                  {k === 'ALL' ? 'All company knowledge' : 'No knowledge access'}
                </option>
              ))}
            </select>
          </div>
          <div>
            <label htmlFor="s-budget" className="mb-1.5 block text-sm font-medium text-app-ink-2">
              Monthly budget limit (USD) <span className="text-app-ink-3">(optional)</span>
            </label>
            <input
              id="s-budget"
              type="number"
              min={0}
              className={inputClass}
              {...register('budgetLimit', {
                setValueAs: (v) =>
                  v === '' || v === null || v === undefined ? null : Number(v),
              })}
            />
            {employee.budgetLimit != null && (
              <p className="mt-1 text-xs text-app-ink-3">
                ${(employee.monthToDateCostUsd ?? 0).toFixed(2)} spent so far this month
                (estimated — a flat per-token rate, not this employee's real provider bill).
                Reaching the limit blocks new chat messages and workflow AI steps for this
                employee until next month (or a higher limit is set).
              </p>
            )}
            {errors.budgetLimit && (
              <p className="mt-1 text-sm text-red-600">
                {errors.budgetLimit.message}
              </p>
            )}
          </div>
          <div>
            <label
              htmlFor="s-max-credits-execution"
              className="mb-1.5 block text-sm font-medium text-app-ink-2"
            >
              Max credits / execution <span className="text-app-ink-3">(optional)</span>
            </label>
            <input
              id="s-max-credits-execution"
              type="number"
              min={0}
              className={inputClass}
              {...register('maxCreditsPerExecution', {
                setValueAs: (v) =>
                  v === '' || v === null || v === undefined ? null : Number(v),
              })}
            />
            {errors.maxCreditsPerExecution && (
              <p className="mt-1 text-sm text-red-600">
                {errors.maxCreditsPerExecution.message}
              </p>
            )}
          </div>
          <div>
            <label
              htmlFor="s-max-credits-task"
              className="mb-1.5 block text-sm font-medium text-app-ink-2"
            >
              Max credits / task <span className="text-app-ink-3">(optional)</span>
            </label>
            <input
              id="s-max-credits-task"
              type="number"
              min={0}
              className={inputClass}
              {...register('maxCreditsPerTask', {
                setValueAs: (v) =>
                  v === '' || v === null || v === undefined ? null : Number(v),
              })}
            />
            {errors.maxCreditsPerTask && (
              <p className="mt-1 text-sm text-red-600">
                {errors.maxCreditsPerTask.message}
              </p>
            )}
          </div>
        </div>

        {/* Goals (P1 #6): a free-form list of objectives (add/remove). */}
        <fieldset className="rounded-xl border border-app-border p-4">
          <legend className="px-1 text-xs font-medium text-app-ink-3">Goals</legend>
          {goals.length > 0 ? (
            <ul className="mb-3 space-y-2">
              {goals.map((g, i) => (
                <li
                  key={`${g}-${i}`}
                  className="flex items-center justify-between gap-2 rounded-lg bg-app-surface px-3 py-2 text-sm"
                >
                  <span className="text-app-ink">{g}</span>
                  <button
                    type="button"
                    onClick={() => removeGoal(i)}
                    className="text-xs font-medium text-red-600 hover:text-red-300 hover:underline"
                  >
                    Remove
                  </button>
                </li>
              ))}
            </ul>
          ) : (
            <p className="mb-3 text-sm text-app-ink-3">No goals yet.</p>
          )}
          <div className="flex items-center gap-2">
            <input
              aria-label="New goal"
              className={inputClass}
              placeholder="e.g. Resolve 50 tickets per week"
              value={newGoal}
              onChange={(e) => setNewGoal(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') {
                  e.preventDefault();
                  addGoal();
                }
              }}
            />
            <button type="button" className={secondaryBtnClass} onClick={addGoal}>
              Add
            </button>
          </div>
          {errors.goals && (
            <p className="mt-1 text-sm text-red-600">
              {errors.goals.message ?? 'Invalid goals'}
            </p>
          )}
        </fieldset>

        {/* KPI targets (P1 #6): drive the actual-vs-target attainment in analytics. */}
        <fieldset className="rounded-xl border border-app-border p-4">
          <legend className="px-1 text-xs font-medium text-app-ink-3">
            KPI targets
          </legend>
          <div className="grid gap-4 sm:grid-cols-3">
            <div>
              <label htmlFor="k-tasks" className="mb-1.5 block text-sm font-medium text-app-ink-2">
                Tasks / week
              </label>
              <input
                id="k-tasks"
                type="number"
                min={0}
                step={1}
                className={inputClass}
                placeholder="e.g. 50"
                {...register('kpiTargets.tasksPerWeek', {
                  setValueAs: numOrUndef,
                })}
              />
            </div>
            <div>
              <label htmlFor="k-success" className="mb-1.5 block text-sm font-medium text-app-ink-2">
                Success rate %
              </label>
              <input
                id="k-success"
                type="number"
                min={0}
                max={100}
                step="any"
                className={inputClass}
                placeholder="e.g. 90"
                {...register('kpiTargets.successRatePct', {
                  setValueAs: numOrUndef,
                })}
              />
            </div>
            <div>
              <label htmlFor="k-approvals" className="mb-1.5 block text-sm font-medium text-app-ink-2">
                Max pending approvals
              </label>
              <input
                id="k-approvals"
                type="number"
                min={0}
                step={1}
                className={inputClass}
                placeholder="e.g. 5"
                {...register('kpiTargets.approvalsMax', {
                  setValueAs: numOrUndef,
                })}
              />
            </div>
          </div>
          <p className="mt-2 text-xs text-app-ink-3">
            Attainment (actual vs target) is shown on the analytics dashboard.
          </p>
        </fieldset>

        <fieldset className="rounded-xl border border-app-border p-4">
          <legend className="px-1 text-xs font-medium text-app-ink-3">
            Permissions
          </legend>
          <p className="mb-3 text-xs text-app-ink-3">
            Turning one off blocks the matching actions when this employee runs —
            in chat and in workflows. The employee is told why, and nothing is sent.
          </p>
          <div className="grid gap-3 sm:grid-cols-2">
            {PERMISSION_OPTIONS.map((p) => (
              <label key={p.key} className="flex items-start gap-2 text-sm text-app-ink-2">
                <input
                  type="checkbox"
                  className="mt-0.5 h-4 w-4 shrink-0 rounded border-app-border bg-app-raised accent-[#6a30ec]"
                  {...register(`permissions.${p.key}` as const)}
                />
                <span>
                  <span className="block">{p.label}</span>
                  <span className="block text-xs text-app-ink-3">{p.hint}</span>
                </span>
              </label>
            ))}
          </div>
        </fieldset>

        <fieldset className="rounded-xl border border-app-border p-4">
          <legend className="px-1 text-xs font-medium text-app-ink-3">
            Approval rules
          </legend>
          <div className="grid gap-3 sm:grid-cols-2">
            {APPROVAL_RULE_OPTIONS.map((a) => (
              <label key={a.key} className="flex items-start gap-2 text-sm text-app-ink-2">
                <input
                  type="checkbox"
                  className="mt-0.5 h-4 w-4 shrink-0 rounded border-app-border bg-app-raised accent-[#6a30ec]"
                  {...register(`approvalRules.${a.key}` as const)}
                />
                <span>
                  <span className="block">{a.label}</span>
                  <span className="block text-xs text-app-ink-3">{a.hint}</span>
                </span>
              </label>
            ))}
          </div>
        </fieldset>

        {update.isError && (
          <p className="text-sm text-red-600">
            {update.error?.message ?? 'Could not save settings'}
          </p>
        )}

        <div className="flex items-center gap-3">
          <Button variant="violet" type="submit" disabled={update.isPending || !isDirty}>
            {update.isPending ? 'Saving…' : 'Save settings'}
          </Button>
          {update.isSuccess && !update.isPending && (
            <span className="text-sm text-green-700">Saved.</span>
          )}
        </div>
      </form>
    </section>
  );
}
