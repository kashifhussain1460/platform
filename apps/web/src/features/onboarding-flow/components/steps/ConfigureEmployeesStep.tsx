'use client';

import { useEffect, useRef, useState } from 'react';
import { zodResolver } from '@hookform/resolvers/zod';
import { useForm } from 'react-hook-form';
import { Globe, Link2, User, Workflow, BookOpen, Zap, ChevronRight } from 'lucide-react';
import type { AiEmployeeDto } from '@vaep/types';
import { IconField } from '@/components/onboarding/fields';
import { useCreateEmployee, useEmployees, useUpdateEmployee } from '@/features/employees/hooks';
import { templateForRole, EMPLOYEE_TEMPLATES } from '../../mockData';
import { useActiveEmployee } from '../../useActiveEmployee';
import { useOnboardingWizardStore } from '../../wizardStore';
import { employeeConfigSchema, type EmployeeConfigFormValues } from '../../employeeConfigSchema';
import type { EmployeeTemplateKey, FlowStep } from '../../types';
import { EmployeeAvatar } from '../EmployeeAvatar';
import { FlowShell } from '../FlowShell';
import { StepFooter } from '../StepFooter';

const LANGUAGES = ['English', 'Spanish', 'French', 'German', 'Hindi', 'Portuguese'];

function EmployeeStatusPill({ done, isActive }: { done: boolean; isActive: boolean }) {
  if (done) {
    return (
      <span className="shrink-0 rounded-full bg-emerald-500/15 px-2 py-0.5 text-[11px] font-medium text-emerald-400">
        Done
      </span>
    );
  }
  if (isActive) {
    return (
      <span className="shrink-0 rounded-full bg-violet/20 px-2 py-0.5 text-[11px] font-medium text-violet-bright">
        In Progress
      </span>
    );
  }
  return (
    <span className="shrink-0 rounded-full bg-white/[0.06] px-2 py-0.5 text-[11px] font-medium text-fg-muted">
      Not Started
    </span>
  );
}

