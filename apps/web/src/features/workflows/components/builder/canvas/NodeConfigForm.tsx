'use client';

import { useEffect, useMemo, useState } from 'react';
import {
  type AiEmployeeDto,
  EMPLOYEE_ROLES,
  type InstalledSkillDto,
  type NodeConfigField,
  type NodeDefinitionDto,
  type WorkflowNode,
} from '@vaep/types';

const inputCls =
  'w-full rounded-lg border border-wf-hairline bg-void-card px-3 py-2 text-sm text-wf-ink outline-none placeholder:text-wf-ink-3 focus-visible:ring-2 focus-visible:ring-wf-focus disabled:opacity-60';

function asString(value: unknown): string {
  if (typeof value === 'string') return value;
  if (value == null) return '';
  return String(value);
}

export interface NodeConfigFormProps {
  node: WorkflowNode;
  def?: NodeDefinitionDto;
  employees: AiEmployeeDto[];
  skills: InstalledSkillDto[];
  readOnly?: boolean;
  onPatch: (patch: { name?: string; config?: Record<string, unknown> }) => void;
}

/**
 * The data-driven node config form (doc 29 §3.E — the "generic SchemaForm").
 * Renders one field per `def.configSchema` entry from the node-definitions
 * endpoint, so every node type is covered without a per-type switch. Employee
 * and skill fields are real pickers; templatable fields keep `{{templates}}`.
 * Local form state drives the inputs (smooth typing); each change patches the
 * canvas node, which autosaves.
 */
export function NodeConfigForm({
  node,
  def,
  employees,
  skills,
  readOnly,
  onPatch,
}: NodeConfigFormProps) {
  const [name, setName] = useState(node.name ?? '');
  const [config, setConfig] = useState<Record<string, unknown>>(node.config ?? {});

  // Re-seed only when the SELECTED node changes — not on every canvas rebuild,
  // so typing isn't interrupted by the autosave round-trip.
  useEffect(() => {
    // Keyed on node.id only — re-seed when the SELECTED node changes, not when
    // the node object gets a new identity after each autosave rebuild (that
    // would fight the user's typing).
    setName(node.name ?? '');
    setConfig(node.config ?? {});
  }, [node.id]);

  const setField = (key: string, value: unknown) => {
    const next = { ...config, [key]: value };
    setConfig(next);
    onPatch({ config: next });
  };

  const fields = def?.configSchema ?? [];

  return (
    <div className="space-y-4">
      <label className="block">
        <span className="mb-1 block text-xs font-medium text-wf-ink-2">Step name</span>
        <input
          className={inputCls}
          value={name}
          placeholder={def?.label ?? node.type}
          disabled={readOnly}
          onChange={(e) => {
            setName(e.target.value);
            onPatch({ name: e.target.value });
          }}
        />
      </label>

      {fields.length === 0 ? (
        <p className="text-sm text-wf-ink-3">This step has no settings.</p>
      ) : (
        fields.map((field) => (
          <ConfigField
            key={field.key}
            field={field}
            value={config[field.key]}
            employees={employees}
            skills={skills}
            readOnly={readOnly}
            onChange={(v) => setField(field.key, v)}
          />
        ))
      )}
    </div>
  );
}

interface ConfigFieldProps {
  field: NodeConfigField;
  value: unknown;
  employees: AiEmployeeDto[];
  skills: InstalledSkillDto[];
  readOnly?: boolean;
  onChange: (value: unknown) => void;
}

function ConfigField({ field, value, employees, skills, readOnly, onChange }: ConfigFieldProps) {
  const label = (
    <span className="mb-1 block text-xs font-medium text-wf-ink-2">
      {field.label}
      {field.required ? <span className="text-status-failed"> *</span> : null}
      {field.templatable ? (
        <span className="ml-1 font-mono text-[10px] text-wf-ink-3">{'{{ }}'} ok</span>
      ) : null}
    </span>
  );
  const help = field.help ? <p className="mt-1 text-xs text-wf-ink-3">{field.help}</p> : null;

  return (
    <label className="block">
      {label}
      <FieldControl
        field={field}
        value={value}
        employees={employees}
        skills={skills}
        readOnly={readOnly}
        onChange={onChange}
      />
      {help}
    </label>
  );
}

