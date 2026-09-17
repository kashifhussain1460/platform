'use client';

import Link from 'next/link';
import { BarChart3, FileText, Headphones, Users } from 'lucide-react';
import { useOnboardingWizardStore } from '../../wizardStore';
import { FlowShell } from '../FlowShell';
import { StepFooter } from '../StepFooter';

const CAN_DO = [
  { icon: BarChart3, title: 'Increase revenue', text: 'Capture, qualify and follow up on leads.', chip: 'bg-blue-500/15 text-blue-400' },
  { icon: Headphones, title: 'Deliver better support', text: 'Handle customer inquiries 24/7.', chip: 'bg-rose-500/15 text-rose-400' },
  { icon: FileText, title: 'Automate internal work', text: 'Process documents, create reports, and more.', chip: 'bg-emerald-500/15 text-emerald-400' },
  { icon: Users, title: 'Scale without limits', text: 'Hire multiple AI employees across teams.', chip: 'bg-blue-500/15 text-blue-400' },
];

export function WelcomeStep() {
  const nextStep = useOnboardingWizardStore((s) => s.nextStep);

  return (
    <FlowShell
      heading="Welcome to Orlixa"
      subtitle="Let's set up your AI workforce in just a few steps."
      wide
    >
      <p className="max-w-2xl text-[15px] leading-relaxed text-fg-muted">
        You&apos;ll tell us about your company, choose your plan, hire AI employees, connect your
        tools, and get them working for you.
      </p>

      {/* Both cards open the real recorded product demo (/demo, how-it-works.mp4)
          in a new tab — this used to be two dead buttons with no handler at
          all. A new tab keeps the wizard's in-progress (sessionStorage-backed)
          state intact rather than navigating away from onboarding entirely. */}
      <div className="mt-7 grid gap-4 sm:grid-cols-2">
        <Link
          href="/demo"
          target="_blank"
          rel="noopener noreferrer"
          className="flex items-center gap-4 rounded-2xl border border-white/[0.08] bg-white/[0.02] p-5 text-left transition-colors hover:border-white/[0.16] hover:bg-white/[0.04]"
        >
          <span className="flex h-11 w-11 shrink-0 items-center justify-center rounded-full bg-violet/20 text-violet-bright">
            <FileText className="h-4 w-4" />
          </span>
          <span>
            <span className="block text-sm font-semibold text-white">See Orlixa in action</span>
            <span className="block text-[13px] text-fg-muted">Watch a 2-minute overview</span>
          </span>
        </Link>

        <Link
          href="/demo"
          target="_blank"
          rel="noopener noreferrer"
          className="relative flex items-center justify-between gap-4 overflow-hidden rounded-2xl border border-white/[0.08] bg-[linear-gradient(135deg,#2c1a63_0%,#120a2c_55%,#1d1042_100%)] p-5 text-left"
        >
          <span className="relative z-10">
            <span className="flex items-center gap-1.5 text-xs font-semibold text-violet-bright">
              <Users className="h-3.5 w-3.5" /> ORLIXA
            </span>
            <span className="mt-2 block text-sm font-semibold text-white">
              Your AI Workforce for Real Business
            </span>
          </span>
          <span
            aria-hidden
            className="absolute -right-6 top-3 hidden h-14 w-24 rotate-6 rounded-lg border border-white/[0.12] bg-white/[0.06] sm:block"
          />
          <span
            aria-hidden
            className="absolute -right-2 bottom-2 hidden h-10 w-20 -rotate-3 rounded-lg border border-white/[0.12] bg-white/[0.08] sm:block"
          />
        </Link>
      </div>

      <h2 className="mt-10 text-lg font-semibold text-white">What you can do with Orlixa</h2>
      <div className="mt-4 grid gap-4 sm:grid-cols-2">
        {CAN_DO.map(({ icon: Icon, title, text, chip }) => (
          <div key={title} className="flex items-start gap-3 rounded-2xl border border-white/[0.08] bg-white/[0.02] p-5">
            <span className={`flex h-10 w-10 shrink-0 items-center justify-center rounded-xl ${chip}`}>
              <Icon className="h-5 w-5" />
            </span>
            <span>
              <span className="block text-sm font-semibold text-white">{title}</span>
              <span className="block text-[13px] text-fg-muted">{text}</span>
            </span>
          </div>
        ))}
      </div>

      {/* "Skip for now" used to jump straight to the Complete step, which
          silently fired POST /onboarding/complete and permanently marked the
          company onboarded with zero employees, zero plan, zero data — a
          genuine account-destroying bug. This screen is pure marketing
          content with nothing to actually skip past except itself, so both
          buttons now do the same thing: move to Company. */}
      <StepFooter
        hideBack={false}
        backLabel="Skip for now"
        onBack={nextStep}
        onContinue={nextStep}
        continueLabel="Get Started →"
      />
    </FlowShell>
  );
}
