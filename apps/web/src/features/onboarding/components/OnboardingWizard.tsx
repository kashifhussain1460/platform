'use client';

import { useEffect, useMemo, useState } from 'react';
import { useRouter } from 'next/navigation';
import { allowedGoalsForRoles } from '@vaep/types';
import { OnboardingShell } from '@/components/onboarding/OnboardingShell';
import { ToggleCard } from '@/components/onboarding/fields';
import {
  AstronautIllustration,
  LaunchIllustration,
  SkylineIllustration,
} from '@/components/onboarding/illustrations';
import { useSubscription } from '@/features/billing/hooks';
import { COMPANY_SIZES, INDUSTRIES } from '../labels';
import {
  useCompleteOnboarding,
  useOnboardingStatus,
  useSaveOnboardingAiEmployees,
  useSaveOnboardingCompany,
  useSaveOnboardingGoals,
} from '../hooks';

const ROLE_META: Record<string, { title: string; blurb: string }> = {
  HR: {
    title: 'HR Employee',
    blurb: 'Recruitment, candidate screening, interview scheduling, onboarding, reviews & offboarding.',
  },
  MARKETING: {
    title: 'Marketing Employee',
    blurb: 'Content, social media, campaigns, email marketing, SEO, lead gen & analytics.',
  },
};
const ROLES = ['HR', 'MARKETING'] as const;

const labelClass = 'mb-1.5 block text-sm font-medium text-zinc-300';
const backBtn =
  'rounded-xl border border-white/[0.12] bg-white/[0.03] px-5 py-2.5 text-sm font-medium text-zinc-300 transition-colors hover:border-white/25 disabled:opacity-50';
const primaryBtn =
  'inline-flex items-center justify-center rounded-xl bg-[linear-gradient(135deg,#6a30ec_0%,#5216dd_100%)] px-8 py-3 text-sm font-semibold text-white transition-all hover:-translate-y-0.5 disabled:cursor-not-allowed disabled:opacity-60';

/**
 * Minimal 3-step onboarding: Company → Choose AI Employee(s) → Business goals.
 * Every step persists server-side (PATCH /onboarding/*), so it resumes exactly
 * after a refresh / logout / device change. Finishing provisions the selected
 * AI Employees and hands off to AI Assist — or to the dashboard when the plan
 * does not include Assist (see `finish`).
 */
