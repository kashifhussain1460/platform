'use client';

import type { ReactNode } from 'react';
import { Check, ChevronDown, HelpCircle, Moon, Sun } from 'lucide-react';
import { FLOW_STEPS, STEP_LABELS } from '../types';
import { useOnboardingWizardStore } from '../wizardStore';
import { BrandPanel } from './BrandPanel';

/** The 12-item tracker, 1:1 with the real `FLOW_STEPS` — no invented
 * milestone that doesn't correspond to an actual screen. */
function StepTracker() {
  const step = useOnboardingWizardStore((s) => s.step);
  const currentIdx = FLOW_STEPS.indexOf(step);

  return (
    <div
      className="scrollbar-none flex min-w-0 flex-1 items-center gap-2 overflow-x-auto"
      role="group"
      aria-label={`Step ${currentIdx + 1} of ${FLOW_STEPS.length}`}
    >
      {FLOW_STEPS.map((step, i) => {
        const done = i < currentIdx;
        const active = i === currentIdx;
        return (
          <div key={step} className="flex shrink-0 items-center gap-2">
            <div className="flex flex-col items-center gap-1">
              <span
                aria-current={active ? 'step' : undefined}
                className={`flex h-8 w-8 items-center justify-center rounded-full text-xs font-semibold transition-colors ${
                  done || active
                    ? 'bg-[linear-gradient(135deg,#6a30ec_0%,#5216dd_100%)] text-white shadow-[0_0_18px_-4px_rgba(91,33,230,0.85)]'
                    : 'bg-white/[0.06] text-fg-muted'
                }`}
              >
                {done ? <Check className="h-3.5 w-3.5" /> : i + 1}
              </span>
              <span className={`whitespace-nowrap text-[10px] font-medium ${active ? 'text-white' : 'text-fg-muted'}`}>
                {STEP_LABELS[step]}
              </span>
            </div>
            {i < FLOW_STEPS.length - 1 && <span className="mb-4 h-px w-6 shrink-0 bg-white/[0.12] sm:w-8" />}
          </div>
        );
      })}
    </div>
  );
}

function TopBar({ companyName }: { companyName: string }) {
  const initials = companyName
    .split(/\s+/)
    .map((w) => w[0])
    .filter(Boolean)
    .slice(0, 2)
    .join('')
    .toUpperCase();

  return (
    <header className="flex items-center justify-between gap-4 border-b border-white/[0.06] px-4 py-4 sm:px-8">
      <StepTracker />
      <div className="flex shrink-0 items-center gap-3">
        <button
          type="button"
          className="flex items-center gap-2 rounded-full border border-white/[0.1] bg-white/[0.03] py-1.5 pl-1.5 pr-3 text-sm text-white"
        >
          <span className="flex h-6 w-6 items-center justify-center rounded-full bg-violet/25 text-[11px] font-semibold text-violet-bright">
            {initials || 'AS'}
          </span>
          <span className="max-w-[140px] truncate">{companyName}</span>
          <ChevronDown className="h-3.5 w-3.5 text-fg-muted" />
        </button>
        <span className="flex items-center gap-1 rounded-full border border-white/[0.1] bg-white/[0.03] p-1">
          <span className="flex h-6 w-6 items-center justify-center rounded-full bg-white/[0.08] text-white">
            <Sun className="h-3.5 w-3.5" />
          </span>
          <span className="flex h-6 w-6 items-center justify-center rounded-full text-fg-muted">
            <Moon className="h-3.5 w-3.5" />
          </span>
        </span>
      </div>
    </header>
  );
}

export function FlowShell({
  heading,
  subtitle,
  children,
  wide = false,
}: {
  heading?: ReactNode;
  subtitle?: ReactNode;
  children: ReactNode;
  /** Steps with card grids (employees, skills, review) need more than a form column. */
  wide?: boolean;
}) {
  const step = useOnboardingWizardStore((s) => s.step);
  // TODO(Task 5): replace with the real company name from useCurrentCompany().
  const companyName = 'Your company';
  const stepIdx = FLOW_STEPS.indexOf(step);

  return (
    <main className="font-marketing flex min-h-screen flex-col bg-[#02030a] lg:h-screen lg:flex-row lg:overflow-hidden">
      <BrandPanel step={step} />

      <div className="flex flex-1 flex-col lg:h-full lg:overflow-y-auto">
        <TopBar companyName={companyName} />

        <div className="mx-auto w-full flex-1 px-4 py-8 sm:px-8" style={{ maxWidth: wide ? '1120px' : '640px' }}>
          {heading && (
            <p className="text-xs font-semibold uppercase tracking-[0.14em] text-violet-secondary">
              Step {stepIdx + 1} of {FLOW_STEPS.length}
            </p>
          )}
          {heading && (
            <h1 className="mt-2 text-[28px] font-bold leading-[1.15] tracking-tight text-white sm:text-[32px]">
              {heading}
            </h1>
          )}
          {subtitle && <p className="mt-2 text-[15px] leading-relaxed text-fg-muted">{subtitle}</p>}
          <div className={heading ? 'mt-7' : ''}>{children}</div>

          <div className="mt-10 flex justify-end">
            <button type="button" className="flex items-center gap-1.5 text-xs text-fg-muted hover:text-zinc-300">
              Need help? <HelpCircle className="h-3.5 w-3.5" />
            </button>
          </div>
        </div>
      </div>
    </main>
  );
}
