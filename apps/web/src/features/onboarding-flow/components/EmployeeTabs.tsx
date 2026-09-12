'use client';

import { templateFor } from '../mockData';
import { computeReadiness, useOnboardingFlow } from '../state';
import { EmployeeAvatar } from './EmployeeAvatar';

/**
 * Left-column employee list for every per-employee step (Configure, Skills,
 * Connections, Workflows, Review). Skills/Connections/Knowledge/Workflows are
 * NOT company-wide — they belong to one AI Employee — so every one of those
 * screens needs this same "which employee am I configuring" switch, and it
 * has to be the SAME component so switching between those steps doesn't lose
 * track of which employee was selected.
 */
export function EmployeeTabs() {
  const { state, activeEmployee, dispatch } = useOnboardingFlow();

  if (state.employees.length === 0) {
    return (
      <p className="text-sm text-app-ink-3">
        No AI Employees selected yet — go back and choose at least one.
      </p>
    );
  }

  return (
    <div className="flex gap-2 overflow-x-auto pb-1 lg:flex-col lg:overflow-visible lg:pb-0">
      {state.employees.map((e) => {
        const template = templateFor(e.templateKey);
        const readiness = computeReadiness(e);
        const isActive = activeEmployee?.id === e.id;
        return (
          <button
            key={e.id}
            type="button"
            onClick={() => dispatch({ type: 'SET_ACTIVE_EMPLOYEE', id: e.id })}
            className={`flex shrink-0 items-center gap-2.5 rounded-xl border px-3.5 py-2.5 text-left text-sm font-medium transition-colors lg:shrink lg:w-full ${
              isActive
                ? 'border-violet-secondary/60 bg-violet/[0.1] text-white'
                : 'border-white/[0.08] bg-white/[0.02] text-zinc-300 hover:border-white/[0.16]'
            }`}
          >
            <EmployeeAvatar template={template} size="sm" />
            <span className="min-w-0 flex-1 truncate">{e.name || template.name}</span>
            {!readiness.ready && (
              <span
                aria-label="Needs setup"
                className="h-1.5 w-1.5 shrink-0 rounded-full bg-amber-400"
              />
            )}
          </button>
        );
      })}
    </div>
  );
}