export function OnboardingWizard() {
  const router = useRouter();
  // Read the plan so the final step can route somewhere the user can actually use.
  const { data: subscription } = useSubscription();
  const { data: status } = useOnboardingStatus();
  const saveCompany = useSaveOnboardingCompany();
  const saveRoles = useSaveOnboardingAiEmployees();
  const saveGoals = useSaveOnboardingGoals();
  const complete = useCompleteOnboarding();

  const [step, setStep] = useState<1 | 2 | 3>(1);
  const [name, setName] = useState('');
  const [industry, setIndustry] = useState('');
  const [size, setSize] = useState('');
  const [website, setWebsite] = useState('');
  const [roles, setRoles] = useState<string[]>([]);
  const [goals, setGoals] = useState<string[]>([]);
  const [hydrated, setHydrated] = useState(false);

  // Rehydrate once from the server's saved progress (resumability).
  useEffect(() => {
    if (!status || hydrated) return;
    setName(status.company.name ?? '');
    setIndustry(status.company.industry ?? '');
    setSize(status.company.size ?? '');
    setWebsite(status.company.website ?? '');
    setRoles(status.selectedRoles);
    setGoals(status.goals);
    setStep(status.step === 'BUSINESS_GOALS' ? 3 : status.step === 'AI_EMPLOYEE_SELECTION' ? 2 : 1);
    setHydrated(true);
  }, [status, hydrated]);

  const availableGoals = useMemo(() => allowedGoalsForRoles(roles), [roles]);
  const toggle = (list: string[], set: (v: string[]) => void, value: string) =>
    set(list.includes(value) ? list.filter((x) => x !== value) : [...list, value]);

  const submitCompany = async () => {
    await saveCompany.mutateAsync({ name: name.trim(), industry, size, website: website.trim() || undefined });
    setStep(2);
  };
  const submitRoles = async () => {
    const next = await saveRoles.mutateAsync(roles);
    setGoals(next.goals); // server may have pruned goals to the new role set
    setStep(3);
  };
  // Route by ENTITLEMENT, not by hope.
  //
  // `/assist` requires BUSINESS or ENTERPRISE (`@RequirePlan` on the assist
  // controller) and a newly registered company defaults to STARTER — so the
  // wizard's own final button used to land every new customer on a screen that
  // 403s on its first two requests. A broken first-run experience for literally
  // every signup, invisible to API tests because none of them walk the
  // onboarding CTA into the next page. Found by driving the real browser.
  const canUseAssist =
    subscription?.plan === 'BUSINESS' || subscription?.plan === 'ENTERPRISE';

  const finish = async () => {
    await saveGoals.mutateAsync(goals);
    await complete.mutateAsync({
      business: { industry, size },
      departments: [],
      employees: roles.map((role) => ({ role: role as never })),
    });
    router.replace(canUseAssist ? '/assist' : '/dashboard');
  };

  // ── Step 1 — Company ──────────────────────────────────────────────────────
  if (step === 1) {
    const valid = name.trim() && industry && size;
    return (
      <OnboardingShell
        step={1}
        heading="Set up your workspace"
        subtitle="Tell us a little about your company."
        illustration={<SkylineIllustration />}
      >
        <div className="space-y-4">
          <div>
            <label htmlFor="co-name" className={labelClass}>Company name</label>
            <input id="co-name" className="field-modern" autoFocus value={name} onChange={(e) => setName(e.target.value)} placeholder="Acme Inc." />
          </div>
          <div>
            <label htmlFor="co-industry" className={labelClass}>Industry</label>
            <select id="co-industry" className="field-modern" value={industry} onChange={(e) => setIndustry(e.target.value)}>
              <option value="" disabled>Select an industry</option>
              {INDUSTRIES.map((i) => <option key={i} value={i}>{i}</option>)}
            </select>
          </div>
          <div>
            <label htmlFor="co-size" className={labelClass}>Company size</label>
            <select id="co-size" className="field-modern" value={size} onChange={(e) => setSize(e.target.value)}>
              <option value="" disabled>Select a size</option>
              {COMPANY_SIZES.map((s) => <option key={s} value={s}>{s} employees</option>)}
            </select>
          </div>
          <div>
            <label htmlFor="co-website" className={labelClass}>Website <span className="text-zinc-500">(optional)</span></label>
            <input id="co-website" className="field-modern" value={website} onChange={(e) => setWebsite(e.target.value)} placeholder="https://acme.com" />
          </div>
          <div className="flex justify-end pt-2">
            <button type="button" className={primaryBtn} disabled={!valid || saveCompany.isPending} onClick={submitCompany}>
              {saveCompany.isPending ? 'Saving…' : 'Continue'}
            </button>
          </div>
        </div>
      </OnboardingShell>
    );
  }

  // ── Step 2 — Choose AI Employee(s) ─────────────────────────────────────────
  if (step === 2) {
    return (
      <OnboardingShell
        step={2}
        heading="Choose your AI Employee"
        subtitle="Pick one or both — you can add more later."
        illustration={<AstronautIllustration />}
      >
        <div className="space-y-3">
          {ROLES.map((role) => (
            <ToggleCard key={role} checked={roles.includes(role)} onChange={() => toggle(roles, setRoles, role)}>
              <span>
                <span className="block text-sm font-semibold text-white">{ROLE_META[role].title}</span>
                <span className="mt-0.5 block text-xs text-zinc-400">{ROLE_META[role].blurb}</span>
              </span>
            </ToggleCard>
          ))}
          <div className="flex items-center justify-between pt-3">
            <button type="button" className={backBtn} onClick={() => setStep(1)}>Back</button>
            <button type="button" className={primaryBtn} disabled={roles.length === 0 || saveRoles.isPending} onClick={submitRoles}>
              {saveRoles.isPending ? 'Saving…' : 'Continue'}
            </button>
          </div>
        </div>
      </OnboardingShell>
    );
  }

  // ── Step 3 — Business goals ────────────────────────────────────────────────
  const busy = saveGoals.isPending || complete.isPending;
  return (
    <OnboardingShell
      step={3}
      heading="What should your AI workforce help with?"
      subtitle="Choose any that apply — these tailor your assistant."
      illustration={<LaunchIllustration />}
    >
      <div className="space-y-3">
        <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
          {availableGoals.map((goal) => (
            <ToggleCard key={goal} checked={goals.includes(goal)} onChange={() => toggle(goals, setGoals, goal)}>
              <span className="text-sm text-zinc-200">{goal}</span>
            </ToggleCard>
          ))}
        </div>
        <div className="flex items-center justify-between pt-3">
          <button type="button" className={backBtn} onClick={() => setStep(2)}>Back</button>
          {/* The label names where the click actually goes. "Open assistant" on a
              STARTER plan promises a screen the customer is not entitled to. */}
          <button type="button" className={primaryBtn} disabled={busy} onClick={finish}>
            {busy
              ? 'Finishing…'
              : canUseAssist
                ? 'Finish & open assistant'
                : 'Finish & go to dashboard'}
          </button>
        </div>
      </div>
    </OnboardingShell>
  );
}
