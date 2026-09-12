'use client';

import { useEffect } from 'react';
import Link from 'next/link';
import { AlertTriangle, CheckCircle2 } from 'lucide-react';
import { Button } from '@/components/ui/Button';
import { useEmployees } from '@/features/employees/hooks';
import { useCompleteOnboarding } from '@/features/onboarding/hooks';
import { templateForRole } from '../../mockData';
import { useOnboardingWizardStore } from '../../wizardStore';
import { FlowShell } from '../FlowShell';

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

  // Fire once on mount. Guarded by the mutation's OWN `isIdle` status, not a
  // separate ref — a ref-based guard (`firedRef.current`) reliably prevents a
  // second network call under React 18 Strict Mode's dev-only double-invoke,
  // but does NOT reliably prevent the mutation observer from losing track of
  // the in-flight call's resolution: the first effect invocation fires
  // mutate() and flips the ref, the immediate synthetic cleanup+remount runs
  // the effect again and correctly skips re-firing (ref says "already done"),
  // but the underlying MutationObserver instance is still transitioning
  // between the two invocations, and the in-flight promise's onSuccess/
  // onSettled — and the isPending -> false transition — were observed to
  // never reach this component in dev (confirmed live: network tab shows a
  // real 201, but the button stayed stuck on "Finishing up…" indefinitely).
  // Gating on `isIdle` instead ties the guard to the SAME state object the
  // render reads (`completeOnboarding.status`), so there's no separate ref
  // that can fall out of sync with the observer's actual lifecycle. The
  // backend call is idempotent regardless (a company that is already
  // onboarded short-circuits to its current state instead of re-running).
  const { mutate: fireCompleteOnboarding, isIdle } = completeOnboarding;
  useEffect(() => {
    if (!isIdle) return;
    fireCompleteOnboarding({ departments: [], employees: [] });
    // eslint-disable-next-line react-hooks/exhaustive-deps -- fire once, guarded by isIdle (the mutation's own status), not a ref
  }, [isIdle, fireCompleteOnboarding]);

  if (completeOnboarding.isError) {
    return (
      <FlowShell>
        <div className="flex min-h-[70vh] flex-col items-center justify-center text-center">
          <span className="flex h-16 w-16 items-center justify-center rounded-full bg-red-500/15 text-red-400">
            <AlertTriangle className="h-9 w-9" />
          </span>
          <h1 className="mt-6 text-[30px] font-bold text-white">Almost done</h1>
          <p className="mt-2 max-w-sm text-[15px] text-fg-muted">
            {completeOnboarding.error?.message || "Couldn't finish setting up your account."}
          </p>
          <button
            type="button"
            onClick={() => completeOnboarding.mutate({ departments: [], employees: [] })}
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
              if (completeOnboarding.isPending) e.preventDefault();
            }}
          >
            <Button variant="violet" size="lg" className="w-full" disabled={completeOnboarding.isPending}>
              {completeOnboarding.isPending ? 'Finishing up…' : 'Go to Dashboard →'}
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
