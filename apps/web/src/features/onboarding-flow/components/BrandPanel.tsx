'use client';

import Link from 'next/link';
import { Bot, BookOpen, Link2, Users, Zap } from 'lucide-react';
import { GmailIcon, HubSpotIcon, MoreIcon, NotionIcon, SlackIcon } from '@/components/marketing-dark/brand-icons';
import { OrlixaLockup } from '@/components/marketing-dark/OrlixaMark';
import { PANEL_CONTENT } from '../panelContent';
import { FLOW_STEPS, type FlowStep } from '../types';

const BULLET_ICONS = [
  { icon: Zap, chip: 'bg-blue-500/15 text-blue-400' },
  { icon: Link2, chip: 'bg-violet/15 text-violet-secondary' },
  { icon: BookOpen, chip: 'bg-emerald-500/15 text-emerald-400' },
  { icon: Users, chip: 'bg-orange-500/15 text-orange-400' },
] as const;

function Orb() {
  return (
    <div className="relative flex h-28 w-28 shrink-0 items-center justify-center">
      <div className="absolute inset-0 animate-glow-pulse rounded-full bg-violet/25 blur-2xl" />
      <div className="absolute inset-1 rounded-full border border-violet-secondary/25" />
      <div className="relative flex h-24 w-24 items-center justify-center rounded-full bg-[linear-gradient(135deg,#1c1136_0%,#050208_100%)] shadow-[0_0_50px_-8px_rgba(94,60,232,0.65)]">
        <Bot className="h-10 w-10 text-violet-bright" />
      </div>
    </div>
  );
}

function ProgressDots({ index }: { index: number }) {
  // Position among the non-welcome screens, capped at 5 dots (§ matches
  // the reference design's compressed "how far along" strip — the exact
  // numbered tracker lives in the top bar, this is just mood).
  const filled = Math.min(5, index);
  return (
    <div className="mt-5 flex items-center gap-1.5">
      {Array.from({ length: 5 }).map((_, i) => (
        <span
          key={i}
          className={`h-1.5 rounded-full transition-all ${i < filled ? 'w-6 bg-violet' : 'w-1.5 bg-white/15'}`}
        />
      ))}
    </div>
  );
}

export function BrandPanel({ step }: { step: FlowStep }) {
  const content = PANEL_CONTENT[step];
  const index = FLOW_STEPS.indexOf(step);

  return (
    // Hidden below `lg`: this panel is pure decorative/marketing content, and
    // at narrower widths it used to render at full natural height ABOVE the
    // real step content in FlowShell's flex-col stack — a phone-width user
    // saw nothing but this panel and had to scroll ~1200px to reach the
    // actual form. Below `lg` the functional content is the only thing that
    // renders; above `lg` this sits beside it exactly as before.
    <aside className="relative hidden w-full shrink-0 flex-col justify-between overflow-x-hidden overflow-y-auto border-white/[0.06] px-8 py-10 [-ms-overflow-style:none] [scrollbar-width:none] sm:px-10 lg:flex lg:h-full lg:w-[440px] lg:border-r lg:px-10 [&::-webkit-scrollbar]:hidden">
      <div
        aria-hidden
        className="pointer-events-none absolute -left-40 top-1/3 h-[480px] w-[480px] rounded-full bg-violet/20 blur-[110px]"
      />

      <div className="relative">
        <Link href="/">
          <OrlixaLockup height={28} />
        </Link>

        {content.eyebrow && (
          <p className="mt-9 text-xs font-semibold uppercase tracking-[0.14em] text-violet-secondary">
            {content.eyebrow}
          </p>
        )}
        <h1
          className={`${content.eyebrow ? 'mt-3' : 'mt-9'} max-w-sm text-[30px] font-bold leading-[1.15] tracking-tight text-white`}
        >
          {content.headlineLead}{' '}
          <span className="bg-gradient-to-r from-violet to-violet-secondary bg-clip-text text-transparent">
            {content.headlineHighlight}
          </span>
        </h1>
        <p className="mt-4 max-w-sm text-[15px] leading-relaxed text-fg-muted">{content.tagline}</p>

        <ul className="mt-9 space-y-4">
          {content.bullets.map((text, i) => {
            const { icon: Icon, chip } = BULLET_ICONS[i];
            return (
              <li key={text} className="flex items-start gap-3">
                <span className={`flex h-10 w-10 shrink-0 items-center justify-center rounded-xl ${chip}`}>
                  <Icon className="h-5 w-5" />
                </span>
                <span className="pt-2 text-sm font-medium text-white">{text}</span>
              </li>
            );
          })}
        </ul>
      </div>

      <div className="relative mt-10">
        {content.annotations.length === 1 ? (
          <div className="flex flex-col items-center">
            <Orb />
            <p className="mt-4 max-w-[220px] rounded-xl border border-white/[0.08] bg-white/[0.04] px-4 py-2 text-center text-xs text-zinc-300">
              {content.annotations[0]}
            </p>
          </div>
        ) : (
          <div className="relative flex min-h-[168px] items-center justify-end pl-4">
            <span className="absolute left-0 top-0 max-w-[180px] -rotate-3 rounded-xl border border-white/[0.1] bg-white/[0.05] px-3.5 py-2.5 text-xs font-medium text-zinc-200 shadow-[0_8px_24px_-8px_rgba(0,0,0,0.6)]">
              {content.annotations[0]}
            </span>
            <span className="absolute bottom-0 left-6 max-w-[180px] rotate-2 rounded-xl border border-white/[0.1] bg-white/[0.05] px-3.5 py-2.5 text-xs font-medium text-zinc-200 shadow-[0_8px_24px_-8px_rgba(0,0,0,0.6)]">
              {content.annotations[1]}
            </span>
            <Orb />
          </div>
        )}

        {content.quote && (
          <div className="mt-6">
            <p className="text-[15px] italic leading-relaxed text-zinc-300">&ldquo;{content.quote}&rdquo;</p>
            <div className="mt-2 flex items-center gap-2">
              <span className="h-px w-6 bg-white/20" />
              <span className="text-xs font-medium tracking-wide text-fg-muted">ORLIXA</span>
            </div>
          </div>
        )}

        {index > 0 && <ProgressDots index={index} />}

        <div className="mt-8 flex items-center gap-2">
          {[GmailIcon, SlackIcon, HubSpotIcon, NotionIcon].map((Icon, i) => (
            <span key={i} className="flex h-9 w-9 items-center justify-center overflow-hidden rounded-lg bg-white/[0.06] p-1.5">
              <Icon className="h-full w-full" />
            </span>
          ))}
          <span className="flex h-9 w-9 items-center justify-center rounded-lg bg-white/[0.06] text-fg-muted">
            <MoreIcon className="h-4 w-4" />
          </span>
        </div>

        <p className="relative mt-8 text-xs text-fg-disabled">
          © {new Date().getFullYear()} Orlixa. All rights reserved.
        </p>
      </div>
    </aside>
  );
}
