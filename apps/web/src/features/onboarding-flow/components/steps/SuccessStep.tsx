'use client';

import Link from 'next/link';
import { CheckCircle2 } from 'lucide-react';
import { Button } from '@/components/ui/Button';
import { templateFor } from '../../mockData';
import { useOnboardingFlow } from '../../state';
import { FlowShell } from '../FlowShell';

export function SuccessStep() {
  const { state, dispatch, goToStep } = useOnboardingFlow();

  return (
    <FlowShell>
      <div className="flex min-h-[70vh] flex-col items-center justify-center text-center">
        <span className="flex h-16 w-16 items-center justify-center rounded-full bg-status-active/15 text-sl-active">
          <CheckCircle2 className="h-9 w-9" />
        </span>
        <h1 className="mt-6 text-[30px] font-bold text-white">You&apos;re all set!</h1>
        <p className="mt-2 text-[15px] text-fg-muted">Your AI Employees are ready to work.</p>

        <ul className="mt-8 w-full max-w-sm space-y-2">
          {state.employees.map((e) => {
            const template = templateFor(e.templateKey);
            const Icon = template.icon;
            return (
              <li
                key={e.id}
                className="flex items-center justify-between gap-3 rounded-xl border border-white/[0.08] bg-white/[0.02] px-4 py-3"
              >
                <span className="flex items-center gap-3">
                  <span className={`flex h-8 w-8 items-center justify-center rounded-lg ${template.colorClass}`}>
                    <Icon className="h-4 w-4" />
                  </span>
                  <span className="text-sm font-medium text-white">
                    {e.name || template.name} ({template.name})
                  </span>
                </span>
                <span className="flex items-center gap-1 text-xs font-medium text-sl-active">
                  Ready to work <CheckCircle2 className="h-3.5 w-3.5" />
                </span>
              </li>
            );
          })}
        </ul>

        <div className="mt-8 flex w-full max-w-sm flex-col gap-3">
          {/* Phase 1 preview: no real dashboard/company exists yet, so this
              points at the marketing home rather than /dashboard. Phase 3
              wires this to the real post-onboarding redirect. */}
          <Link href="/" className="w-full">
            <Button variant="violet" size="lg" className="w-full">
              Go to Dashboard →
            </Button>
          </Link>
          <button
            type="button"
            onClick={() => goToStep('selectEmployees')}
            className="rounded-xl border border-white/[0.1] px-5 py-2.5 text-sm font-medium text-zinc-300 hover:border-white/[0.2]"
          >
            Hire Another Employee
          </button>
          <button
            type="button"
            onClick={() => dispatch({ type: 'RESET' })}
            className="text-xs text-fg-muted underline hover:text-zinc-300"
          >
            Restart this preview
          </button>
        </div>
      </div>
    </FlowShell>
  );
}
