'use client';

import { useState } from 'react';
import { X } from 'lucide-react';
import {
  useAssignSkill,
  useCatalog,
  useEmployeeSkills,
  useInstalledSkills,
  useInstallSkill,
  useUnassignSkill,
} from '@/features/skills/hooks';
import type { SkillDefinitionDto } from '@vaep/types';
import { iconForSkill } from '../../skillIcons';
import { templateForRole } from '../../mockData';
import { useActiveEmployee } from '../../useActiveEmployee';
import { useOnboardingWizardStore } from '../../wizardStore';
import { CardCheckbox } from '../CardCheckbox';
import { EmployeeContextHeader } from '../EmployeeContextHeader';
import { FlowShell } from '../FlowShell';
import { StepFooter } from '../StepFooter';

export function SkillsStep() {
  const goToStep = useOnboardingWizardStore((s) => s.goToStep);
  const { employee } = useActiveEmployee();
  const [category, setCategory] = useState<string>('All');

  const { data: catalog = [] } = useCatalog();
  // Company-wide installed skills — the only place an InstalledSkillDto's
  // `skillKey` lives. `useEmployeeSkills` only returns EmployeeSkillDto rows
  // (id/installedSkillId/employeeId), so this is required to resolve which
  // *skill key* each assignment actually points at.
  const { data: installedSkills = [] } = useInstalledSkills();
  const { data: employeeSkills = [] } = useEmployeeSkills(employee?.id ?? '');
  const installSkill = useInstallSkill();
  const assignSkill = useAssignSkill(employee?.id ?? '');
  const unassignSkill = useUnassignSkill(employee?.id ?? '');

  if (!employee) {
    return (
      <FlowShell heading="Skills & Capabilities">
        <p className="text-sm text-fg-muted">No AI Employee selected yet.</p>
        <StepFooter onBack={() => goToStep('configureEmployees')} onContinue={() => goToStep('configureEmployees')} />
      </FlowShell>
    );
  }

  const template = templateForRole(employee.role);

  // The join: InstalledSkillDto.id === EmployeeSkillDto.installedSkillId,
  // and InstalledSkillDto.skillKey is the catalog key. Build id -> skillKey
  // once, then map this employee's assignments through it. Both the
  // "Recommended" section and the "Selected Skills" sidebar read this same
  // Set so they can never disagree about what's assigned.
  const installedSkillKeyById = new Map(installedSkills.map((s) => [s.id, s.skillKey]));
  const assignedSkillKeys = new Set(
    employeeSkills
      .map((es) => installedSkillKeyById.get(es.installedSkillId))
      .filter((key): key is string => Boolean(key)),
  );

  const categories = Array.from(new Set(catalog.map((s) => s.category)));
  const recommended = catalog.filter((s) => template.suggestedSkillKeys.includes(s.key));
  const visible = category === 'All' ? catalog : catalog.filter((s) => s.category === category);

  const toggle = (skill: SkillDefinitionDto) => {
    if (assignedSkillKeys.has(skill.key)) {
      // Unassign: find THIS employee's assignment row for this skill key (via
      // the same id -> skillKey join) and delete that specific assignment —
      // the InstalledSkill itself (and any other employee's assignment to it)
      // is left alone.
      const assignment = employeeSkills.find(
        (es) => installedSkillKeyById.get(es.installedSkillId) === skill.key,
      );
      if (assignment) {
        unassignSkill.mutate({ installedSkillId: assignment.installedSkillId });
      }
      return;
    }

    // Not assigned to this employee yet. If the company has already
    // installed this skillKey (by this or another employee), just reuse that
    // InstalledSkill and assign it — only install when no InstalledSkill for
    // this skillKey exists anywhere in the company yet (mirrors
    // employee-skills.controller.ts's install-then-assign flow).
    const existingInstalled = installedSkills.find((s) => s.skillKey === skill.key);
    if (existingInstalled) {
      assignSkill.mutate({ installedSkillId: existingInstalled.id });
      return;
    }

    installSkill.mutate(
      { skillKey: skill.key },
      {
        onSuccess: (installed) => {
          assignSkill.mutate({ installedSkillId: installed.id });
        },
      },
    );
  };

  const backToHub = () => goToStep('configureEmployees');

  return (
    <FlowShell
      heading={`Select Skills for ${employee.name}`}
      subtitle="Choose the tools and capabilities this employee can use. We'll recommend the best skills based on their role."
      wide
    >
      <EmployeeContextHeader employee={employee} />

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
                  const checked = assignedSkillKeys.has(skill.key);
                  const Icon = iconForSkill(skill.key);
                  return (
                    <button
                      key={skill.key}
                      type="button"
                      onClick={() => toggle(skill)}
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
            {['All', ...categories].map((c) => (
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
                const checked = assignedSkillKeys.has(skill.key);
                const Icon = iconForSkill(skill.key);
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
                      onChange={() => toggle(skill)}
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
              Selected Skills ({assignedSkillKeys.size})
            </p>
            {assignedSkillKeys.size > 0 && (
              <button
                type="button"
                onClick={() => {
                  Array.from(assignedSkillKeys).forEach((key) => {
                    const skill = catalog.find((s) => s.key === key);
                    if (skill) toggle(skill);
                  });
                }}
                className="text-xs text-fg-muted underline hover:text-zinc-300"
              >
                Clear All
              </button>
            )}
          </div>
          {assignedSkillKeys.size === 0 ? (
            <p className="text-xs text-fg-muted">No skills selected yet.</p>
          ) : (
            <ul className="space-y-2">
              {Array.from(assignedSkillKeys).map((key) => {
                const skill = catalog.find((s) => s.key === key);
                if (!skill) return null;
                const Icon = iconForSkill(skill.key);
                return (
                  <li key={key} className="flex items-center gap-2.5 rounded-lg bg-white/[0.03] px-2.5 py-2">
                    <span className="flex h-6 w-6 shrink-0 items-center justify-center overflow-hidden rounded p-1">
                      <Icon className="h-full w-full" />
                    </span>
                    <span className="min-w-0 flex-1 truncate text-sm text-white">{skill.name}</span>
                    <button
                      type="button"
                      aria-label={`Remove ${skill.name}`}
                      onClick={() => toggle(skill)}
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
