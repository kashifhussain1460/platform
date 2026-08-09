'use client';

import { useState } from 'react';
import type { TriggerType, WorkflowDto } from '@vaep/types';
import { useUpdateWorkflow } from '../../../hooks';
import { useInstalledSkills } from '@/features/skills/hooks';

const API_URL = process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:4000';

const inputCls =
  'w-full rounded-lg border border-wf-hairline bg-void-card px-3 py-2 text-sm text-wf-ink outline-none placeholder:text-wf-ink-3 focus-visible:ring-2 focus-visible:ring-wf-focus disabled:opacity-60';

const TRIGGERS: { value: TriggerType; label: string; hint: string }[] = [
  { value: 'MANUAL', label: 'Manual', hint: 'Run on demand from the Run button.' },
  { value: 'SCHEDULE', label: 'Schedule', hint: 'Run automatically on a fixed interval.' },
  { value: 'WEBHOOK', label: 'Webhook', hint: 'Run when an external system POSTs to a secret URL.' },
  { value: 'EVENT', label: 'Event', hint: 'Run when a matching platform event fires.' },
];

/**
 * TriggerInspector — configure how the workflow starts, on the canvas (doc 29
 * §3.E). Trigger settings are workflow-level (`triggerType`/`triggerConfig`), NOT
 * node config, so this saves via `useUpdateWorkflow` rather than the node-patch
 * path. Advanced EVENT conditions stay in the Steps view for now.
 */
export function TriggerInspector({
  workflow,
  readOnly,
}: {
  workflow: WorkflowDto;
  readOnly?: boolean;
}) {
  const [triggerType, setTriggerType] = useState<TriggerType>(workflow.triggerType);
  const [minutes, setMinutes] = useState<number>(() => {
    const ms = workflow.triggerConfig?.everyMs;
    return typeof ms === 'number' && ms > 0 ? Math.max(1, Math.round(ms / 60_000)) : 5;
  });
  const [eventType, setEventType] = useState<string>(workflow.triggerConfig?.eventType ?? '');
  const [connectorId, setConnectorId] = useState<string>(workflow.triggerConfig?.connectorId ?? '');

  const { data: skills } = useInstalledSkills();
  const mailboxes = (skills ?? []).filter(
    (s) => s.skillKey === 'gmail' && s.connectionStatus === 'CONNECTED',
  );
  const update = useUpdateWorkflow();
  const webhookUrl = workflow.webhookToken
    ? `${API_URL}/workflows/webhooks/${workflow.webhookToken}`
    : null;

  const save = () => {
    let triggerConfig: Record<string, unknown> | undefined;
    if (triggerType === 'SCHEDULE') {
      triggerConfig = { everyMs: Math.max(1, minutes) * 60_000 };
    } else if (triggerType === 'EVENT') {
      triggerConfig = {
        eventType: eventType.trim(),
        ...(connectorId ? { connectorId } : {}),
      };
    }
    update.mutate({ id: workflow.id, data: { triggerType, triggerConfig } });
  };

  const saveDisabled =
    readOnly || update.isPending || (triggerType === 'EVENT' && eventType.trim().length === 0);

  return (
    <div className="space-y-4">
      <label className="block">
        <span className="mb-1 block text-xs font-medium text-wf-ink-2">How should this start?</span>
        <select
          className={inputCls}
          value={triggerType}
          disabled={readOnly}
          onChange={(e) => setTriggerType(e.target.value as TriggerType)}
        >
          {TRIGGERS.map((t) => (
            <option key={t.value} value={t.value}>
              {t.label}
            </option>
          ))}
        </select>
        <span className="mt-1 block text-xs text-wf-ink-3">
          {TRIGGERS.find((t) => t.value === triggerType)?.hint}
        </span>
      </label>

      {triggerType === 'SCHEDULE' && (
        <label className="block">
          <span className="mb-1 block text-xs font-medium text-wf-ink-2">Run every (minutes)</span>
          <input
            type="number"
            min={1}
            className={inputCls}
            value={minutes}
            disabled={readOnly}
            onChange={(e) => setMinutes(Number(e.target.value))}
          />
        </label>
      )}

      {triggerType === 'EVENT' && (
        <>
          <label className="block">
            <span className="mb-1 block text-xs font-medium text-wf-ink-2">Event type</span>
            <input
              type="text"
              placeholder="NEW_PAYMENT"
              className={`${inputCls} font-mono`}
              value={eventType}
              disabled={readOnly}
              onChange={(e) => setEventType(e.target.value)}
            />
          </label>
          {mailboxes.length > 0 && (
            <label className="block">
              <span className="mb-1 block text-xs font-medium text-wf-ink-2">
                Only for this mailbox
              </span>
              <select
                className={inputCls}
                value={connectorId}
                disabled={readOnly}
                onChange={(e) => setConnectorId(e.target.value)}
              >
                <option value="">Any connected mailbox</option>
                {mailboxes.map((s) => (
                  <option key={s.id} value={s.id}>
                    {s.displayName}
                  </option>
                ))}
              </select>
            </label>
          )}
          <p className="text-xs text-wf-ink-3">
            Advanced event conditions are in the Steps view.
          </p>
        </>
      )}

      {triggerType === 'WEBHOOK' && (
        <div>
          <span className="mb-1 block text-xs font-medium text-wf-ink-2">Webhook URL</span>
          {webhookUrl ? (
            <code className="block overflow-x-auto rounded-lg border border-wf-hairline bg-void-card px-3 py-2 text-xs text-wf-ink-2">
              {webhookUrl}
            </code>
          ) : (
            <p className="rounded-lg border border-wf-hairline bg-void-card px-3 py-2 text-xs text-wf-ink-3">
              Save the webhook trigger and activate to generate a secret URL.
            </p>
          )}
        </div>
      )}

      {update.isError ? (
        <p className="text-xs text-status-failed">{update.error.message}</p>
      ) : update.isSuccess && !update.isPending ? (
        <p className="text-xs text-status-succeeded">Trigger saved.</p>
      ) : null}

      {!readOnly && (
        <button
          type="button"
          onClick={save}
          disabled={saveDisabled}
          className="rounded-lg bg-violet px-4 py-1.5 text-sm font-semibold text-white transition-colors hover:brightness-110 disabled:cursor-not-allowed disabled:opacity-50"
        >
          {update.isPending ? 'Saving…' : 'Save trigger'}
        </button>
      )}
    </div>
  );
}
