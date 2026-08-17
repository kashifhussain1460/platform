'use client';

import { useState } from 'react';
import type { ConditionOp, WorkflowNode } from '@vaep/types';
import { CONDITION_OPS } from '../schemas';
import { NODE_HINTS } from '../labels';

const inputCls = 'field-modern font-mono text-sm';

function str(value: unknown): string {
  return typeof value === 'string' ? value : value == null ? '' : String(value);
}

/** A labelled field wrapper. */
function Field({
  label,
  hint,
  children,
}: {
  label: string;
  hint?: string;
  children: React.ReactNode;
}) {
  return (
    <div>
      <label className="mb-1 block text-xs font-medium text-app-ink-2">
        {label}
      </label>
      {children}
      {hint && <p className="mt-1 text-xs text-app-ink-3">{hint}</p>}
    </div>
  );
}

/** JSON object editor with local buffer + validation (for TOOL_ACTION args). */
function ArgsEditor({
  value,
  onChange,
}: {
  value: Record<string, unknown>;
  onChange: (next: Record<string, unknown>) => void;
}) {
  const [text, setText] = useState(() => JSON.stringify(value ?? {}, null, 2));
  const [error, setError] = useState<string | null>(null);

  const onEdit = (next: string) => {
    setText(next);
    try {
      const parsed = JSON.parse(next);
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        setError(null);
        onChange(parsed as Record<string, unknown>);
      } else {
        setError('Arguments must be a JSON object');
      }
    } catch {
      setError('Invalid JSON');
    }
  };

  return (
    <div>
      <textarea
        rows={4}
        className={inputCls}
        value={text}
        onChange={(e) => onEdit(e.target.value)}
      />
      {error && <p className="mt-1 text-xs text-red-600">{error}</p>}
    </div>
  );
}

