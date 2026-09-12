'use client';

import { useState } from 'react';
import { AlertTriangle, Check, Loader2 } from 'lucide-react';
import type { ConfigFieldDto, InstalledSkillDto } from '@vaep/types';
import {
  useCatalog,
  useConfigureSkill,
  useConnectSkill,
  useEmployeeSkills,
  useInstalledSkills,
  useVerifyConnection,
} from '@/features/skills/hooks';
import { authorizeOAuth, type VerifyConnectionResult } from '@/features/skills/api';
import { iconForSkill } from '../../skillIcons';
import { useActiveEmployee } from '../../useActiveEmployee';
import { useOnboardingWizardStore } from '../../wizardStore';
import { EmployeeContextHeader } from '../EmployeeContextHeader';
import { FlowShell } from '../FlowShell';
import { StepFooter } from '../StepFooter';

type FieldValue = string | number | boolean;
type VerifyDisplay = VerifyConnectionResult | { ok: false; message: string };

const STATUS_LABEL: Record<InstalledSkillDto['connectionStatus'], string> = {
  CONNECTED: 'Connected',
  NOT_CONNECTED: 'Not connected',
  DEGRADED: 'Degraded',
  DISCONNECTED: 'Disconnected',
};

const STATUS_STYLE: Record<InstalledSkillDto['connectionStatus'], string> = {
  CONNECTED: 'bg-emerald-500/15 text-emerald-400',
  NOT_CONNECTED: 'bg-white/[0.06] text-fg-muted',
  DEGRADED: 'bg-amber-500/15 text-amber-400',
  DISCONNECTED: 'bg-red-500/15 text-red-400',
};

/**
 * Begin the real OAuth authorization-code flow: fetch the provider authorize
 * URL and hand the browser off to it. A one-off function (not a hook) since
 * it's a single `window.location.assign` side effect, not cacheable
 * query/mutation state — mirrors what `SkillRequirementCard` does for the AI
 * Assist flow.
 *
 * KNOWN GAP (backend, out of this file's scope): `oauth.service.ts`'s
 * `RETURN_TO_PREFIXES` allowlist only covers `/assist/`, `/workflows/` and
 * `/employees/`. This onboarding page isn't on it, so the OAuth callback
 * will fall back to `/skills` instead of back into the wizard after a real
 * provider round-trip. Passing the real pathname is still the correct
 * intent (costs nothing, and starts working the moment that allowlist is
 * widened) — flagged here rather than silently working around it.
 */
async function startOAuth(installedSkillId: string): Promise<void> {
  const { url } = await authorizeOAuth(installedSkillId, window.location.pathname);
  window.location.assign(url);
}

function ConfigField({
  field,
  value,
  onChange,
}: {
  field: ConfigFieldDto;
  value: FieldValue | undefined;
  onChange: (value: FieldValue) => void;
}) {
  const id = `connect-field-${field.key}`;

  if (field.type === 'boolean') {
    return (
      <label htmlFor={id} className="flex items-center gap-2 text-sm text-zinc-300">
        <input
          id={id}
          type="checkbox"
          checked={Boolean(value)}
          onChange={(e) => onChange(e.target.checked)}
          className="h-4 w-4 rounded-md border-white/20 bg-white/5 accent-[#6a30ec]"
        />
        {field.label}
      </label>
    );
  }

  if (field.type === 'select') {
    return (
      <div>
        <label htmlFor={id} className="mb-1 block text-xs font-medium text-zinc-300">
          {field.label}
          {field.required && ' *'}
        </label>
        <select
          id={id}
          className="field-modern"
          value={typeof value === 'string' ? value : ''}
          onChange={(e) => onChange(e.target.value)}
        >
          <option value="" disabled>
            Select…
          </option>
          {(field.options ?? []).map((o) => (
            <option key={o} value={o}>
              {o}
            </option>
          ))}
        </select>
      </div>
    );
  }

  if (field.type === 'textarea') {
    return (
      <div>
        <label htmlFor={id} className="mb-1 block text-xs font-medium text-zinc-300">
          {field.label}
          {field.required && ' *'}
        </label>
        <textarea
          id={id}
          className="field-modern min-h-[60px] resize-none"
          placeholder={field.placeholder}
          value={typeof value === 'string' ? value : ''}
          onChange={(e) => onChange(e.target.value)}
        />
        {field.help && <p className="mt-0.5 text-[11px] text-fg-muted">{field.help}</p>}
      </div>
    );
  }

  return (
    <div>
      <label htmlFor={id} className="mb-1 block text-xs font-medium text-zinc-300">
        {field.label}
        {field.required && ' *'}
      </label>
      <input
        id={id}
        type={field.secret ? 'password' : field.type === 'number' ? 'number' : 'text'}
        className="field-modern"
        placeholder={field.placeholder}
        value={value === undefined ? '' : String(value)}
        onChange={(e) => onChange(field.type === 'number' ? Number(e.target.value) : e.target.value)}
      />
      {field.help && <p className="mt-0.5 text-[11px] text-fg-muted">{field.help}</p>}
    </div>
  );
}