export function ConfigureEmployeesStep() {
  const selectedTemplateKeys = useOnboardingWizardStore((s) => s.selectedTemplateKeys);
  const employeeOrder = useOnboardingWizardStore((s) => s.employeeOrder);
  const setActiveEmployee = useOnboardingWizardStore((s) => s.setActiveEmployee);
  const pushEmployeeId = useOnboardingWizardStore((s) => s.pushEmployeeId);
  const markVisited = useOnboardingWizardStore((s) => s.markVisited);
  const visitedEmployeeIds = useOnboardingWizardStore((s) => s.visitedEmployeeIds);
  const goToStep = useOnboardingWizardStore((s) => s.goToStep);
  const prevStep = useOnboardingWizardStore((s) => s.prevStep);
  const setErrors = useOnboardingWizardStore((s) => s.setErrors);
  const errors = useOnboardingWizardStore((s) => s.errors);

  const employeesQuery = useEmployees();
  const employees = employeesQuery.data ?? [];
  const createEmployee = useCreateEmployee();
  const updateEmployee = useUpdateEmployee();

  const roster = employeeOrder
    .map((id) => employees.find((e) => e.id === id))
    .filter((e): e is AiEmployeeDto => Boolean(e));
  const { employee: activeEmployee } = useActiveEmployee();

  /**
   * Synchronous in-flight guard for the create-on-demand effect below.
   *
   * `createEmployee.isPending` alone is NOT enough to prevent a duplicate
   * POST here, for two separate reasons:
   *
   * 1. React 18 Strict Mode (on in this app's next.config.js) synchronously
   *    mounts -> cleans up -> remounts every effect in dev. Both invocations
   *    run back-to-back before any React Query state update can flush, so
   *    both would see `isPending === false` and both would call `.mutate()`.
   * 2. `useCreateEmployee()` only optimistically inserts a TEMP row into the
   *    `employees` list cache and invalidates (not `setQueryData`s the real
   *    row) on success. That means there's a real async gap — between the
   *    POST resolving and the subsequent background refetch landing — during
   *    which `createEmployee.isPending` is back to `false`, the new
   *    `activeEmployeeId` has been set, but `roster` still can't find a
   *    matching row (only the stale temp one is in cache). In that window
   *    `activeEmployee` reads as `null` again, which would otherwise look
   *    identical to "nothing created yet" and re-fire this effect for the
   *    same role.
   *
   * A ref sidesteps both: it's set synchronously the instant `.mutate()` is
   * called (so it's already `true` for a Strict-Mode replay), and it's only
   * cleared once `activeEmployee` is confirmed present in `roster` — i.e.
   * once the real row has actually landed, not just once the request
   * technically finished.
   */
  const creatingRef = useRef(false);
  const { mutateAsync: createEmployeeAsync } = createEmployee;

  /**
   * Reconcile `employeeOrder` against the server's real roster for any role
   * currently selected — closing the "KNOWN GAP" the create-effect below has
   * documented since Task 9: `employeeOrder` only ever grows through THIS
   * effect's own `pushEmployeeId` call, so if a create POST actually
   * succeeded server-side but the browser refreshed (or this session was
   * otherwise interrupted) in the single-tick window before that callback
   * ran, the new employee's id never made it in. Without this, the role then
   * permanently reads as "not yet created" here — Configure Hub silently
   * drops it from the tab list, and the create-effect would go on to attempt
   * a duplicate POST for a role that may already be at its per-role cap,
   * which the server then refuses with no clear way for the user to recover.
   * Scoped to roles in `selectedTemplateKeys` only (not every employee the
   * company has) so this doesn't fight `useActiveEmployee`'s deliberate
   * exclusion of pre-existing tenant employees this pass never selected.
   */
  useEffect(() => {
    if (!employeesQuery.isSuccess) return;
    const claimed = new Set(employeeOrder);
    for (const key of new Set(selectedTemplateKeys)) {
      const wanted = selectedTemplateKeys.filter((k) => k === key).length;
      const alreadyOrdered = employeeOrder.filter(
        (id) => employees.find((e) => e.id === id)?.role === key,
      ).length;
      if (alreadyOrdered >= wanted) continue;
      const unclaimed = employees.filter((e) => e.role === key && !claimed.has(e.id));
      for (const e of unclaimed.slice(0, wanted - alreadyOrdered)) {
        pushEmployeeId(e.id);
        claimed.add(e.id);
      }
    }
  }, [employeesQuery.isSuccess, selectedTemplateKeys, employees, employeeOrder, pushEmployeeId]);

  /** Latches a failed create so the effect won't auto-retry it. `roster` is
   * rebuilt fresh every render (not memoized), so the effect's dependency
   * array does not by itself throttle re-runs — without this latch, an
   * `onError` clearing `creatingRef` plus calling `setErrors` (a state
   * update, so a re-render) would let the effect immediately re-fire the
   * same POST, forever, on any failure (seat limit, network blip, etc.),
   * with the loading fallback the only thing the user ever sees. Cleared on
   * success, and by the explicit "Try again" action below — never
   * automatically. */
  const [createError, setCreateError] = useState<{ role: EmployeeTemplateKey; message: string } | null>(null);

  // Visible failure feedback (Tasks 10-13's recurring lesson): the "Next
  // Employee" save has no global mutation error handler, so a failed PATCH
  // here would otherwise look identical to a dead button — the worst
  // instance of this bug since it's the main hub navigation.
  const [actionError, setActionError] = useState<string | null>(null);

  // Materialize the next selected-but-not-yet-created role as a real employee.
  //
  // 🔴 Live-discovered bug (fixed here): this used to call `createEmployee
  // .mutate(vars, { onSuccess, onError })`. Under React 18 Strict Mode's
  // dev-only synchronous mount -> cleanup -> remount of this effect, the
  // mutation's underlying MutationObserver can get unsubscribed/resubscribed
  // between the POST firing and its callback running — the exact same root
  // cause traced and fixed in SuccessStep.tsx's completion tracking. Observed
  // live: POST /employees returned 201 and the row existed in Postgres, but
  // `onSuccess` never ran, so `pushEmployeeId`/`setActiveEmployee` never
  // fired and the screen was stuck on the loading fallback forever with no
  // error and no retry. `mutateAsync`'s returned promise resolves from the
  // mutation's own execution, independent of the observer's subscribe/
  // unsubscribe churn, so driving state off that promise instead of the
  // options-object callbacks sidesteps the whole class of bug. `creatingRef`
  // (a ref, not anything routed through the observer) still does the actual
  // job of preventing a second real POST.
  useEffect(() => {
    // Gate on the employees list having actually loaded at least once. This
    // page has no query hydration/persistence, so on a cold cache (e.g. a
    // browser refresh) `employeesQuery.data` is `undefined` on the first
    // render after the auth gate flips to authenticated — defaulted to `[]`
    // above for convenience elsewhere, but treating that default as "confirmed
    // empty roster" here would re-create the first role even though it
    // already exists server-side and `employeeOrder`/`activeEmployeeId` in
    // sessionStorage already point at it.
    if (!employeesQuery.isSuccess) return;
    // Only treat an active employee as "still being configured, don't create
    // the next one yet" if it's genuinely mid-flow (not yet `markVisited`).
    // Live-discovered bug (fixed here): `activeEmployeeId` is
    // sessionStorage-persisted, so re-entering this step with a NEW pending
    // role (e.g. the user already finished configuring Sales in an earlier
    // pass, then went back to Select Employees and picked Support this
    // time) leaves `activeEmployee` pointing at the already-**visited**
    // Sales row. Treating that leftover as "still in progress" made this
    // effect return before ever checking whether Support needed creating —
    // Configure Hub got stuck showing only the old, already-done employee,
    // with the newly-selected role silently never created.
    if (activeEmployee && !visitedEmployeeIds.includes(activeEmployee.id)) {
      creatingRef.current = false;
      return;
    }
    if (creatingRef.current) return;
    // `selectedTemplateKeys` is a MULTISET now (a role can appear more than
    // once — Select Employees supports picking e.g. 2 Sales on a plan that
    // allows it), so "has this role already been fully created?" must
    // compare COUNTS, not just presence: the old `!roster.some(role===key)`
    // check would stop after the FIRST occurrence of a duplicated role and
    // never create the second one, no matter how many times it appeared in
    // the array.
    const nextKey = selectedTemplateKeys.find(
      (key) =>
        roster.filter((e) => e.role === key).length <
        selectedTemplateKeys.filter((k) => k === key).length,
    );
    if (!nextKey) return;
    // Latched failure for this exact role — wait for the user to explicitly
    // retry rather than looping the same POST on every re-render.
    if (createError && createError.role === nextKey) return;
    const template = EMPLOYEE_TEMPLATES.find((t) => t.key === nextKey);
    if (!template) return;
    creatingRef.current = true;
    createEmployeeAsync({ name: template.name, role: nextKey as AiEmployeeDto['role'], persona: template.defaultPersona })
      .then((created) => {
        setCreateError(null);
        // If the browser refreshes in the window between the server
        // successfully creating this employee and this callback running,
        // the new id never makes it into `employeeOrder`/`activeEmployeeId`
        // here — but the reconciliation effect above now picks it back up
        // on the next render (it compares against the server's real roster,
        // not just what this callback has pushed), so this narrow race no
        // longer causes a lost or duplicated employee.
        pushEmployeeId(created.id);
        setActiveEmployee(created.id);
      })
      .catch((err: { message?: string }) => {
        // Deliberately do NOT clear `creatingRef` here — leaving it `true`
        // (on top of the `createError` latch below) means a stray re-render
        // before the user acts can't slip through and retry on its own.
        setCreateError({ role: nextKey, message: err.message || 'Could not create this employee.' });
      });
    // eslint-disable-next-line react-hooks/exhaustive-deps -- intentionally re-runs only when these change
  }, [
    activeEmployee,
    visitedEmployeeIds,
    selectedTemplateKeys,
    roster,
    employeesQuery.isSuccess,
    createError,
    createEmployeeAsync,
  ]);

  /** Explicit user action to retry the role `createError` latched — re-arms
   * both guards so the effect above is allowed to attempt it again. */
  const retryCreate = () => {
    creatingRef.current = false;
    setCreateError(null);
  };

  const template = activeEmployee ? templateForRole(activeEmployee.role) : null;

  const {
    register,
    handleSubmit,
    formState: { errors: formErrors },
  } = useForm<EmployeeConfigFormValues>({
    resolver: zodResolver(employeeConfigSchema),
    values: activeEmployee
      ? { name: activeEmployee.name, persona: activeEmployee.persona ?? '', language: activeEmployee.language ?? 'English' }
      : undefined,
  });

  if (!activeEmployee || !template) {
    // Genuinely loading the roster (cold cache / first render after the auth
    // gate resolves) — not creating anything yet, so don't claim we are.
    if (!employeesQuery.isSuccess) {
      if (employeesQuery.isError) {
        return (
          <FlowShell heading="Configure Your AI Employees">
            <p className="text-sm text-red-400">
              Couldn't load your AI Employees. {employeesQuery.error?.message ?? 'Please try again.'}
            </p>
            <StepFooter onBack={prevStep} onContinue={() => void employeesQuery.refetch()} continueLabel="Retry" />
          </FlowShell>
        );
      }
      return (
        <FlowShell heading="Configure Your AI Employees">
          <p className="text-sm text-fg-muted">Loading your AI Employees…</p>
        </FlowShell>
      );
    }
    // Roster loaded fine, but creating the next employee failed — a dead end
    // otherwise, since nothing else renders in this branch. Give the user a
    // way out and an explicit way to retry (see `retryCreate` above).
    if (createError) {
      return (
        <FlowShell heading="Configure Your AI Employees">
          <p className="text-sm text-red-400">{createError.message}</p>
          <StepFooter onBack={prevStep} onContinue={retryCreate} continueLabel="Try again" />
        </FlowShell>
      );
    }
    // Live-discovered dead end: with an empty `selectedTemplateKeys` (not
    // reachable via normal navigation — Select Employees blocks a 0-role
    // continue — but reachable if the wizard's persisted sessionStorage state
    // ever desyncs, e.g. cleared/corrupted between tabs), the create-effect
    // above has nothing to do and never runs again, so this screen used to
    // render its perpetual "Setting up…" loading message with zero buttons —
    // no Back, no Continue, no way out short of leaving the page entirely.
    if (selectedTemplateKeys.length === 0) {
      return (
        <FlowShell heading="Configure Your AI Employees">
          <p className="text-sm text-fg-muted">No AI Employees are selected yet.</p>
          <StepFooter onBack={() => goToStep('selectEmployees')} onContinue={() => goToStep('selectEmployees')} continueLabel="Choose employees" />
        </FlowShell>
      );
    }
    return (
      <FlowShell heading="Configure Your AI Employees">
        <p className="text-sm text-fg-muted">Setting up your next AI Employee…</p>
      </FlowShell>
    );
  }

  /** Best-effort autosave — used on blur so unsaved edits survive switching
   * to another employee in the roster or jumping into a sub-step, without a
   * PATCH firing on every keystroke. Silently no-ops on invalid input;
   * "Next Employee" is the path that surfaces a real validation error. */
  const saveBasics = handleSubmit((values) => {
    updateEmployee.mutate({ id: activeEmployee.id, data: values });
  });

  const nextIncomplete = roster.find((e) => !visitedEmployeeIds.includes(e.id) && e.id !== activeEmployee.id);
  // Same count-aware check as the create-effect above — a duplicated role
  // (e.g. 2 Sales selected, 1 created so far) must still read as "more to
  // create" here, not just "does at least one exist."
  const moreRolesToCreate = selectedTemplateKeys.some(
    (key) => roster.filter((e) => e.role === key).length < selectedTemplateKeys.filter((k) => k === key).length,
  );

  const onNextEmployee = handleSubmit(
    (values) => {
      setActionError(null);
      updateEmployee.mutate(
        { id: activeEmployee.id, data: values },
        {
          onSuccess: () => {
            markVisited(activeEmployee.id);
            if (nextIncomplete) {
              setActiveEmployee(nextIncomplete.id);
            } else if (moreRolesToCreate) {
              // More selected roles still need creating — clearing the active
              // employee re-triggers the create-effect above for the next one.
              setActiveEmployee(null);
            } else {
              goToStep('review');
            }
          },
          onError: (err) => setActionError(err.message || 'Could not save this employee.'),
        },
      );
    },
    () => setErrors({ configure: 'Fix the highlighted field before continuing.' }),
  );

  const subSteps: { step: FlowStep; icon: typeof Zap; title: string; hint: string }[] = [
    { step: 'skills', icon: Zap, title: 'Skills & Capabilities', hint: 'Choose what this employee can do' },
    { step: 'connections', icon: Link2, title: 'Tools & Connections', hint: 'Connect the accounts it needs' },
    { step: 'knowledge', icon: BookOpen, title: 'Knowledge', hint: 'Add documents it should know' },
    { step: 'workflows', icon: Workflow, title: 'Workflows', hint: 'Pick the automations to turn on' },
  ];

  return (
    <FlowShell
      heading="Configure Your AI Employees"
      subtitle={`You selected ${selectedTemplateKeys.length} AI employee${selectedTemplateKeys.length === 1 ? '' : 's'}. Let's set them up one by one.`}
      wide
    >
      {actionError && (
        <p className="mb-4 rounded-lg border border-red-500/30 bg-red-500/10 px-3 py-2 text-sm text-red-400">
          {actionError}
        </p>
      )}
      <div className="grid gap-6 lg:grid-cols-[280px_1fr]">
        <div>
          <p className="mb-2 text-xs font-semibold uppercase tracking-wide text-fg-muted">
            Your AI Employees ({roster.length})
          </p>
          <div className="space-y-2">
            {roster.map((e, i) => {
              const t = templateForRole(e.role);
              const isActive = e.id === activeEmployee.id;
              const done = visitedEmployeeIds.includes(e.id);
              return (
                <button
                  key={e.id}
                  type="button"
                  onClick={() => setActiveEmployee(e.id)}
                  className={`flex w-full items-center gap-3 rounded-xl border px-3 py-2.5 text-left transition-colors ${
                    isActive
                      ? 'border-violet-secondary/60 bg-violet/[0.1]'
                      : 'border-white/[0.08] bg-white/[0.02] hover:border-white/[0.16]'
                  }`}
                >
                  <EmployeeAvatar template={t} size="sm" />
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-sm font-medium text-white">
                      {i + 1}. {e.name || t.name}
                    </span>
                    <span className="block truncate text-xs text-fg-muted">{t.name}</span>
                  </span>
                  <EmployeeStatusPill done={done} isActive={isActive} />
                </button>
              );
            })}
          </div>
        </div>

        <div className="space-y-5">
          <div className="rounded-2xl border border-white/[0.08] bg-white/[0.02] p-5">
            <div className="mb-4 flex items-center gap-3">
              <EmployeeAvatar template={template} />
              <div>
                <p className="text-base font-semibold text-white">{activeEmployee.name || template.name}</p>
                <p className="text-sm text-fg-muted">{template.description}</p>
              </div>
            </div>

            <div className="space-y-4">
              <div>
                <IconField id="emp-name" label="Employee name" icon={<User className="h-[18px] w-[18px]" />}>
                  <input
                    id="emp-name"
                    className="field-modern field-with-icon"
                    placeholder={`e.g. Emma (${activeEmployee.role})`}
                    aria-invalid={Boolean(formErrors.name)}
                    {...register('name', { onBlur: () => void saveBasics() })}
                  />
                </IconField>
                {formErrors.name && <p className="mt-1.5 text-[13px] text-red-400">{formErrors.name.message}</p>}
              </div>

              <div>
                <label className="mb-1.5 block text-sm font-medium text-zinc-300">Persona</label>
                <textarea
                  className="field-modern min-h-[70px] resize-none"
                  placeholder="Friendly, persuasive, results-driven…"
                  {...register('persona', { onBlur: () => void saveBasics() })}
                />
                {formErrors.persona && <p className="mt-1.5 text-[13px] text-red-400">{formErrors.persona.message}</p>}
              </div>

              <IconField id="emp-language" label="Language" icon={<Globe className="h-[18px] w-[18px]" />}>
                <select
                  id="emp-language"
                  className="field-modern field-with-icon"
                  {...register('language', { onChange: () => void saveBasics() })}
                >
                  {LANGUAGES.map((l) => (
                    <option key={l} value={l}>
                      {l}
                    </option>
                  ))}
                </select>
              </IconField>
            </div>
            {errors.configure && <p className="mt-3 text-[13px] text-red-400">{errors.configure}</p>}
          </div>

          <div className="space-y-2">
            {subSteps.map(({ step, icon: Icon, title, hint }) => (
              <button
                key={step}
                type="button"
                onClick={() => goToStep(step)}
                className="flex w-full items-center gap-3 rounded-xl border border-white/[0.08] bg-white/[0.02] px-4 py-3.5 text-left transition-colors hover:border-white/[0.16] hover:bg-white/[0.04]"
              >
                <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-white/[0.06] text-violet-secondary">
                  <Icon className="h-4 w-4" />
                </span>
                <span className="min-w-0 flex-1">
                  <span className="block text-sm font-medium text-white">{title}</span>
                  <span className="block text-xs text-fg-muted">{hint}</span>
                </span>
                <span className="flex shrink-0 items-center gap-1 text-xs font-medium text-violet-bright">
                  Set up <ChevronRight className="h-3.5 w-3.5" />
                </span>
              </button>
            ))}
          </div>
        </div>
      </div>

      <StepFooter
        onBack={prevStep}
        onContinue={onNextEmployee}
        continueLabel={nextIncomplete || moreRolesToCreate ? 'Next Employee →' : 'Continue to Review →'}
        continueDisabled={updateEmployee.isPending}
        extra={
          <button
            type="button"
            onClick={() => goToStep('review')}
            className="text-sm text-fg-muted underline hover:text-zinc-300"
          >
            Skip for now
          </button>
        }
      />
    </FlowShell>
  );
}