/** Fields for editing one node's config, rendered per node type. */
export function NodeEditor({
  node,
  onChange,
}: {
  node: WorkflowNode;
  onChange: (next: WorkflowNode) => void;
}) {
  const cfg = node.config ?? {};
  const setConfig = (patch: Record<string, unknown>) =>
    onChange({ ...node, config: { ...cfg, ...patch } });

  return (
    <div className="space-y-3">
      <p className="text-xs text-app-ink-3">{NODE_HINTS[node.type]}</p>

      <Field label="Step name (optional)">
        <input
          className="field-modern text-sm"
          value={node.name ?? ''}
          placeholder={node.type}
          onChange={(e) => onChange({ ...node, name: e.target.value })}
        />
      </Field>

      {node.type === 'RETRIEVE' && (
        <>
          <Field label="Query template" hint="Use {{trigger.query}} etc.">
            <input
              className={inputCls}
              value={str(cfg.query)}
              onChange={(e) => setConfig({ query: e.target.value })}
            />
          </Field>
          <Field label="Top K">
            <input
              type="number"
              className={inputCls}
              value={str(cfg.k) || '5'}
              onChange={(e) => setConfig({ k: Number(e.target.value) })}
            />
          </Field>
          <Field label="Output key" hint="Stored in context under this key.">
            <input
              className={inputCls}
              value={str(cfg.outputKey)}
              onChange={(e) => setConfig({ outputKey: e.target.value })}
            />
          </Field>
        </>
      )}

      {node.type === 'AI_STEP' && (
        <>
          <Field label="Prompt template" hint="Interpolates context, e.g. {{retrieved}}.">
            <textarea
              rows={3}
              className={inputCls}
              value={str(cfg.prompt)}
              onChange={(e) => setConfig({ prompt: e.target.value })}
            />
          </Field>
          <Field label="Employee id (optional)" hint="Uses that employee's persona.">
            <input
              className={inputCls}
              value={str(cfg.employeeId)}
              onChange={(e) => setConfig({ employeeId: e.target.value })}
            />
          </Field>
          <Field label="Output key">
            <input
              className={inputCls}
              value={str(cfg.outputKey)}
              onChange={(e) => setConfig({ outputKey: e.target.value })}
            />
          </Field>
        </>
      )}

      {node.type === 'TOOL_ACTION' && (
        <>
          <Field label="Skill key" hint="e.g. slack, email, stripe, github, http.">
            <input
              className={inputCls}
              value={str(cfg.skillKey)}
              onChange={(e) => setConfig({ skillKey: e.target.value })}
            />
          </Field>
          <Field label="Tool" hint="e.g. send_message.">
            <input
              className={inputCls}
              value={str(cfg.tool)}
              onChange={(e) => setConfig({ tool: e.target.value })}
            />
          </Field>
          <Field label="Arguments (JSON of templates)">
            <ArgsEditor
              value={
                cfg.args && typeof cfg.args === 'object'
                  ? (cfg.args as Record<string, unknown>)
                  : {}
              }
              onChange={(next) => setConfig({ args: next })}
            />
          </Field>
          <Field
            label="Employee id (optional)"
            hint="Uses that employee's own connection if it has one, otherwise the company-wide one."
          >
            <input
              className={inputCls}
              value={str(cfg.employeeId)}
              onChange={(e) => setConfig({ employeeId: e.target.value })}
            />
          </Field>
          <Field label="Output key">
            <input
              className={inputCls}
              value={str(cfg.outputKey)}
              onChange={(e) => setConfig({ outputKey: e.target.value })}
            />
          </Field>
        </>
      )}

      {node.type === 'WAIT' && (
        <Field label="Duration (ms)" hint="Capped by the engine (max 10000).">
          <input
            type="number"
            className={inputCls}
            value={str(cfg.durationMs) || '0'}
            onChange={(e) => setConfig({ durationMs: Number(e.target.value) })}
          />
        </Field>
      )}

      {node.type === 'CONDITION' && (
        <>
          <Field label="Left (template)">
            <input
              className={inputCls}
              value={str(cfg.left)}
              onChange={(e) => setConfig({ left: e.target.value })}
            />
          </Field>
          <Field label="Operator">
            <select
              className="field-modern text-sm"
              value={str(cfg.op) || 'eq'}
              onChange={(e) =>
                setConfig({ op: e.target.value as ConditionOp })
              }
            >
              {CONDITION_OPS.map((op) => (
                <option key={op} value={op}>
                  {op}
                </option>
              ))}
            </select>
          </Field>
          <Field label="Right (literal)">
            <input
              className={inputCls}
              value={str(cfg.right)}
              onChange={(e) => setConfig({ right: e.target.value })}
            />
          </Field>
        </>
      )}

      {node.type === 'NOTIFY' && (
        <Field label="Message template">
          <textarea
            rows={2}
            className={inputCls}
            value={str(cfg.message)}
            onChange={(e) => setConfig({ message: e.target.value })}
          />
        </Field>
      )}

      {node.type === 'APPROVAL' && (
        <>
          <Field
            label="Approval message"
            hint="Shown to the approver. The run pauses (WAITING) until a manager approves (resume) or rejects (fail)."
          >
            <textarea
              rows={2}
              className={inputCls}
              value={str(cfg.message)}
              onChange={(e) => setConfig({ message: e.target.value })}
            />
          </Field>
          <Field
            label="Approval mode"
            hint="On: this step is skipped entirely — no approval queue, no pause; the run continues straight to the next step the moment it's reached. Off (default): pauses and waits for a manager in Approvals."
          >
            <label className="flex items-center gap-2 text-sm text-app-ink-2">
              <input
                type="checkbox"
                checked={cfg.autoApprove === true}
                onChange={(e) => setConfig({ autoApprove: e.target.checked })}
                className="accent-violet"
              />
              Skip approval — auto-approve when reached
            </label>
          </Field>
        </>
      )}

      {node.type === 'TRIGGER' && (
        <p className="text-xs text-app-ink-3">
          No configuration. The run trigger payload seeds the context.
        </p>
      )}
    </div>
  );
}