function FieldControl({ field, value, employees, skills, readOnly, onChange }: ConfigFieldProps) {
  switch (field.type) {
    case 'text':
      return (
        <textarea
          rows={3}
          className={`${inputCls} font-mono`}
          value={asString(value)}
          placeholder={field.placeholder}
          disabled={readOnly}
          onChange={(e) => onChange(e.target.value)}
        />
      );

    case 'number':
    case 'duration':
      return (
        <input
          type="number"
          className={inputCls}
          value={value === undefined || value === null ? asString(field.default) : asString(value)}
          placeholder={field.placeholder}
          disabled={readOnly}
          onChange={(e) => onChange(e.target.value === '' ? undefined : Number(e.target.value))}
        />
      );

    case 'boolean':
      return (
        <span className="flex items-center gap-2 pt-1">
          <input
            type="checkbox"
            className="accent-violet"
            checked={value === true}
            disabled={readOnly}
            onChange={(e) => onChange(e.target.checked)}
          />
          <span className="text-sm text-wf-ink-2">{field.placeholder ?? 'Enabled'}</span>
        </span>
      );

    case 'select':
    case 'variableScope':
      return (
        <select
          className={inputCls}
          value={asString(value) || asString(field.default)}
          disabled={readOnly}
          onChange={(e) => onChange(e.target.value)}
        >
          {!field.required ? <option value="">— none —</option> : null}
          {(field.options ?? []).map((o) => (
            <option key={o.value} value={o.value}>
              {o.label}
            </option>
          ))}
        </select>
      );

    case 'employee':
      return (
        <PickerSelect
          value={asString(value)}
          required={field.required}
          readOnly={readOnly}
          options={employees.map((e) => ({ value: e.id, label: `${e.name} · ${e.role}` }))}
          placeholder="Choose an AI Employee…"
          onChange={onChange}
        />
      );

    case 'skill': {
      // Distinct installed skill keys (a skill can be installed more than once).
      const seen = new Set<string>();
      const options = skills
        .filter((s) => (seen.has(s.skillKey) ? false : (seen.add(s.skillKey), true)))
        .map((s) => ({ value: s.skillKey, label: s.displayName || s.skillKey }));
      return (
        <PickerSelect
          value={asString(value)}
          required={field.required}
          readOnly={readOnly}
          options={options}
          placeholder="Choose a skill…"
          onChange={onChange}
        />
      );
    }

    case 'knowledgeCategory':
      return (
        <select
          className={inputCls}
          value={asString(value)}
          disabled={readOnly}
          onChange={(e) => onChange(e.target.value || undefined)}
        >
          <option value="">Shared (company-wide)</option>
          {EMPLOYEE_ROLES.map((role) => (
            <option key={role} value={role}>
              {role}
            </option>
          ))}
        </select>
      );

    case 'json':
      return <JsonField value={value} readOnly={readOnly} onChange={onChange} />;

    // string / expression / channel / tool → single-line text (real skill-tool
    // + live channel pickers are a documented later enrichment).
    default:
      return (
        <input
          className={`${inputCls} font-mono`}
          value={asString(value) || asString(field.default)}
          placeholder={field.placeholder}
          disabled={readOnly}
          onChange={(e) => onChange(e.target.value)}
        />
      );
  }
}

/** A select that keeps an unknown/template value visible instead of dropping it. */
function PickerSelect({
  value,
  options,
  required,
  readOnly,
  placeholder,
  onChange,
}: {
  value: string;
  options: { value: string; label: string }[];
  required?: boolean;
  readOnly?: boolean;
  placeholder: string;
  onChange: (value: unknown) => void;
}) {
  const known = options.some((o) => o.value === value);
  return (
    <select
      className={inputCls}
      value={value}
      disabled={readOnly}
      onChange={(e) => onChange(e.target.value || undefined)}
    >
      <option value="">{required ? placeholder : '— none —'}</option>
      {options.map((o) => (
        <option key={o.value} value={o.value}>
          {o.label}
        </option>
      ))}
      {value && !known ? (
        <option value={value}>{value.includes('{{') ? `${value} (template)` : `${value} (unavailable)`}</option>
      ) : null}
    </select>
  );
}

/** JSON object editor with a local text buffer + validation (doc 29 json field). */
function JsonField({
  value,
  readOnly,
  onChange,
}: {
  value: unknown;
  readOnly?: boolean;
  onChange: (value: unknown) => void;
}) {
  const initial = useMemo(() => {
    try {
      return JSON.stringify(value ?? {}, null, 2);
    } catch {
      return '{}';
    }
  }, [value]);
  const [text, setText] = useState(initial);
  const [error, setError] = useState<string | null>(null);

  // Re-seed the buffer when the underlying value changes (e.g. switching nodes).
  useEffect(() => {
    setText(initial);
    setError(null);
  }, [initial]);

  return (
    <div>
      <textarea
        rows={5}
        className={`${inputCls} font-mono`}
        value={text}
        disabled={readOnly}
        onChange={(e) => {
          const next = e.target.value;
          setText(next);
          try {
            const parsed = JSON.parse(next);
            if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
              setError(null);
              onChange(parsed);
            } else {
              setError('Must be a JSON object.');
            }
          } catch {
            setError('Invalid JSON.');
          }
        }}
      />
      {error ? <p className="mt-1 text-xs text-status-failed">{error}</p> : null}
    </div>
  );
}
