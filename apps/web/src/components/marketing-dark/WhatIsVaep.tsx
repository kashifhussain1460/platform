import { Code2, Cpu, ShieldCheck, TrendingUp } from 'lucide-react';
import { DarkKicker, DarkHl } from './DarkSectionHeading';
import { DashboardMock } from './DashboardMock';

const FEATURES = [
  { Icon: Code2, title: 'No Coding', body: 'Build workflows in minutes' },
  { Icon: Cpu, title: 'AI-Powered', body: 'Smarter decisions, better results' },
  { Icon: ShieldCheck, title: 'Secure & Private', body: 'Enterprise-grade security' },
  { Icon: TrendingUp, title: 'Scalable', body: 'From startup to enterprise' },
];

/** "What is V-AEP?" — feature list + product dashboard mockup. */
export function WhatIsVaep() {
  return (
    <section className="border-t border-white/[0.06] py-20 sm:py-28">
      <div className="mx-auto grid max-w-[1440px] items-center gap-12 px-8 lg:grid-cols-2">
        <div>
          <DarkKicker>What is Orlixa?</DarkKicker>
          <h2 className="mt-3 text-[28px] font-bold leading-tight tracking-tight text-white sm:text-4xl">
            The AI Workforce Platform for <DarkHl>modern businesses</DarkHl>
          </h2>
          <p className="mt-5 max-w-lg text-[15px] leading-relaxed text-zinc-400">
            Orlixa helps you hire, manage, and collaborate with AI employees for every function in
            your business. Powered by advanced AI, built for real-world work.
          </p>

          <ul className="mt-8 space-y-5">
            {FEATURES.map(({ Icon, title, body }) => (
              <li key={title} className="flex items-start gap-3">
                <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg border border-white/[0.08] bg-white/[0.03] text-violet-secondary">
                  <Icon className="h-4 w-4" strokeWidth={2} />
                </span>
                <div>
                  <p className="text-[15px] font-semibold text-white">{title}</p>
                  <p className="text-sm text-fg-muted">{body}</p>
                </div>
              </li>
            ))}
          </ul>
        </div>

        <DashboardMock />
      </div>
    </section>
  );
}
