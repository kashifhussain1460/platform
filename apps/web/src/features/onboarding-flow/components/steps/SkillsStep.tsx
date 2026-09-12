'use client';

import { useState } from 'react';
import { X } from 'lucide-react';
import { SKILLS, SKILL_CATEGORIES, templateFor } from '../../mockData';
import { useOnboardingFlow } from '../../state';
import { CardCheckbox } from '../CardCheckbox';
import { EmployeeContextHeader } from '../EmployeeContextHeader';
import { FlowShell } from '../FlowShell';
import { StepFooter } from '../StepFooter';

export function SkillsStep() {
  const { activeEmployee, dispatch, goToStep, prevStep } = useOnboardingFlow();
  const [category, setCategory] = useState<'All' | (typeof SKILL_CATEGORIES)[number]>('All');

  if (!activeEmployee) {
    return (
      <FlowShell heading="Skills & Capabilities">
        <p className="text-sm text-app-ink-3">No AI Employees selected yet.</p>
        <StepFooter onBack={prevStep} onContinue={() => goToStep('configureEmployees')} />
      </FlowShell>
    );
  }

  const template = templateFor(activeEmployee.templateKey);
  const recommended = SKILLS.filter((s) => template.suggestedSkillKeys.includes(s.key));
  const visible = category === 'All' ? SKILLS : SKILLS.filter((s) => s.category === category);
  const backToHub = () => goToStep('configureEmployees');

  const toggle = (skillKey: string) =>
    dispatch({ type: 'TOGGLE_EMPLOYEE_SKILL', employeeId: activeEmployee.id, skillKey });

  return (
    <FlowShell
      heading={`Select Skills for ${activeEmployee.name || template.name}`}
      subtitle="Choose the tools and capabilities this employee can use. We'll recommend the best skills based on their role."
      wide
    >
      <EmployeeContextHeader employee={activeEmployee} />

      <div className="grid gap-6 lg:grid-cols-[1fr_280px]">
        <div>
          {recommended.length > 0 && (
            <div className="mb-6">
              <p className="mb-2 text-sm font-semibold text-white">
                Recommended for {template.name}
              </p>
              <p className="mb-3 text-xs text-fg-muted">Based on their role and goals</p>
              <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-4">
                {recommended.map((skill) => {
                  const checked = activeEmployee.skillKeys.includes(skill.key);
                  const Icon = skill.icon;
                  return (
                    <button
                      key={skill.key}
                      type="button"
                      onClick={() => toggle(skill.key)}
                      className={`flex flex-col items-start gap-2 rounded-xl border p-3 text-left transition-colors ${
                        checked
                          ? 'border-violet-secondary/60 bg-violet/[0.1]'
                          : 'border-white/[0.08] bg-white/[0.02] hover:border-white/[0.16]'
                      }`}
                    >
                      <span className="flex w-full items-center justify-between">
                        <span className="flex h-8 w-8 items-center justify-center overflow-hidden rounded-lg bg-white/[0.06] p-1.5">
                          <Icon className="h-full w-full" />
                        </span>
                        <CardCheckbox checked={checked} />
                      </span>
                      <span className="text-sm font-medium text-white">{skill.name}</span>
                      <span className="text-xs text-fg-muted">{skill.description}</span>
                    </button>
                  );
                })}
              </div>
            </div>
          )}

          <p className="mb-2 text-sm font-semibold text-white">All Skills</p>
          <p className="mb-3 text-xs text-fg-muted">Browse and select from all available skills</p>
          <div className="flex flex-wrap gap-2">
            {(['All', ...SKILL_CATEGORIES] as const).map((c) => (
              <button
                key={c}
                type="button"
                onClick={() => setCategory(c)}
                className={`rounded-full px-3 py-1.5 text-xs font-medium transition-colors ${
                  category === c
                    ? 'bg-violet text-white'
                    : 'border border-white/[0.1] text-zinc-300 hover:text-white'
                }`}
              >
                {c}
              </button>
            ))}
          </div>

          <div className="mt-4 grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
            {visible.length === 0 ? (
              <p className="col-span-full rounded-xl border border-dashed border-white/[0.1] px-4 py-6 text-center text-sm text-fg-muted">
                No skills available in this category yet.
              </p>
            ) : (
              visible.map((skill) => {
                const checked = activeEmployee.skillKeys.includes(skill.key);
                const Icon = skill.icon;
                return (
                  <label
                    key={skill.key}
                    className={`flex cursor-pointer items-center gap-3 rounded-xl border px-3.5 py-3 transition-colors ${
                      checked
                        ? 'border-violet-secondary/60 bg-violet/[0.08]'
                        : 'border-white/[0.08] bg-white/[0.02] hover:border-white/[0.16]'
                    }`}
                  >
                    <input
                      type="checkbox"
                      checked={checked}
                      onChange={() => toggle(skill.key)}
                      className="h-4 w-4 shrink-0 rounded-md border-white/20 bg-white/5 accent-[#6a30ec]"
                    />
                    <span className="flex h-8 w-8 shrink-0 items-center justify-center overflow-hidden rounded-lg bg-white/[0.06] p-1.5">
                      <Icon className="h-full w-full" />
                    </span>
                    <span className="min-w-0 flex-1">
                      <span className="block text-sm font-medium text-white">{skill.name}</span>
                      <span className="block truncate text-xs text-fg-muted">{skill.description}</span>
                    </span>
                  </label>
                );
              })
            )}
          </div>
        </div>

        <div className="rounded-2xl border border-white/[0.08] bg-white/[0.02] p-4 lg:h-fit">
          <div className="mb-3 flex items-center justify-between">
            <p className="text-sm font-semibold text-white">
              Selected Skills ({activeEmployee.skillKeys.length})
            </p>
            {activeEmployee.skillKeys.length > 0 && (
              <button
                type="button"
                onClick={() => activeEmployee.skillKeys.forEach((k) => toggle(k))}
                className="text-xs text-fg-muted underline hover:text-zinc-300"
              >
                Clear All
              </button>
            )}
          </div>
          {activeEmployee.skillKeys.length === 0 ? (
            <p className="text-xs text-fg-muted">No skills selected yet.</p>
          ) : (
            <ul className="space-y-2">
              {activeEmployee.skillKeys.map((key) => {
                const skill = SKILLS.find((s) => s.key === key);
                if (!skill) return null;
                const Icon = skill.icon;
                return (
                  <li key={key} className="flex items-center gap-2.5 rounded-lg bg-white/[0.03] px-2.5 py-2">
                    <span className="flex h-6 w-6 shrink-0 items-center justify-center overflow-hidden rounded p-1">
                      <Icon className="h-full w-full" />
                    </span>
                    <span className="min-w-0 flex-1 truncate text-sm text-white">{skill.name}</span>
                    <button
                      type="button"
                      aria-label={`Remove ${skill.name}`}
                      onClick={() => toggle(key)}
                      className="shrink-0 text-fg-muted hover:text-white"
                    >
                      <X className="h-3.5 w-3.5" />
                    </button>
                  </li>
                );
              })}
            </ul>
          )}
        </div>
      </div>

      <StepFooter onBack={backToHub} onContinue={backToHub} continueLabel="Save & Back to Hub →" />
    </FlowShell>
  );
}