export function ConnectionsStep() {
  const goToStep = useOnboardingWizardStore((s) => s.goToStep);
  const { employee } = useActiveEmployee();
  const backToHub = () => goToStep('configureEmployees');

  const catalogQuery = useCatalog();
  const catalog = catalogQuery.data ?? [];
  // Company-wide installed skills — the only place connectionType/status and
  // configSchema-backed `config` live for a given InstalledSkill row.
  const installedSkillsQuery = useInstalledSkills();
  const installedSkills = installedSkillsQuery.data ?? [];
  // Which InstalledSkill rows are actually assigned to THIS employee — same
  // join Task 10 needed, since EmployeeSkillDto only carries installedSkillId.
  const employeeSkillsQuery = useEmployeeSkills(employee?.id ?? '');
  const employeeSkills = employeeSkillsQuery.data ?? [];

  const configureSkill = useConfigureSkill();
  const connectSkill = useConnectSkill();
  const verifyConnection = useVerifyConnection();

  const [pendingId, setPendingId] = useState<string | null>(null);
  const [openId, setOpenId] = useState<string | null>(null);
  const [formValues, setFormValues] = useState<Record<string, FieldValue>>({});
  // Surfaces the most recent connect/configure/verify/OAuth failure inline —
  // every one of these mutations rolls back optimistic state on error, which
  // otherwise reads as a click that silently did nothing.
  const [actionError, setActionError] = useState<string | null>(null);
  const [verifyResults, setVerifyResults] = useState<Record<string, VerifyDisplay>>({});

  if (!employee) {
    return (
      <FlowShell heading="Connect Services">
        <p className="text-sm text-fg-muted">No AI Employee selected yet.</p>
        <StepFooter onBack={backToHub} onContinue={backToHub} />
      </FlowShell>
    );
  }

  // Load gate (same lesson Task 10 had to add after review): don't render
  // clickable connect/verify buttons before installed-skills and
  // employee-skills have actually resolved. `useInstalledSkills()` has no
  // staleTime guarantee, so there's a real first-render race where a click
  // here would read every skill as not-yet-connected and either no-op or
  // fire a connect against stale/undefined state.
  if (!catalogQuery.isSuccess || !installedSkillsQuery.isSuccess || !employeeSkillsQuery.isSuccess) {
    if (catalogQuery.isError || installedSkillsQuery.isError || employeeSkillsQuery.isError) {
      return (
        <FlowShell heading="Connect Services">
          <EmployeeContextHeader employee={employee} />
          <p className="text-sm text-red-400">
            Couldn't load connections.{' '}
            {(catalogQuery.error ?? installedSkillsQuery.error ?? employeeSkillsQuery.error)?.message ??
              'Please try again.'}
          </p>
          <StepFooter
            onBack={backToHub}
            onContinue={() => {
              void catalogQuery.refetch();
              void installedSkillsQuery.refetch();
              void employeeSkillsQuery.refetch();
            }}
            continueLabel="Retry"
          />
        </FlowShell>
      );
    }
    return (
      <FlowShell heading="Connect Services">
        <EmployeeContextHeader employee={employee} />
        <p className="text-sm text-fg-muted">Loading connections…</p>
      </FlowShell>
    );
  }

  const catalogByKey = new Map(catalog.map((s) => [s.key, s]));
  const assignedInstalledIds = new Set(employeeSkills.map((es) => es.installedSkillId));

  // Ownership filter (Task 10's lesson): an InstalledSkillDto with employeeId
  // set is owned by, and only usable by, that one employee; employeeId ===
  // null is company-wide. Then narrow to skills actually ASSIGNED to this
  // employee (not just installed company-wide and merely usable), and to
  // skills whose connection type isn't 'none' — a 'none' skill is
  // operational the moment it's installed and never needs a connect action.
  const connectable = installedSkills
    .filter((s) => s.employeeId === null || s.employeeId === employee.id)
    .filter((s) => assignedInstalledIds.has(s.id))
    .filter((s) => s.connectionType && s.connectionType !== 'none');

  const connectedCount = connectable.filter((s) => s.connectionStatus === 'CONNECTED').length;

  const updateField = (key: string, value: FieldValue) => {
    setFormValues((prev) => ({ ...prev, [key]: value }));
  };

  const openForm = (skill: InstalledSkillDto) => {
    setActionError(null);
    setOpenId(skill.id);
    const def = catalogByKey.get(skill.skillKey);
    const initial: Record<string, FieldValue> = {};
    (def?.configSchema ?? []).forEach((field) => {
      if (field.secret) return; // never pre-fill secrets — they're never returned raw
      const existing = (skill.config as Record<string, unknown> | null)?.[field.key];
      if (typeof existing === 'string' || typeof existing === 'number' || typeof existing === 'boolean') {
        initial[field.key] = existing;
      }
    });
    setFormValues(initial);
  };

  const closeForm = () => {
    setOpenId(null);
    setFormValues({});
  };

  const onConnectOAuth = async (skill: InstalledSkillDto) => {
    setActionError(null);
    setPendingId(skill.id);
    try {
      await startOAuth(skill.id);
      // Browser is navigating away — no need to clear pendingId.
    } catch {
      setPendingId(null);
      setActionError(`Couldn't start connecting ${skill.displayName}. Try again.`);
    }
  };

  /**
   * Manual (api_key) connect: the skill's real `configSchema` (fetched via
   * useCatalog, same source Task 10 uses) drives the form, not a blank
   * `credentials: {}` placeholder. Non-secret fields are saved as `config`
   * (useConfigureSkill) and secret fields as `credentials`
   * (useConnectSkill) — this mirrors the real backend contract:
   * `SkillsService.configureSkill` partitions a submitted config object into
   * the `config` and `credentials` columns by each field's `secret` flag,
   * and `connectSkill` is what actually validates (for skills with a
   * provider adapter) and flips `connectionStatus` to CONNECTED. Config is
   * saved first so an adapter's validation sees the full picture (e.g. the
   * `email` skill's SMTP host/user together with its password).
   */
  const submitManualConnect = (skill: InstalledSkillDto) => {
    const def = catalogByKey.get(skill.skillKey);
    const fields = def?.configSchema ?? [];
    const missing = fields.filter((f) => f.required && (formValues[f.key] === undefined || formValues[f.key] === ''));
    if (missing.length > 0) {
      setActionError(`Fill in ${missing.map((f) => f.label).join(', ')} before connecting.`);
      return;
    }

    const configValues: Record<string, unknown> = {};
    const credentialValues: Record<string, unknown> = {};
    fields.forEach((field) => {
      const value = formValues[field.key];
      if (value === undefined || value === '') return;
      if (field.secret) credentialValues[field.key] = value;
      else configValues[field.key] = value;
    });

    setActionError(null);
    setPendingId(skill.id);

    const runConnect = () => {
      connectSkill.mutate(
        { id: skill.id, data: { credentials: credentialValues } },
        {
          onSuccess: () => {
            setActionError(null);
            closeForm();
          },
          onError: (err) => setActionError(err.message || `The provider rejected the connection for ${skill.displayName}.`),
          onSettled: () => setPendingId(null),
        },
      );
    };

    if (Object.keys(configValues).length > 0) {
      configureSkill.mutate(
        { id: skill.id, data: { config: configValues } },
        {
          onSuccess: runConnect,
          onError: (err) => {
            setActionError(err.message || `Couldn't save settings for ${skill.displayName}.`);
            setPendingId(null);
          },
        },
      );
    } else {
      runConnect();
    }
  };

  const onVerify = (skill: InstalledSkillDto) => {
    setActionError(null);
    setPendingId(skill.id);
    verifyConnection.mutate(
      { id: skill.id },
      {
        onSuccess: (result) => {
          setVerifyResults((prev) => ({ ...prev, [skill.id]: result }));
          if (!result.ok) setActionError(`Verification failed for ${skill.displayName}.`);
        },
        onError: (err) => {
          const message = err.message || `Couldn't verify ${skill.displayName}.`;
          setVerifyResults((prev) => ({ ...prev, [skill.id]: { ok: false, message } }));
          setActionError(message);
        },
        onSettled: () => setPendingId(null),
      },
    );
  };

  return (
    <FlowShell heading={`Connect Tools for ${employee.name}`} subtitle="Link the tools this employee will use." wide>
      <EmployeeContextHeader employee={employee} />

      {actionError && (
        <p className="mb-4 rounded-lg border border-red-500/30 bg-red-500/10 px-3 py-2 text-sm text-red-400">
          {actionError}
        </p>
      )}

      <div className="grid gap-6 lg:grid-cols-[1fr_260px]">
        <div>
          {connectable.length === 0 ? (
            <p className="rounded-xl border border-dashed border-white/[0.1] px-4 py-6 text-center text-sm text-fg-muted">
              This employee has no skills that need a connection yet. Go back to Skills to add one.
            </p>
          ) : (
            <ul className="divide-y divide-white/[0.06] rounded-xl border border-white/[0.08]">
              {connectable.map((skill) => {
                const def = catalogByKey.get(skill.skillKey);
                const Icon = iconForSkill(skill.skillKey);
                const isOAuth = skill.connectionType === 'oauth';
                const busy = pendingId === skill.id;
                const isOpen = openId === skill.id;
                const verifyResult = verifyResults[skill.id];
                const needsReconnect = skill.connectionStatus === 'DEGRADED' || skill.connectionStatus === 'DISCONNECTED';
                const canVerify = skill.connectionStatus === 'CONNECTED' || skill.connectionStatus === 'DEGRADED';

                return (
                  <li key={skill.id} className="px-4 py-3.5">
                    <div className="flex items-center justify-between gap-3">
                      <div className="flex min-w-0 items-center gap-3">
                        <span className="flex h-9 w-9 shrink-0 items-center justify-center overflow-hidden rounded-lg bg-white/[0.06] p-1.5">
                          <Icon className="h-full w-full" />
                        </span>
                        <div className="min-w-0">
                          <p className="truncate text-sm font-medium text-white">{def?.name ?? skill.displayName}</p>
                          <span
                            className={`mt-0.5 inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[11px] font-medium ${STATUS_STYLE[skill.connectionStatus]}`}
                          >
                            {skill.connectionStatus === 'CONNECTED' && <Check className="h-3 w-3" />}
                            {needsReconnect && <AlertTriangle className="h-3 w-3" />}
                            {STATUS_LABEL[skill.connectionStatus]}
                          </span>
                        </div>
                      </div>

                      <div className="flex shrink-0 items-center gap-2">
                        {canVerify && (
                          <button
                            type="button"
                            disabled={busy}
                            onClick={() => onVerify(skill)}
                            className="rounded-lg border border-white/[0.1] px-3 py-1.5 text-xs font-medium text-zinc-300 hover:border-white/[0.2] disabled:opacity-60"
                          >
                            {busy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : 'Verify'}
                          </button>
                        )}
                        {skill.connectionStatus !== 'CONNECTED' &&
                          (isOAuth ? (
                            <button
                              type="button"
                              disabled={busy}
                              onClick={() => void onConnectOAuth(skill)}
                              className="rounded-lg bg-violet px-3 py-1.5 text-xs font-medium text-white transition-colors hover:bg-violet-hover disabled:opacity-60"
                            >
                              {busy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : needsReconnect ? 'Reconnect' : 'Connect'}
                            </button>
                          ) : (
                            <button
                              type="button"
                              disabled={busy}
                              onClick={() => (isOpen ? closeForm() : openForm(skill))}
                              className="rounded-lg bg-violet px-3 py-1.5 text-xs font-medium text-white transition-colors hover:bg-violet-hover disabled:opacity-60"
                            >
                              {isOpen ? 'Cancel' : needsReconnect ? 'Reconnect' : 'Connect'}
                            </button>
                          ))}
                      </div>
                    </div>

                    {!isOAuth && isOpen && (
                      <div className="mt-3 space-y-3 rounded-xl border border-white/[0.08] bg-white/[0.02] p-3.5">
                        {(def?.configSchema ?? []).length === 0 ? (
                          <p className="text-xs text-fg-muted">This connection needs no extra details.</p>
                        ) : (
                          (def?.configSchema ?? []).map((field) => (
                            <ConfigField
                              key={field.key}
                              field={field}
                              value={formValues[field.key]}
                              onChange={(v) => updateField(field.key, v)}
                            />
                          ))
                        )}
                        <div className="flex justify-end gap-2 pt-1">
                          <button
                            type="button"
                            onClick={closeForm}
                            className="text-xs text-fg-muted underline hover:text-zinc-300"
                          >
                            Cancel
                          </button>
                          <button
                            type="button"
                            disabled={busy}
                            onClick={() => submitManualConnect(skill)}
                            className="rounded-lg bg-violet px-3 py-1.5 text-xs font-medium text-white hover:bg-violet-hover disabled:opacity-60"
                          >
                            {busy ? 'Connecting…' : 'Save & Connect'}
                          </button>
                        </div>
                      </div>
                    )}

                    {verifyResult && (
                      <p className={`mt-2 text-xs ${verifyResult.ok ? 'text-emerald-400' : 'text-red-400'}`}>
                        {verifyResult.ok
                          ? `Verified${verifyResult.account ? ` — ${verifyResult.account}` : ''}.`
                          : 'steps' in verifyResult
                            ? (verifyResult.steps.find((s) => s.status === 'FAILED')?.detail ?? 'Verification failed.')
                            : verifyResult.message}
                      </p>
                    )}
                  </li>
                );
              })}
            </ul>
          )}
        </div>

        <div className="rounded-2xl border border-white/[0.08] bg-white/[0.02] p-4 lg:h-fit">
          <p className="mb-3 text-sm font-semibold text-white">Connection Summary</p>
          {connectable.length === 0 ? (
            <p className="text-xs text-fg-muted">No tools required yet.</p>
          ) : (
            <>
              <p className="mb-3 text-2xl font-bold text-white">
                {connectedCount}
                <span className="text-base font-medium text-fg-muted">/{connectable.length}</span>
              </p>
              <ul className="space-y-2">
                {connectable.map((skill) => {
                  const def = catalogByKey.get(skill.skillKey);
                  return (
                    <li key={skill.id} className="flex items-center justify-between gap-2 text-sm">
                      <span className="truncate text-zinc-200">{def?.name ?? skill.displayName}</span>
                      {skill.connectionStatus === 'CONNECTED' ? (
                        <Check className="h-3.5 w-3.5 shrink-0 text-emerald-400" />
                      ) : (
                        <span className="shrink-0 text-xs text-fg-muted">—</span>
                      )}
                    </li>
                  );
                })}
              </ul>
            </>
          )}
        </div>
      </div>

      <StepFooter onBack={backToHub} onContinue={backToHub} continueLabel="Save & Back to Hub →" />
    </FlowShell>
  );
}
