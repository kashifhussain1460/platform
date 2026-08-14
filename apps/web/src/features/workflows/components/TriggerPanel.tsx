'use client';

import { useState } from 'react';
import { X } from 'lucide-react';
import type {
  Condition,
  EventConditionOp,
  TriggerConfig,
  TriggerType,
  WorkflowDto,
} from '@vaep/types';
import { EVENT_CONDITION_OPS } from '@vaep/types';
import { Button } from '@/components/ui/Button';
import { useCurrentCompany } from '@/features/tenant/hooks';
import { useInstalledSkills } from '@/features/skills/hooks';
import { toTriggerConfig } from '../schedule';
import { DEFAULT_SCHEDULE, ScheduleFields } from './builder/ScheduleFields';
import {
  useActivateWorkflow,
  useDeactivateWorkflow,
  useUpdateWorkflow,
} from '../hooks';

const API_URL = process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:4000';

/** A condition row in the editor. `value` is kept as raw text; built on save. */
interface ConditionRow {
  path: string;
  op: EventConditionOp;
  value: string;
}

/** The `exists` op takes no value (it only checks truthy presence). */
function opTakesValue(op: EventConditionOp): boolean {
  return op !== 'exists';
}

/** Stored condition value → the editor's text field. */
function valueToText(value: unknown): string {
  if (value === undefined || value === null) return '';
  if (Array.isArray(value)) return value.join(', ');
  return String(value);
}

/** Persisted conditions → editable rows. */
function initialConditions(workflow: WorkflowDto): ConditionRow[] {
  const conditions = workflow.triggerConfig?.conditions;
  if (!Array.isArray(conditions)) return [];
  return conditions.map((c) => ({
    path: c.path ?? '',
    op: c.op ?? 'eq',
    value: valueToText(c.value),
  }));
}

/** Editable rows → the `conditions` saved into triggerConfig (drops empty paths). */
function buildConditions(rows: ConditionRow[]): Condition[] {
  return rows
    .filter((r) => r.path.trim().length > 0)
    .map((r) => {
      const path = r.path.trim();
      if (r.op === 'exists') return { path, op: r.op };
      if (r.op === 'in') {
        const value = r.value
          .split(',')
          .map((v) => v.trim())
          .filter((v) => v.length > 0);
        return { path, op: r.op, value };
      }
      return { path, op: r.op, value: r.value };
    });
}

const TRIGGER_OPTIONS: { value: TriggerType; label: string; hint: string }[] = [
  { value: 'MANUAL', label: 'Manual', hint: 'Run on demand from the Run panel.' },
  {
    value: 'SCHEDULE',
    label: 'Schedule',
    hint: 'Run automatically on a fixed interval.',
  },
  {
    value: 'WEBHOOK',
    label: 'Webhook',
    hint: 'Run when an external system POSTs to a secret URL.',
  },
  {
    value: 'EVENT',
    label: 'Event',
    hint: 'Run when a matching internal platform event fires.',
  },
];

/**
 * The stored schedule, or a complete default. Never blank — the API rejects a
 * SCHEDULE trigger with no time, so an empty state would make Save fail.
 */
function initialSchedule(workflow: WorkflowDto): TriggerConfig {
  return workflow.triggerConfig?.cron || workflow.triggerConfig?.everyMs
    ? workflow.triggerConfig
    : toTriggerConfig(DEFAULT_SCHEDULE);
}

/**
 * Trigger + activation controls for the workflow editor. Choose a trigger type,
 * configure it (interval / eventType / webhook URL), Save it (optimistic
 * update), then Activate / Deactivate. Activate is disabled until the workflow
 * has a runnable step (reuses the same guard as the Run panel).
 */
