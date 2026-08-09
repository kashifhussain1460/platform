'use client';

import { useMemo, useState } from 'react';
import type {
  TemplateParameter,
  WorkflowDto,
  WorkflowTemplateSummaryDto,
} from '@vaep/types';
import { Button } from '@/components/ui/Button';
import { useEmployees } from '@/features/employees/hooks';
import { useInstallWorkflowTemplate } from '../../hooks';

/**
 * TemplateInstallForm — fill a template's parameters + install it into a DRAFT
 * workflow (doc 29 §3.A). Employee-bound params get a real picker of hired
 * employees (filtered to the roles the template needs); other params get a typed
 * field. A missing prerequisite (422) is surfaced as an actionable message, not a
 * silent failure. Install is idempotent (a generated key per submit).
 */
export interface TemplateInstallFormProps {
  template: WorkflowTemplateSummaryDto;
  /** Called with the new DRAFT workflow's id on success (navigate to the builder). */
  onInstalled: (workflowId: string) => void;
  onCancel: () => void;
}

const genKey = (): string =>
  typeof crypto !== 'undefined' && 'randomUUID' in crypto
    ? crypto.randomUUID()
    : `idem-${Date.now()}-${Math.round(Math.random() * 1e9)}`;

export function TemplateInstallForm({
  template,
  onInstalled,
  onCancel,
}: TemplateInstallFormProps) {
  const { data: employees } = useEmployees();
  const install = useInstallWorkflowTemplate();
  const [name, setName] = useState(template.name);
  const [values, setValues] = useState<Record<string, unknown>>(() =>
    Object.fromEntries(
      template.parameters
        .filter((p) => p.default !== undefined)
        .map((p) => [p.key, p.default]),
    ),
  );

  const neededRoles = template.requires.employeeRoles ?? [];
  const eligibleEmployees = useMemo(
    () =>
      (employees ?? []).filter(
        (e) => neededRoles.length === 0 || neededRoles.includes(e.role),
      ),
    [employees, neededRoles],
  );

  const missingRequired = template.parameters.filter(
    (p) => p.required && (values[p.key] === undefined || values[p.key] === ''),
  );
  const canSubmit = missingRequired.length === 0 && !install.isPending;

  const set = (key: string, v: unknown) =>
    setValues((prev) => ({ ...prev, [key]: v }));

  const submit = () => {
    install.mutate(
      { id: template.id, body: { name: name.trim() || undefined, parameters: values }, idempotencyKey: genKey() },
      { onSuccess: (wf: WorkflowDto) => onInstalled(wf.id) },
    );
  };

  return (
    <div className="flex flex-col gap-5">
      <div>
        <p className="font-display text-lg font-semibold text-wf-ink">{template.name}</p>
        {template.description ? (
          <p className="mt-1 text-sm text-wf-ink-2">{template.description}</p>
        ) : null}
      </div>

      <label className="flex flex-col gap-1.5">
        <span className="text-sm font-medium text-wf-ink">Workflow name</span>
        <input
          value={name}
          onChange={(e) => setName(e.target.value)}
          className="rounded-lg border border-wf-hairline bg-void-card px-3 py-2 text-sm text-wf-ink outline-none focus-visible:ring-2 focus-visible:ring-wf-focus"
        />
      </label>

      {template.parameters.map((p) => (
        <ParameterField
          key={p.key}
          param={p}
          value={values[p.key]}
          employees={eligibleEmployees}
          onChange={(v) => set(p.key, v)}
        />
      ))}

      {install.isError ? (
        <p className="rounded-lg border border-status-failed/40 bg-status-failed/10 px-3 py-2 text-sm text-status-failed">
          {install.error.status === 422
            ? install.error.message
            : `Couldn't install this template. ${install.error.message}`}
        </p>
      ) : null}

      <div className="flex items-center justify-end gap-2">
        <Button variant="ghost" onClick={onCancel} disabled={install.isPending}>
          Cancel
        </Button>
        <Button
          variant="violet"
          onClick={submit}
          disabled={!canSubmit}
          title={missingRequired.length ? 'Fill in the required fields first' : undefined}
        >
          {install.isPending ? 'Installing…' : 'Install workflow'}
        </Button>
      </div>
    </div>
  );
}

function ParameterField({
  param,
  value,
  employees,
  onChange,
}: {
  param: TemplateParameter;
  value: unknown;
  employees: { id: string; name: string; role: string }[];
  onChange: (v: unknown) => void;
}) {
  const label = (
    <span className="text-sm font-medium text-wf-ink">
      {param.label}
      {param.required ? <span className="text-status-failed"> *</span> : null}
    </span>
  );
  const help = param.help ? (
    <span className="text-xs text-wf-ink-3">{param.help}</span>
  ) : null;
  const inputCls =
    'rounded-lg border border-wf-hairline bg-void-card px-3 py-2 text-sm text-wf-ink outline-none focus-visible:ring-2 focus-visible:ring-wf-focus';

  if (param.binds === 'employee') {
    return (
      <label className="flex flex-col gap-1.5">
        {label}
        <select value={(value as string) ?? ''} onChange={(e) => onChange(e.target.value)} className={inputCls}>
          <option value="">Choose an AI Employee…</option>
          {employees.map((e) => (
            <option key={e.id} value={e.id}>
              {e.name} · {e.role}
            </option>
          ))}
        </select>
        {employees.length === 0 ? (
          <span className="text-xs text-status-waiting">
            No eligible AI Employees yet — hire one for this role first.
          </span>
        ) : (
          help
        )}
      </label>
    );
  }

  if (param.type === 'boolean') {
    return (
      <label className="flex items-center gap-2">
        <input type="checkbox" checked={Boolean(value)} onChange={(e) => onChange(e.target.checked)} />
        {label}
        {help}
      </label>
    );
  }

  return (
    <label className="flex flex-col gap-1.5">
      {label}
      <input
        type={param.type === 'number' ? 'number' : 'text'}
        value={(value as string | number | undefined) ?? ''}
        onChange={(e) =>
          onChange(param.type === 'number' ? Number(e.target.value) : e.target.value)
        }
        className={inputCls}
      />
      {help}
    </label>
  );
}
