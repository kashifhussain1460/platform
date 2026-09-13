'use client';

import { useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import { AlertTriangle, CheckCircle2 } from 'lucide-react';
import type { NormalizedApiError } from '@/lib/apiClient';
import { Button } from '@/components/ui/Button';
import { useEmployees } from '@/features/employees/hooks';
import { useCompleteOnboarding } from '@/features/onboarding/hooks';
import { templateForRole } from '../../mockData';
import { useOnboardingWizardStore } from '../../wizardStore';
import { FlowShell } from '../FlowShell';

type CompletionPhase = 'pending' | 'success' | 'error';

/**
 * Stamps `company.onboardedAt` via `POST /onboarding/complete` — the only
 * existing mechanism, so this is the correct endpoint even though this
 * wizard already hired every AI Employee individually through
 * `POST /employees` (Task 9's path) rather than through this endpoint's own
 * `employees` array.
 *
 * Payload is deliberately `{ departments: [], employees: [] }`. Traced
 * `OnboardingService.complete()` end to end (apps/api/src/modules/onboarding/
 * onboarding.service.ts): the only early return is the top-of-method
 * "already onboarded" short-circuit; the `onboardedAt` stamp (step 3) runs
 * unconditionally afterwards regardless of whether `dto.employees` or
 * `dto.departments` is empty — there is no gate on either array's length
 * before that write. So an empty roster still gets the flag stamped
 * correctly; no backend change was needed.
 */
export function SuccessStep() {
  const goToStep = useOnboardingWizardStore((s) => s.goToStep);
  const employeeOrder = useOnboardingWizardStore((s) => s.employeeOrder);
  const { data: employees = [] } = useEmployees();
  const completeOnboarding = useCompleteOnboarding();

  // This wizard's own hires, in hire order — same join EmployeeTabs and
  // useActiveEmployee use, so this summary doesn't show a pre-existing
  // tenant employee that was never part of this run.
  const roster = employeeOrder
    .map((id) => employees.find((e) => e.id === id))
    .filter((e): e is NonNullable<typeof e> => Boolean(e));

  // Fire once on mount, tracked via LOCAL state set from the mutateAsync
  // promise's own continuation — deliberately NOT via the mutation's own
  // reactive `isPending`/`isError` (what an earlier version of this file, and
  // a first fix attempt, both did). Confirmed live (real network calls +
  // instrumented tracing, then isolated by toggling next.config.mjs's
  // `reactStrictMode` off/on) that React 18 Strict Mode's dev-only double-
  // invoke of this mount effect does NOT re-render the component between the
  // two invocations, so a primitive guard captured at render time (a `status`
  // string, an `isIdle` boolean) is identical in both invocations and cannot
  // block the second call — only a *ref* (a live binding, not a captured
  // value) can. But a ref-only guard has its own failure mode here: React
  // Query's `useMutation` internally double-subscribes/unsubscribes its
  // `MutationObserver` across that same cycle, and the observer that started
  // the in-flight call can get detached before it resolves — so relying on
  // the OBSERVER's own `isPending`/`onSuccess` to drive this component's
  // render silently drops the resolution, permanently stuck.
  // `mutateAsync`'s returned promise is not affected by that observer
  // detachment — it resolves independently — so pairing a `useRef` guard
  // (prevents a second real network call) with a plain promise `.then()`/
  // `.catch()` writing to local `useState` (decoupled from the observer's
  // subscription lifecycle) fixes both problems at once. Confirmed by
  // reproducing with `reactStrictMode: true` (the repo's real setting):
  // exactly one `POST /onboarding/complete` fires, and the button correctly
  // unsticks once it resolves.
  const [phase, setPhase] = useState<CompletionPhase>('pending');
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const { mutateAsync: completeOnboardingAsync } = completeOnboarding;
  const firedRef = useRef(false);
  useEffect(() => {
    if (firedRef.current) return;
    firedRef.current = true;
    completeOnboardingAsync({ departments: [], employees: [] })
      .then(() => setPhase('success'))
      .catch((err: NormalizedApiError) => {
        setPhase('error');
        setErrorMessage(err?.message ?? null);
      });
    // eslint-disable-next-line react-hooks/exhaustive-deps -- fire once on mount, guarded by firedRef
  }, []);

  const retry = () => {
    setPhase('pending');
    setErrorMessage(null);
    completeOnboardingAsync({ departments: [], employees: [] })
      .then(() => setPhase('success'))
      .catch((err: NormalizedApiError) => {
        setPhase('error');
        setErrorMessage(err?.message ?? null);
      });
  };

  if (phase === 'error') {
    return (
      <FlowShell>
        <div className="flex min-h-[70vh] flex-col items-center justify-center text-center">
          <span className="flex h-16 w-16 items-center justify-center rounded-full bg-red-500/15 text-red-400">
            <AlertTriangle className="h-9 w-9" />
          </span>
          <h1 className="mt-6 text-[30px] font-bold text-white">Almost done</h1>
          <p className="mt-2 max-w-sm text-[15px] text-fg-muted">
            {errorMessage || "Couldn't finish setting up your account."}
          </p>
          <button
            type="button"
            onClick={retry}
            className="mt-6 rounded-xl bg-violet px-5 py-2.5 text-sm font-medium text-white transition-colors hover:bg-violet-hover"
          >
            Try again
          </button>
        </div>
      </FlowShell>
    );
  }

  return (
    <FlowShell>
      <div className="flex min-h-[70vh] flex-col items-center justify-center text-center">
        <span className="flex h-16 w-16 items-center justify-center rounded-full bg-emerald-500/15 text-emerald-400">
          <CheckCircle2 className="h-9 w-9" />
        </span>
        <h1 className="mt-6 text-[30px] font-bold text-white">You&apos;re all set!</h1>
        <p className="mt-2 text-[15px] text-fg-muted">Your AI Employees are ready to work.</p>

        <ul className="mt-8 w-full max-w-sm space-y-2">
          {roster.map((e) => {
            const template = templateForRole(e.role);
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
                <span className="flex items-center gap-1 text-xs font-medium text-emerald-400">
                  Ready to work <CheckCircle2 className="h-3.5 w-3.5" />
                </span>
              </li>
            );
          })}
        </ul>

        <div className="mt-8 flex w-full max-w-sm flex-col gap-3">
          <Link
            href="/dashboard"
            className="w-full"
            onClick={(e) => {
              // Guard against navigating to /dashboard before onboardedAt has
              // actually landed on the session's company — AppLayout's redirect
              // guard reads `company.onboardedAt` from the Zustand store and
              // would otherwise bounce straight back to /onboarding.
              if (phase === 'pending') e.preventDefault();
            }}
          >
            <Button variant="violet" size="lg" className="w-full" disabled={phase === 'pending'}>
              {phase === 'pending' ? 'Finishing up…' : 'Go to Dashboard →'}
            </Button>
          </Link>
          <button
            type="button"
            onClick={() => goToStep('selectEmployees')}
            className="rounded-xl border border-white/[0.1] px-5 py-2.5 text-sm font-medium text-zinc-300 hover:border-white/[0.2]"
          >
            Hire Another Employee
          </button>
        </div>
      </div>
    </FlowShell>
  );
}
