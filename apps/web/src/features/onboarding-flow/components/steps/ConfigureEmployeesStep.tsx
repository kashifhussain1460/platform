'use client';

import { Globe, Link2, User, Workflow, BookOpen, Zap, ChevronRight } from 'lucide-react';
import { IconField } from '@/components/onboarding/fields';
import { skillFor, templateFor } from '../../mockData';
import { nextIncompleteEmployee, useOnboardingFlow } from '../../state';
import type { DraftEmployee, FlowStep } from '../../types';
import { EmployeeAvatar } from '../EmployeeAvatar';
import { FlowShell } from '../FlowShell';
import { StepFooter } from '../StepFooter';

const LANGUAGES = ['English', 'Spanish', 'French', 'German', 'Hindi', 'Portuguese'];

function EmployeeStatusPill({ employee, isActive }: { employee: DraftEmployee; isActive: boolean }) {
  if (employee.setupComplete) {
    return <span className="shrink-0 rounded-full bg-emerald-500/15 px-2 py-0.5 text-[11px] font-medium text-emerald-400">Done</span>;
  }
  if (isActive) {
    return <span className="shrink-0 rounded-full bg-violet/20 px-2 py-0.5 text-[11px] font-medium text-violet-bright">In Progress</span>;
  }
  return <span className="shrink-0 rounded-full bg-white/[0.06] px-2 py-0.5 text-[11px] font-medium text-fg-muted">Not Started</span>;
}

export function ConfigureEmployeesStep() {
  const { state, dispatch, activeEmployee, goToStep, prevStep, setErrors } = useOnboardingFlow();

  if (!activeEmployee) {
    return (
      <FlowShell heading="Configure your AI Employees">
        <p className="text-sm text-app-ink-3">No AI Employees selected yet.</p>
        <StepFooter onBack={prevStep} onContinue={prevStep} continueLabel="Back to selection" />
      </FlowShell>
    );
  }

  const template = templateFor(activeEmployee.templateKey);
  const next = nextIncompleteEmployee(state.employees, activeEmployee.id);

  const onNextEmployee = () => {
    if (!activeEmployee.name.trim()) {
      setErrors({ configure: `Give ${activeEmployee.role} a name before continuing.` });
      return;
    }
    dispatch({ type: 'SET_EMPLOYEE_SETUP_COMPLETE', id: activeEmployee.id, complete: true });
    if (next) {
      dispatch({ type: 'SET_ACTIVE_EMPLOYEE', id: next.id });
    } else {
      goToStep('review');
    }
  };

  const subSteps: { step: FlowStep; icon: typeof Zap; title: string; hint: string }[] = [
    {
      step: 'skills',
      icon: Zap,
      title: 'Skills & Capabilities',
      hint:
        activeEmployee.skillKeys.length > 0
          ? `${activeEmployee.skillKeys.length} skill${activeEmployee.skillKeys.length === 1 ? '' : 's'} selected`
          : 'No skills selected yet',
    },
    {
      step: 'connections',
      icon: Link2,
      title: 'Tools & Connections',
      hint: (() => {
        const connectable = activeEmployee.skillKeys
          .map((k) => skillFor(k))
          .filter((s): s is NonNullable<typeof s> => Boolean(s?.requiresConnection));
        const connected = connectable.filter((s) => activeEmployee.connections[s.key] === 'connected').length;
        return connectable.length === 0
          ? 'No tools to connect yet'
          : `${connected}/${connectable.length} connected`;
      })(),
    },
    {
      step: 'knowledge',
      icon: BookOpen,
      title: 'Knowledge',
      hint: `${state.knowledgeDocs.filter((d) => d.scope === activeEmployee.id).length} document(s) added`,
    },
    {
      step: 'workflows',
      icon: Workflow,
      title: 'Workflows',
      hint:
        activeEmployee.workflowKeys.length > 0
          ? `${activeEmployee.workflowKeys.length} workflow${activeEmployee.workflowKeys.length === 1 ? '' : 's'} chosen`
          : 'No workflows chosen yet',
    },
  ];

  return (
    <FlowShell
      heading="Configure Your AI Employees"
      subtitle={`You selected ${state.employees.length} AI employee${state.employees.length === 1 ? '' : 's'}. Let's set them up one by one.`}
      wide
    >
      <div className="grid gap-6 lg:grid-cols-[280px_1fr]">
        <div>
          <p className="mb-2 text-xs font-semibold uppercase tracking-wide text-fg-muted">
            Your AI Employees ({state.employees.length})
          </p>
          <div className="space-y-2">
            {state.employees.map((e, i) => {
              const t = templateFor(e.templateKey);
              const isActive = e.id === activeEmployee.id;
              return (
                <button
                  key={e.id}
                  type="button"
                  onClick={() => dispatch({ type: 'SET_ACTIVE_EMPLOYEE', id: e.id })}
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
                  <EmployeeStatusPill employee={e} isActive={isActive} />
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
              <IconField id="emp-name" label="Employee name" icon={<User className="h-[18px] w-[18px]" />}>
                <input
                  id="emp-name"
                  className="field-modern field-with-icon"
                  value={activeEmployee.name}
                  onChange={(e) => {
                    dispatch({ type: 'UPDATE_EMPLOYEE_FIELD', id: activeEmployee.id, field: 'name', value: e.target.value });
                    dispatch({ type: 'CLEAR_ERROR', field: 'configure' });
                  }}
                  placeholder={`e.g. Emma (${activeEmployee.role})`}
                />
              </IconField>

              <div>
                <label className="mb-1.5 block text-sm font-medium text-zinc-300">Persona</label>
                <textarea
                  className="field-modern min-h-[70px] resize-none"
                  value={activeEmployee.persona}
                  onChange={(e) =>
                    dispatch({ type: 'UPDATE_EMPLOYEE_FIELD', id: activeEmployee.id, field: 'persona', value: e.target.value })
                  }
                  placeholder="Friendly, persuasive, results-driven…"
                />
              </div>

              <IconField id="emp-language" label="Language" icon={<Globe className="h-[18px] w-[18px]" />}>
                <select
                  id="emp-language"
                  className="field-modern field-with-icon"
                  value={activeEmployee.language}
                  onChange={(e) =>
                    dispatch({ type: 'UPDATE_EMPLOYEE_FIELD', id: activeEmployee.id, field: 'language', value: e.target.value })
                  }
                >
                  {LANGUAGES.map((l) => (
                    <option key={l} value={l}>{l}</option>
                  ))}
                </select>
              </IconField>
            </div>
            {state.errors.configure && <p className="mt-3 text-[13px] text-red-400">{state.errors.configure}</p>}
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
        continueLabel={next ? 'Next Employee →' : 'Continue to Review →'}
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