export function TriggerPanel({
  workflow,
  canActivate,
}: {
  workflow: WorkflowDto;
  /** False when the saved workflow has only a TRIGGER (no runnable steps). */
  canActivate: boolean;
}) {
  const [triggerType, setTriggerType] = useState<TriggerType>(
    workflow.triggerType,
  );
  const [schedule, setSchedule] = useState<TriggerConfig>(() =>
    initialSchedule(workflow),
  );
  const [eventType, setEventType] = useState<string>(
    workflow.triggerConfig?.eventType ?? '',
  );
  const [conditions, setConditions] = useState<ConditionRow[]>(() =>
    initialConditions(workflow),
  );
  const [connectorId, setConnectorId] = useState<string>(
    workflow.triggerConfig?.connectorId ?? '',
  );
  const [copied, setCopied] = useState(false);

  const { data: installedSkills } = useInstalledSkills();
  const { data: company } = useCurrentCompany();
  // Only Gmail connections can currently receive inbound events -- this list
  // grows the same way if/when other providers get an inbound driver.
  const connectableMailboxes = (installedSkills ?? []).filter(
    (s) => s.skillKey === 'gmail' && s.connectionStatus === 'CONNECTED',
  );

  const update = useUpdateWorkflow();
  const activate = useActivateWorkflow();
  const deactivate = useDeactivateWorkflow();

  const isActive = workflow.status === 'ACTIVE';
  const webhookUrl = workflow.webhookToken
    ? `${API_URL}/workflows/webhooks/${workflow.webhookToken}`
    : null;

  const onSaveTrigger = () => {
    let triggerConfig;
    if (triggerType === 'SCHEDULE') {
      triggerConfig = { ...schedule };
    } else if (triggerType === 'EVENT') {
      const built = buildConditions(conditions);
      triggerConfig = {
        eventType: eventType.trim(),
        ...(built.length > 0 ? { conditions: built } : {}),
        ...(connectorId ? { connectorId } : {}),
      };
    } else {
      triggerConfig = undefined;
    }
    update.mutate({ id: workflow.id, data: { triggerType, triggerConfig } });
  };

  const addCondition = () =>
    setConditions((rows) => [...rows, { path: '', op: 'eq', value: '' }]);
  const removeCondition = (index: number) =>
    setConditions((rows) => rows.filter((_, i) => i !== index));
  const patchCondition = (index: number, patch: Partial<ConditionRow>) =>
    setConditions((rows) =>
      rows.map((r, i) => (i === index ? { ...r, ...patch } : r)),
    );

  const onCopy = async () => {
    if (!webhookUrl) return;
    try {
      await navigator.clipboard.writeText(webhookUrl);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      // Clipboard unavailable (e.g. insecure context) — the URL is still shown.
    }
  };

  const saveDisabled =
    update.isPending ||
    (triggerType === 'EVENT' && eventType.trim().length === 0);

  return (
    <section className="rounded-2xl border border-white/[0.07] bg-white/[0.02] p-5">
      <div className="mb-3 flex items-center justify-between gap-3">
        <h2 className="text-sm font-medium text-zinc-400">Trigger</h2>
        <span
          className={`inline-block rounded-full px-2.5 py-0.5 text-xs font-medium ${
            isActive ? 'bg-green-500/15 text-green-400' : 'bg-white/[0.06] text-zinc-400'
          }`}
        >
          {workflow.status}
        </span>
      </div>

      <label className="mb-1 block text-xs font-medium text-zinc-400">
        How should this workflow start?
      </label>
      <select
        className="field-modern text-sm"
        value={triggerType}
        onChange={(e) => setTriggerType(e.target.value as TriggerType)}
      >
        {TRIGGER_OPTIONS.map((o) => (
          <option key={o.value} value={o.value}>
            {o.label}
          </option>
        ))}
      </select>
      <p className="mt-1 text-xs text-zinc-500">
        {TRIGGER_OPTIONS.find((o) => o.value === triggerType)?.hint}
      </p>

      {triggerType === 'SCHEDULE' && (
        <div className="mt-3 max-w-sm">
          <ScheduleFields
            value={schedule}
            onChange={setSchedule}
            timeZone={company?.timezone ?? undefined}
          />
        </div>
      )}

      {triggerType === 'EVENT' && (
        <div className="mt-3">
          <label className="mb-1 block text-xs font-medium text-zinc-400">
            Event type
          </label>
          <input
            type="text"
            placeholder="e.g. NEW_PAYMENT"
            className="field-modern font-mono text-sm"
            value={eventType}
            onChange={(e) => setEventType(e.target.value)}
          />

          {connectableMailboxes.length > 0 && (
            <div className="mt-3">
              <label className="mb-1 block text-xs font-medium text-zinc-400">
                Only for this connected mailbox
              </label>
              <select
                className="field-modern text-sm"
                value={connectorId}
                onChange={(e) => setConnectorId(e.target.value)}
              >
                <option value="">Any connected mailbox</option>
                {connectableMailboxes.map((s) => (
                  <option key={s.id} value={s.id}>
                    {s.displayName}
                  </option>
                ))}
              </select>
            </div>
          )}

          <div className="mt-3">
            <div className="mb-1 flex items-center justify-between">
              <label className="block text-xs font-medium text-zinc-400">
                Conditions (all must pass)
              </label>
              <button
                type="button"
                onClick={addCondition}
                className="rounded-lg border border-white/[0.1] px-2.5 py-1 text-xs font-medium text-zinc-300 transition-colors hover:border-white/[0.2] hover:text-white"
              >
                + Add condition
              </button>
            </div>
            {conditions.length === 0 ? (
              <p className="rounded-lg border border-white/[0.06] bg-white/[0.03] px-3 py-2 text-xs text-zinc-500">
                No conditions — fires on every matching event. Add a filter such
                as <code className="font-mono text-zinc-400">data.amount</code> gt{' '}
                <code className="font-mono text-zinc-400">1000</code>.
              </p>
            ) : (
              <div className="space-y-2">
                {conditions.map((row, index) => (
                  <div key={index} className="flex items-center gap-2">
                    <input
                      type="text"
                      placeholder="data.amount"
                      aria-label="Condition path"
                      className="field-modern flex-1 font-mono text-xs"
                      value={row.path}
                      onChange={(e) =>
                        patchCondition(index, { path: e.target.value })
                      }
                    />
                    <div className="w-24 shrink-0">
                      <select
                        aria-label="Condition operator"
                        className="field-modern text-xs"
                        value={row.op}
                        onChange={(e) =>
                          patchCondition(index, {
                            op: e.target.value as EventConditionOp,
                          })
                        }
                      >
                        {EVENT_CONDITION_OPS.map((op) => (
                          <option key={op} value={op}>
                            {op}
                          </option>
                        ))}
                      </select>
                    </div>
                    <input
                      type="text"
                      placeholder={row.op === 'in' ? 'a, b, c' : 'value'}
                      aria-label="Condition value"
                      disabled={!opTakesValue(row.op)}
                      className="field-modern flex-1 font-mono text-xs disabled:opacity-40"
                      value={opTakesValue(row.op) ? row.value : ''}
                      onChange={(e) =>
                        patchCondition(index, { value: e.target.value })
                      }
                    />
                    <button
                      type="button"
                      aria-label="Remove condition"
                      className="rounded-lg p-1.5 text-zinc-500 transition-colors hover:text-red-400"
                      onClick={() => removeCondition(index)}
                    >
                      <X className="h-4 w-4" />
                    </button>
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>
      )}

      {triggerType === 'WEBHOOK' && (
        <div className="mt-3">
          <label className="mb-1 block text-xs font-medium text-zinc-400">
            Webhook URL
          </label>
          {webhookUrl ? (
            <div className="flex items-center gap-2">
              <code className="flex-1 overflow-x-auto rounded-lg border border-white/[0.06] bg-white/[0.03] px-3 py-2 text-xs text-zinc-300">
                {webhookUrl}
              </code>
              <button
                type="button"
                onClick={onCopy}
                className="rounded-lg border border-white/[0.1] px-3 py-1.5 text-xs font-medium text-zinc-300 transition-colors hover:border-white/[0.2] hover:text-white"
              >
                {copied ? 'Copied' : 'Copy'}
              </button>
            </div>
          ) : (
            <p className="rounded-lg border border-white/[0.06] bg-white/[0.03] px-3 py-2 text-xs text-zinc-500">
              Save the webhook trigger and Activate to generate a secret URL.
            </p>
          )}
        </div>
      )}

      <div className="mt-4 flex flex-wrap items-center gap-3">
        <button
          type="button"
          onClick={onSaveTrigger}
          disabled={saveDisabled}
          className="rounded-lg border border-white/[0.1] px-4 py-2 text-sm font-medium text-zinc-300 transition-colors hover:border-white/[0.2] hover:text-white disabled:cursor-not-allowed disabled:opacity-40"
        >
          {update.isPending ? 'Saving…' : 'Save trigger'}
        </button>
        {isActive ? (
          <Button
            variant="violet"
            onClick={() => deactivate.mutate(workflow.id)}
            disabled={deactivate.isPending}
          >
            {deactivate.isPending ? 'Deactivating…' : 'Deactivate'}
          </Button>
        ) : (
          <Button
            variant="violet"
            onClick={() => activate.mutate(workflow.id)}
            disabled={!canActivate || activate.isPending}
          >
            {activate.isPending ? 'Activating…' : 'Activate'}
          </Button>
        )}
      </div>

      {!canActivate && !isActive && (
        <p className="mt-3 rounded-lg border border-amber-500/20 bg-amber-500/10 px-3 py-2 text-sm text-amber-400">
          Add at least one step and <strong>Save</strong> it before activating.
        </p>
      )}
      {activate.isError && (
        <p className="mt-2 text-sm text-red-400">
          {activate.error?.message ?? 'Could not activate'}
        </p>
      )}
      {update.isError && (
        <p className="mt-2 text-sm text-red-400">
          {update.error?.message ?? 'Could not save trigger'}
        </p>
      )}
    </section>
  );
}
