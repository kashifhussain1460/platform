'use client';

import { useState } from 'react';
import { EMPLOYEE_ROLES, WORKFLOW_CATEGORIES } from '@vaep/types';
import { Button } from '@/components/ui/Button';
import { useEmployees } from '@/features/employees/hooks';
import { useUpdateDepartment } from '../hooks';
import { formatScope } from '../labels';
import type { DepartmentDto } from '../schemas';

/**
 * Everything a department can be limited to.
 *
 * The authorization policy matches a department's `scopes` against whatever
 * scope name the resource already carries — `AiEmployee.role`,
 * `Workflow.category`, `KnowledgeDocument.category`. Those are three separate
 * enums that overlap by name (HR, MARKETING, SALES…), and the policy compares
 * them case- and separator-insensitively, so the union of the two enums is the
 * complete, honest option list. No fourth vocabulary is invented here.
 */
function scopeOptions(): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const value of [...EMPLOYEE_ROLES, ...WORKFLOW_CATEGORIES]) {
    const key = String(value).toUpperCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(key);
  }
  return out.sort();
}

const SCOPE_OPTIONS = scopeOptions();

/**
 * Turn department isolation on or off for one department.
 *
 * This control is the reason the whole WAVE-2 authorization layer existed but
 * did nothing in production: `Department.scopes` was writable by the API and
 * had no input anywhere in the product, so no tenant could ever switch it on.
 *
 * The copy states the consequence in both directions, because this is the one
 * setting on the page that can lock a colleague out of something they could
 * see yesterday.
 */
export function DepartmentScopeEditor({
  dept,
  onDone,
}: {
  dept: DepartmentDto;
  onDone: () => void;
}) {
  const update = useUpdateDepartment();
  const { data: employees } = useEmployees();
  const [selected, setSelected] = useState<string[]>(dept.scopes);

  const toggle = (scope: string) =>
    setSelected(
      selected.includes(scope)
        ? selected.filter((s) => s !== scope)
        : [...selected, scope],
    );

  // Which AI Employees this department would cover. `AiEmployee` has no
  // department FK — its department axis IS its role — so "assigned employees"
  // is derived from the scopes rather than stored twice.
  const inScope = (employees ?? []).filter((e) =>
    selected.some((s) => s.toUpperCase() === e.role.toUpperCase()),
  );

  const save = () =>
    update.mutate({ id: dept.id, data: { scopes: selected } }, { onSuccess: onDone });

  return (
    <div className="space-y-3 rounded-xl border border-app-border bg-app-raised p-4">
      <div>
        <p className="text-sm font-medium text-app-ink">
          What can {dept.name} work on?
        </p>
        <p className="mt-1 text-xs text-app-ink-3">
          {selected.length === 0
            ? 'Nothing selected — people in this department can see everything in the company. That is the default.'
            : `People in this department will only see AI Employees, workflows and documents for ${selected
                .map(formatScope)
                .join(', ')}. Owners always see everything.`}
        </p>
      </div>

      <div className="flex flex-wrap gap-2">
        {SCOPE_OPTIONS.map((scope) => {
          const on = selected.includes(scope);
          return (
            <button
              key={scope}
              type="button"
              aria-pressed={on}
              onClick={() => toggle(scope)}
              className={`rounded-full border px-3 py-1 text-xs font-medium transition-colors ${
                on
                  ? 'border-violet/40 bg-violet/15 text-violet'
                  : 'border-app-border bg-app-surface text-app-ink-2 hover:border-app-border-strong'
              }`}
            >
              {formatScope(scope)}
            </button>
          );
        })}
      </div>

      {selected.length > 0 && (
        <p className="text-xs text-app-ink-3">
          {inScope.length > 0
            ? `AI Employees in scope: ${inScope.map((e) => e.name).join(', ')}.`
            : 'No AI Employees match these areas yet.'}
        </p>
      )}

      {update.isError && (
        <p className="text-sm text-red-600">
          {update.error?.message ?? 'Could not save'}
        </p>
      )}

      <div className="flex gap-2">
        <Button type="button" variant="violet" onClick={save} disabled={update.isPending}>
          {update.isPending ? 'Saving…' : 'Save access'}
        </Button>
        <button
          type="button"
          className="rounded-lg border border-app-border-strong bg-app-surface px-3.5 py-1.5 text-sm font-medium text-app-ink-2 hover:bg-app-raised"
          onClick={onDone}
        >
          Cancel
        </button>
        {selected.length > 0 && (
          <button
            type="button"
            className="rounded-lg px-3.5 py-1.5 text-sm font-medium text-app-ink-3 hover:text-app-ink"
            onClick={() => setSelected([])}
          >
            Clear all (see everything)
          </button>
        )}
      </div>
    </div>
  );
}
