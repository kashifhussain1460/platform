'use client';

import { useEffect, useMemo, useState } from 'react';
import { useRouter } from 'next/navigation';
import { allowedGoalsForRoles } from '@vaep/types';
import { ArrowRight, Building2, Globe, LayoutGrid, ShieldCheck, Users } from 'lucide-react';
import { DEPARTMENT_PRESETS } from '@vaep/types';
import { OnboardingShell } from '@/components/onboarding/OnboardingShell';
import { IconField, ToggleCard } from '@/components/onboarding/fields';
import { useEntitlements } from '@/features/product-context/hooks';
import { COMPANY_SIZES, INDUSTRIES } from '../labels';
import {
  useCompleteOnboarding,
  useOnboardingStatus,
  useSaveOnboardingAiEmployees,
  useSaveOnboardingCompany,
  useSaveOnboardingDepartments,
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

const backBtn =
  'rounded-xl border border-white/[0.12] bg-white/[0.03] px-5 py-2.5 text-sm font-medium text-zinc-300 transition-colors hover:border-white/25 disabled:opacity-50';
const primaryBtn =
  'inline-flex items-center justify-center rounded-xl bg-[linear-gradient(135deg,#6a30ec_0%,#5216dd_100%)] px-8 py-3 text-sm font-semibold text-white transition-all hover:-translate-y-0.5 disabled:cursor-not-allowed disabled:opacity-60';

/**
 * Minimal 4-step onboarding:
 *   Company → Choose AI Employee(s) → Business goals → Departments.
 *
 * Every step persists server-side (PATCH /onboarding/*), so it resumes exactly
 * after a refresh / logout / device change. Finishing provisions the selected
 * AI Employees and hands off to AI Assist — or to the dashboard when the plan
 * does not include Assist (see `finish`).
 *
 * ## Why departments are a step at all
 *
 * They used to be sent as a literal `departments: []` on every signup, so no
 * tenant that has ever onboarded had a single department row. Everything built
 * on top of that structure — department-scoped authorization, DEPARTMENT
 * approval routing, DEPARTMENT workflow permissions — was therefore inert in
 * production, not because the code was missing but because the axis it scopes
 * on was empty.
 *
 * Departments are created UNRESTRICTED (no `scopes`). That is deliberate:
 * creating a department must never silently start denying anyone. Restricting
 * one is an explicit, explained action in Settings → Organization.
 */
export function OnboardingWizard() {
  const router = useRouter();
  // Read the resolved entitlement so the final step routes somewhere the user
  // can actually use.
  const entitlements = useEntitlements();
  const { data: status } = useOnboardingStatus();
  const saveCompany = useSaveOnboardingCompany();
  const saveRoles = useSaveOnboardingAiEmployees();
  const saveGoals = useSaveOnboardingGoals();
  const saveDepartments = useSaveOnboardingDepartments();
  const complete = useCompleteOnboarding();

  const [step, setStep] = useState<1 | 2 | 3 | 4>(1);
  const [name, setName] = useState('');
  const [industry, setIndustry] = useState('');
  const [size, setSize] = useState('');
  const [website, setWebsite] = useState('');
  const [roles, setRoles] = useState<string[]>([]);
  const [goals, setGoals] = useState<string[]>([]);
  const [departments, setDepartments] = useState<string[]>([]);
  const [customDepartment, setCustomDepartment] = useState('');
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
    // Departments come back as the REAL persisted rows, so a resumed wizard
    // shows what the company actually has rather than a remembered draft.
    setDepartments(status.departments);
    setStep(
      status.step === 'DEPARTMENTS'
        ? 4
        : status.step === 'BUSINESS_GOALS'
          ? 3
          : status.step === 'AI_EMPLOYEE_SELECTION'
            ? 2
            : 1,
    );
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
  const canUseAssist = entitlements.includes('ASSIST');

  const submitGoals = async () => {
    await saveGoals.mutateAsync(goals);
    setStep(4);
  };

  const addCustomDepartment = () => {
    const value = customDepartment.trim().replace(/\s+/g, ' ');
    if (!value) return;
    // Case-insensitive, because "sales" and "Sales" are one department and the
    // server's unique index would otherwise reject the second one.
    if (!departments.some((d) => d.toLowerCase() === value.toLowerCase())) {
      setDepartments([...departments, value]);
    }
    setCustomDepartment('');
  };

  const finish = async () => {
    // Departments are persisted by their own step so they survive a refresh,
    // and sent again here so a company that skipped ahead still gets them.
    // Both paths share the server's normalisation, so this cannot double-create.
    await saveDepartments.mutateAsync(departments);
    await complete.mutateAsync({
      business: { industry, size },
      departments,
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
      >
        <div className="space-y-5">
          <IconField id="co-name" label="Company name" icon={<Building2 className="h-[18px] w-[18px]" />}>
            <input
              id="co-name"
              className="field-modern field-with-icon"
              autoFocus
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="Acme Inc."
            />
          </IconField>

          <IconField
            id="co-industry"
            label="Industry"
            icon={<LayoutGrid className="h-[18px] w-[18px]" />}
            hint="Select the industry that best describes your business."
          >
            <select
              id="co-industry"
              aria-describedby="co-industry-hint"
              className="field-modern field-with-icon"
              value={industry}
              onChange={(e) => setIndustry(e.target.value)}
            >
              <option value="" disabled>Select an industry</option>
              {INDUSTRIES.map((i) => <option key={i} value={i}>{i}</option>)}
            </select>
          </IconField>

          <IconField
            id="co-size"
            label="Company size"
            icon={<Users className="h-[18px] w-[18px]" />}
            hint="This helps us tailor your experience."
          >
            <select
              id="co-size"
              aria-describedby="co-size-hint"
              className="field-modern field-with-icon"
              value={size}
              onChange={(e) => setSize(e.target.value)}
            >
              <option value="" disabled>Select a size</option>
              {COMPANY_SIZES.map((s) => <option key={s} value={s}>{s} employees</option>)}
            </select>
          </IconField>

          <IconField id="co-website" label="Website" optional icon={<Globe className="h-[18px] w-[18px]" />}>
            <input
              id="co-website"
              className="field-modern field-with-icon"
              value={website}
              onChange={(e) => setWebsite(e.target.value)}
              placeholder="https://acme.com"
            />
          </IconField>

          <div className="flex justify-end pt-2">
            <button type="button" className={primaryBtn} disabled={!valid || saveCompany.isPending} onClick={submitCompany}>
              {saveCompany.isPending ? 'Saving…' : 'Continue'}
              {!saveCompany.isPending && <ArrowRight className="h-4 w-4" aria-hidden />}
            </button>
          </div>

          {/* Says what happens to what they just typed, at the moment they are
              deciding whether to type it. */}
          <p className="flex items-center justify-center gap-2 pt-1 text-center text-[13px] text-fg-muted">
            <ShieldCheck className="h-4 w-4 shrink-0 text-violet-secondary" aria-hidden />
            Your details stay in your workspace. You can change them any time.
          </p>
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
  if (step === 3) {
    return (
      <OnboardingShell
        step={3}
        heading="What should your AI workforce help with?"
        subtitle="Choose any that apply — these tailor your assistant."
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
            <button
              type="button"
              className={primaryBtn}
              disabled={saveGoals.isPending}
              onClick={submitGoals}
            >
              {saveGoals.isPending ? 'Saving…' : 'Continue'}
            </button>
          </div>
        </div>
      </OnboardingShell>
    );
  }

  // ── Step 4 — Departments ───────────────────────────────────────────────────
  const busy = saveDepartments.isPending || complete.isPending;
  return (
    <OnboardingShell
      step={4}
      heading="How is your company organised?"
      subtitle="Add the teams you actually have. You can change this any time."
    >
      <div className="space-y-4">
        <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
          {DEPARTMENT_PRESETS.map((preset) => (
            <ToggleCard
              key={preset}
              checked={departments.some((d) => d.toLowerCase() === preset.toLowerCase())}
              onChange={() =>
                setDepartments(
                  departments.some((d) => d.toLowerCase() === preset.toLowerCase())
                    ? departments.filter((d) => d.toLowerCase() !== preset.toLowerCase())
                    : [...departments, preset],
                )
              }
            >
              <span className="text-sm text-zinc-200">{preset}</span>
            </ToggleCard>
          ))}
        </div>

        <div>
          <label htmlFor="custom-dept" className="mb-1.5 block text-sm text-zinc-300">
            Something else?
          </label>
          <div className="flex gap-2">
            <input
              id="custom-dept"
              className="field-modern"
              placeholder="e.g. Customer Success"
              value={customDepartment}
              maxLength={120}
              onChange={(e) => setCustomDepartment(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') {
                  // Otherwise Enter submits the wizard from a text box, which
                  // finishes onboarding when the user meant "add this one".
                  e.preventDefault();
                  addCustomDepartment();
                }
              }}
            />
            <button
              type="button"
              className={backBtn}
              onClick={addCustomDepartment}
              disabled={!customDepartment.trim()}
            >
              Add
            </button>
          </div>
        </div>

        {/* Only the ones NOT already shown as a preset chip, so a selected
            preset does not appear twice. */}
        {departments.filter(
          (d) => !DEPARTMENT_PRESETS.some((p) => p.toLowerCase() === d.toLowerCase()),
        ).length > 0 && (
          <div className="flex flex-wrap gap-2">
            {departments
              .filter((d) => !DEPARTMENT_PRESETS.some((p) => p.toLowerCase() === d.toLowerCase()))
              .map((d) => (
                <span
                  key={d}
                  className="inline-flex items-center gap-2 rounded-full border border-white/[0.12] bg-white/[0.04] px-3 py-1 text-xs text-zinc-200"
                >
                  {d}
                  <button
                    type="button"
                    aria-label={`Remove ${d}`}
                    className="text-zinc-400 hover:text-white"
                    onClick={() => setDepartments(departments.filter((x) => x !== d))}
                  >
                    ×
                  </button>
                </span>
              ))}
          </div>
        )}

        {/* Say what this does and — just as importantly — what it does not do.
            A new department restricts nobody until someone turns that on. */}
        <p className="text-[13px] text-fg-muted">
          Departments organise your people and your AI Employees. Everyone can still
          see everything for now — you can limit a department to its own work later
          in Settings → Organization.
        </p>

        <div className="flex items-center justify-between pt-1">
          <button type="button" className={backBtn} onClick={() => setStep(3)}>Back</button>
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
