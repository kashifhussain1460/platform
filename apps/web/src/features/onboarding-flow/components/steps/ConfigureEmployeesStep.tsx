'use client';

import { useEffect, useRef } from 'react';
import { zodResolver } from '@hookform/resolvers/zod';
import { useForm } from 'react-hook-form';
import { Globe, Link2, User, Workflow, BookOpen, Zap, ChevronRight } from 'lucide-react';
import type { AiEmployeeDto } from '@vaep/types';
import { IconField } from '@/components/onboarding/fields';
import { useCreateEmployee, useEmployees, useUpdateEmployee } from '@/features/employees/hooks';
import { templateForRole, EMPLOYEE_TEMPLATES } from '../../mockData';
import { useOnboardingWizardStore } from '../../wizardStore';
import { employeeConfigSchema, type EmployeeConfigFormValues } from '../../employeeConfigSchema';
import type { FlowStep } from '../../types';
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
  const activeEmployeeId = useOnboardingWizardStore((s) => s.activeEmployeeId);
  const setActiveEmployee = useOnboardingWizardStore((s) => s.setActiveEmployee);
  const pushEmployeeId = useOnboardingWizardStore((s) => s.pushEmployeeId);
  const markVisited = useOnboardingWizardStore((s) => s.markVisited);
  const visitedEmployeeIds = useOnboardingWizardStore((s) => s.visitedEmployeeIds);
  const goToStep = useOnboardingWizardStore((s) => s.goToStep);
  const prevStep = useOnboardingWizardStore((s) => s.prevStep);
  const setErrors = useOnboardingWizardStore((s) => s.setErrors);
  const errors = useOnboardingWizardStore((s) => s.errors);

  const { data: employees = [] } = useEmployees();
  const createEmployee = useCreateEmployee();
  const updateEmployee = useUpdateEmployee();

  const roster = employeeOrder
    .map((id) => employees.find((e) => e.id === id))
    .filter((e): e is AiEmployeeDto => Boolean(e));
  const activeEmployee = roster.find((e) => e.id === activeEmployeeId) ?? null;

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

  // Materialize the next selected-but-not-yet-created role as a real employee.
  useEffect(() => {
    if (activeEmployee) {
      creatingRef.current = false;
      return;
    }
    if (creatingRef.current || createEmployee.isPending) return;
    const nextKey = selectedTemplateKeys.find((key) => !roster.some((e) => e.role === key));
    if (!nextKey) return;
    const template = EMPLOYEE_TEMPLATES.find((t) => t.key === nextKey);
    if (!template) return;
    creatingRef.current = true;
    createEmployee.mutate(
      { name: template.name, role: nextKey as AiEmployeeDto['role'], persona: template.defaultPersona },
      {
        onSuccess: (created) => {
          pushEmployeeId(created.id);
          setActiveEmployee(created.id);
        },
        onError: () => {
          // Allow the next render to retry rather than getting stuck forever.
          creatingRef.current = false;
          setErrors({ configure: 'Could not create this employee. Please try again.' });
        },
      },
    );
    // eslint-disable-next-line react-hooks/exhaustive-deps -- intentionally re-runs only when these change
  }, [activeEmployee, selectedTemplateKeys, roster, createEmployee.isPending]);

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
    return (
      <FlowShell heading="Configure Your AI Employees">
        <p className="text-sm text-fg-muted">Setting up your first employee…</p>
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
  const moreRolesToCreate = selectedTemplateKeys.some((key) => !roster.some((e) => e.role === key));

  const onNextEmployee = handleSubmit(
    (values) => {
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
