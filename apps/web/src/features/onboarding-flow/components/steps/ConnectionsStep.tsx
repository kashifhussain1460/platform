'use client';

import { useState } from 'react';
import { AlertTriangle, Check, Loader2 } from 'lucide-react';
import { skillFor, templateFor } from '../../mockData';
import { useOnboardingFlow } from '../../state';
import type { ConnectionState } from '../../types';
import { EmployeeContextHeader } from '../EmployeeContextHeader';
import { FlowShell } from '../FlowShell';
import { StepFooter } from '../StepFooter';

const STATE_LABEL: Record<ConnectionState, string> = {
  connected: 'Connected',
  not_connected: 'Not connected',
  connecting: 'Connecting…',
  error: 'Connection failed',
};

const STATE_STYLE: Record<ConnectionState, string> = {
  connected: 'bg-emerald-500/15 text-emerald-400',
  not_connected: 'bg-white/[0.06] text-fg-muted',
  connecting: 'bg-amber-500/15 text-amber-400',
  error: 'bg-red-500/15 text-red-400',
};

/**
 * Mock connect flow — real OAuth is Phase 2/3. Deliberately NOT a coin-flip:
 * "Connect" always succeeds after a short delay (the happy path a reviewer
 * exercises 95% of the time), and a separate "Simulate connection error"
 * action reaches the error state deterministically, so that state is
 * demonstrable rather than hoped-for.
 */
export function ConnectionsStep() {
  const { activeEmployee, dispatch, goToStep, prevStep } = useOnboardingFlow();
  const [pending, setPending] = useState<Set<string>>(new Set());

  if (!activeEmployee) {
    return (
      <FlowShell heading="Connect Services">
        <p className="text-sm text-app-ink-3">No AI Employees selected yet.</p>
        <StepFooter onBack={prevStep} onContinue={() => goToStep('configureEmployees')} />
      </FlowShell>
    );
  }

  const template = templateFor(activeEmployee.templateKey);
  const employeeId = activeEmployee.id;
  const connectable = activeEmployee.skillKeys
    .map((key) => skillFor(key))
    .filter((s): s is NonNullable<typeof s> => Boolean(s?.requiresConnection));
  const connectedCount = connectable.filter((s) => activeEmployee.connections[s.key] === 'connected').length;
  const backToHub = () => goToStep('configureEmployees');

  const connect = (skillKey: string) => {
    setPending((p) => new Set(p).add(skillKey));
    dispatch({ type: 'SET_CONNECTION_STATE', employeeId, skillKey, state: 'connecting' });
    setTimeout(() => {
      dispatch({ type: 'SET_CONNECTION_STATE', employeeId, skillKey, state: 'connected' });
      setPending((p) => {
        const next = new Set(p);
        next.delete(skillKey);
        return next;
      });
    }, 800);
  };

  const simulateError = (skillKey: string) => {
    dispatch({ type: 'SET_CONNECTION_STATE', employeeId, skillKey, state: 'error' });
  };

  return (
    <FlowShell
      heading={`Connect Tools for ${activeEmployee.name || template.name}`}
      subtitle="Link the tools this employee will use to access data, take actions and collaborate with your team."
      wide
    >
      <EmployeeContextHeader employee={activeEmployee} />

      <div className="grid gap-6 lg:grid-cols-[1fr_260px]">
        <div>
          {connectable.length === 0 ? (
            <p className="rounded-xl border border-dashed border-white/[0.1] px-4 py-6 text-center text-sm text-fg-muted">
              This employee has no skills that need a connection yet. Go back to Skills to add
              one.
            </p>
          ) : (
            <ul className="divide-y divide-white/[0.06] rounded-xl border border-white/[0.08]">
              {connectable.map((skill) => {
                const state = activeEmployee.connections[skill.key] ?? 'not_connected';
                const Icon = skill.icon;
                const busy = pending.has(skill.key);
                return (
                  <li key={skill.key} className="flex items-center justify-between gap-3 px-4 py-3.5">
                    <div className="flex min-w-0 items-center gap-3">
                      <span className="flex h-9 w-9 shrink-0 items-center justify-center overflow-hidden rounded-lg bg-white/[0.06] p-1.5">
                        <Icon className="h-full w-full" />
                      </span>
                      <div className="min-w-0">
                        <p className="truncate text-sm font-medium text-white">{skill.name}</p>
                        <span
                          className={`mt-0.5 inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[11px] font-medium ${STATE_STYLE[state]}`}
                        >
                          {state === 'connecting' && <Loader2 className="h-3 w-3 animate-spin" />}
                          {state === 'connected' && <Check className="h-3 w-3" />}
                          {state === 'error' && <AlertTriangle className="h-3 w-3" />}
                          {STATE_LABEL[state]}
                        </span>
                      </div>
                    </div>

                    <div className="flex shrink-0 items-center gap-2">
                      {state === 'connected' ? (
                        <button
                          type="button"
                          onClick={() =>
                            dispatch({ type: 'SET_CONNECTION_STATE', employeeId, skillKey: skill.key, state: 'not_connected' })
                          }
                          className="rounded-lg border border-white/[0.1] px-3 py-1.5 text-xs font-medium text-zinc-300 hover:border-white/[0.2]"
                        >
                          Manage
                        </button>
                      ) : (
                        <>
                          <button
                            type="button"
                            disabled={busy}
                            onClick={() => connect(skill.key)}
                            className="rounded-lg bg-violet px-3 py-1.5 text-xs font-medium text-white transition-colors hover:bg-violet-hover disabled:opacity-60"
                          >
                            {busy ? 'Connecting…' : state === 'error' ? 'Retry' : 'Connect'}
                          </button>
                          {state !== 'connecting' && !busy && (
                            <button
                              type="button"
                              onClick={() => simulateError(skill.key)}
                              className="text-[11px] text-fg-muted underline hover:text-zinc-300"
                            >
                              Simulate error
                            </button>
                          )}
                        </>
                      )}
                    </div>
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
                  const state = activeEmployee.connections[skill.key] ?? 'not_connected';
                  return (
                    <li key={skill.key} className="flex items-center justify-between gap-2 text-sm">
                      <span className="truncate text-zinc-200">{skill.name}</span>
                      {state === 'connected' ? (
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
