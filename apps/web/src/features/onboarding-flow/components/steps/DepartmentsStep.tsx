'use client';

import { useEffect, useState } from 'react';
import { DEPARTMENT_PRESETS } from '@vaep/types';
import { useOnboardingStatus, useSaveOnboardingDepartments } from '@/features/onboarding/hooks';
import { useOnboardingWizardStore } from '../../wizardStore';
import { CardCheckbox } from '../CardCheckbox';
import { FlowShell } from '../FlowShell';
import { StepFooter } from '../StepFooter';

/**
 * Reuses `useSaveOnboardingDepartments()` verbatim — the same hook and the
 * same real `Department` rows the old 4-step `/onboarding` wizard's own
 * dedicated Departments step wrote. That step's own doc-comment explains why
 * this can't be silently dropped when this 12-step flow replaces it:
 * production once sent a literal `departments: []` on every signup, and
 * everything scoped on department (approval routing, workflow permissions)
 * was inert as a result — not because the code was missing, but because the
 * axis it scopes on was empty. This flow's own Complete step still calls
 * `POST /onboarding/complete` with `departments: []`, so without a real
 * step writing them first, replacing `/onboarding` with this flow would
 * silently reintroduce the exact bug that step was built to fix.
 */
export function DepartmentsStep() {
  const nextStep = useOnboardingWizardStore((s) => s.nextStep);
  const prevStep = useOnboardingWizardStore((s) => s.prevStep);

  const { data: status } = useOnboardingStatus();
  const saveDepartments = useSaveOnboardingDepartments();
  const [selected, setSelected] = useState<string[]>([]);
  const [customDepartment, setCustomDepartment] = useState('');
  // Visible failure feedback (Tasks 10-13's recurring lesson): there is no
  // global mutation error handler, so a failed save must surface here or the
  // Continue button just re-enables with nothing having happened.
  const [actionError, setActionError] = useState<string | null>(null);

  useEffect(() => {
    if (status?.departments) setSelected(status.departments);
  }, [status?.departments]);

  const toggle = (name: string) => {
    setSelected((prev) =>
      prev.some((d) => d.toLowerCase() === name.toLowerCase())
        ? prev.filter((d) => d.toLowerCase() !== name.toLowerCase())
        : [...prev, name],
    );
  };

  const addCustomDepartment = () => {
    const value = customDepartment.trim().replace(/\s+/g, ' ');
    if (!value) return;
    // Case-insensitive, because "sales" and "Sales" are one department and
    // the server's unique index would otherwise reject the second one.
    if (!selected.some((d) => d.toLowerCase() === value.toLowerCase())) {
      setSelected((prev) => [...prev, value]);
    }
    setCustomDepartment('');
  };

  const customEntries = selected.filter(
    (d) => !DEPARTMENT_PRESETS.some((p) => p.toLowerCase() === d.toLowerCase()),
  );

  const onContinue = () => {
    setActionError(null);
    saveDepartments.mutate(selected, {
      onSuccess: () => nextStep(),
      onError: (err) => setActionError(err.message || "Couldn't save your departments."),
    });
  };

  return (
    <FlowShell heading="How is your company organised?" subtitle="Add the teams you actually have. You can change this any time.">
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
        {DEPARTMENT_PRESETS.map((preset) => {
          const isSelected = selected.some((d) => d.toLowerCase() === preset.toLowerCase());
          return (
            <button
              key={preset}
              type="button"
              onClick={() => toggle(preset)}
              aria-pressed={isSelected}
              className={`flex items-start justify-between gap-3 rounded-xl border px-4 py-4 text-left text-sm font-medium transition-colors ${
                isSelected
                  ? 'border-violet-secondary/60 bg-violet/[0.1] text-white'
                  : 'border-white/[0.08] bg-white/[0.02] text-zinc-300 hover:border-white/[0.16]'
              }`}
            >
              {preset}
              <CardCheckbox checked={isSelected} className="mt-0.5" />
            </button>
          );
        })}
      </div>

      <div className="mt-5">
        <label htmlFor="custom-dept" className="mb-1.5 block text-sm text-zinc-300">
          Something else?
        </label>
        <div className="flex gap-2">
          <input
            id="custom-dept"
            className="field-modern"
            placeholder="e.g. Customer Success"
            value={customDepartment}
            maxLength={120}
            onChange={(e) => setCustomDepartment(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                // Otherwise Enter submits the wizard from a text box, which
                // finishes onboarding when the user meant "add this one".
                e.preventDefault();
                addCustomDepartment();
              }
            }}
          />
          <button
            type="button"
            onClick={addCustomDepartment}
            disabled={!customDepartment.trim()}
            className="rounded-xl border border-white/[0.12] px-4 py-2 text-sm font-medium text-zinc-300 transition-colors hover:border-white/25 disabled:opacity-50"
          >
            Add
          </button>
        </div>
      </div>

      {customEntries.length > 0 && (
        <div className="mt-4 flex flex-wrap gap-2">
          {customEntries.map((d) => (
            <span
              key={d}
              className="inline-flex items-center gap-2 rounded-full border border-white/[0.12] bg-white/[0.04] px-3 py-1 text-xs text-zinc-200"
            >
              {d}
              <button
                type="button"
                aria-label={`Remove ${d}`}
                className="text-zinc-400 hover:text-white"
                onClick={() => setSelected((prev) => prev.filter((x) => x !== d))}
              >
                ×
              </button>
            </span>
          ))}
        </div>
      )}

      <p className="mt-5 text-[13px] text-fg-muted">
        Departments organise your people and your AI Employees. Everyone can still see everything for now — you can
        limit a department to its own work later in Settings → Organization.
      </p>

      {actionError && (
        <p className="mt-3 rounded-lg border border-red-500/30 bg-red-500/10 px-3 py-2 text-sm text-red-400">
          {actionError}
        </p>
      )}

      <StepFooter onBack={prevStep} onContinue={onContinue} continueDisabled={saveDepartments.isPending} />
    </FlowShell>
  );
}
