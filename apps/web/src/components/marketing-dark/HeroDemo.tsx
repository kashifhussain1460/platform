'use client';

import { useEffect, useState } from 'react';
import { AnimatePresence, motion, type Variants } from 'framer-motion';
import { UserCheck, TrendingUp, Headphones, Calculator, Check, FileText, Sparkles } from 'lucide-react';
import { SlackIcon, GmailIcon, GoogleDriveIcon, HubSpotIcon, NotionIcon } from './brand-icons';

const EASE: [number, number, number, number] = [0.22, 1, 0.36, 1];
const wrap: Variants = { hidden: {}, show: { transition: { staggerChildren: 0.09, delayChildren: 0.05 } } };
const rise: Variants = { hidden: { opacity: 0, y: 18 }, show: { opacity: 1, y: 0, transition: { duration: 0.5, ease: EASE } } };
const pop: Variants = { hidden: { opacity: 0, scale: 0.85 }, show: { opacity: 1, scale: 1, transition: { duration: 0.45, ease: EASE } } };

/* ── Step visuals (large, centered, transparent) ────────────────────────── */

function HireViz() {
  const roles = [
    { label: 'AI Recruiter', Icon: UserCheck, hired: true },
    { label: 'AI Sales', Icon: TrendingUp },
    { label: 'AI Support', Icon: Headphones },
    { label: 'AI Accountant', Icon: Calculator },
  ];
  return (
    <div className="grid w-full max-w-[420px] grid-cols-2 gap-4">
      {roles.map((r) => (
        <motion.div
          key={r.label}
          variants={pop}
          className={`relative flex items-center gap-3 rounded-2xl border p-5 ${
            r.hired ? 'border-violet/60 bg-violet/[0.12]' : 'border-white/[0.1] bg-void-card/80'
          }`}
        >
          <span className="flex h-11 w-11 items-center justify-center rounded-xl bg-violet/20 text-violet-bright">
            <r.Icon className="h-5 w-5" strokeWidth={2} />
          </span>
          <span className="text-[15px] font-medium text-white">{r.label}</span>
          {r.hired && (
            <span className="absolute -right-2.5 -top-2.5 flex items-center gap-1 rounded-full bg-violet px-2.5 py-1 text-[11px] font-semibold text-white">
              <Check className="h-3 w-3" strokeWidth={3} /> Hired
            </span>
          )}
        </motion.div>
      ))}
    </div>
  );
}

function SkillsViz() {
  const skills = [
    { Icon: SlackIcon, pos: 'left-1/2 top-0 -translate-x-1/2' },
    { Icon: GmailIcon, pos: 'right-2 top-1/4' },
    { Icon: GoogleDriveIcon, pos: 'bottom-1/4 right-2' },
    { Icon: HubSpotIcon, pos: 'bottom-0 left-1/2 -translate-x-1/2' },
    { Icon: NotionIcon, pos: 'left-2 top-1/3' },
  ];
  return (
    <div className="relative h-[300px] w-[300px]">
      <motion.div
        variants={pop}
        className="absolute left-1/2 top-1/2 flex h-20 w-20 -translate-x-1/2 -translate-y-1/2 items-center justify-center rounded-3xl border border-violet/50 bg-violet/15"
      >
        <UserCheck className="h-8 w-8 text-violet-secondary" strokeWidth={2} />
      </motion.div>
      {skills.map((s, i) => (
        <motion.div
          key={i}
          variants={pop}
          className={`absolute ${s.pos} flex h-14 w-14 items-center justify-center rounded-2xl border border-white/[0.12] bg-void-card p-3 shadow-[0_0_24px_-6px_rgba(94,60,232,0.6)]`}
        >
          <s.Icon className="h-full w-full" />
        </motion.div>
      ))}
    </div>
  );
}

function KnowledgeViz() {
  return (
    <div className="relative h-[300px] w-[340px]">
      {[0, 1, 2].map((i) => (
        <motion.div
          key={i}
          variants={rise}
          className="absolute flex h-48 w-40 flex-col gap-2.5 rounded-2xl border border-white/[0.1] bg-void-card p-4"
          style={{ left: i * 28, top: i * 16 }}
        >
          <FileText className="h-6 w-6 text-violet-secondary" strokeWidth={2} />
          <span className="h-2 w-full rounded bg-white/[0.12]" />
          <span className="h-2 w-3/4 rounded bg-white/[0.12]" />
          <span className="h-2 w-5/6 rounded bg-white/[0.12]" />
          <span className="h-2 w-2/3 rounded bg-white/[0.12]" />
        </motion.div>
      ))}
      <motion.div
        variants={pop}
        className="absolute bottom-3 right-0 flex items-center gap-2 rounded-2xl border border-violet/50 bg-violet/[0.14] px-4 py-2.5"
      >
        <Sparkles className="h-4 w-4 text-violet-secondary" strokeWidth={2} />
        <span className="text-sm font-medium text-white">Answer + cite</span>
      </motion.div>
    </div>
  );
}

function WorkflowViz() {
  const nodes = ['New Email', 'AI screens CV', 'Qualified?', 'Schedule interview'];
  return (
    <div className="flex w-full max-w-[380px] flex-col gap-3.5">
      {nodes.map((n, i) => (
        <motion.div key={n} variants={rise} className="flex flex-col items-center gap-3.5">
          <div
            className={`w-full rounded-2xl border px-5 py-4 text-[15px] font-medium ${
              i === 2 ? 'border-violet/50 bg-violet/[0.12] text-white' : 'border-white/[0.1] bg-void-card/80 text-zinc-200'
            }`}
          >
            {n}
          </div>
          {i < nodes.length - 1 && <span className="h-4 w-px bg-white/20" />}
        </motion.div>
      ))}
    </div>
  );
}

function ApprovalViz() {
  return (
    <motion.div variants={pop} className="w-full max-w-[360px] rounded-3xl border border-white/[0.1] bg-void-card/90 p-6">
      <p className="text-[11px] font-semibold uppercase tracking-[0.16em] text-fg-muted">Approval needed</p>
      <p className="mt-3 text-lg font-semibold text-white">AI Finance · Send invoice</p>
      <p className="text-[15px] text-zinc-400">$12,000 → Acme Co.</p>
      <div className="mt-5 flex gap-3">
        <div className="flex-1 rounded-xl border border-coral-400 py-2.5 text-center text-sm font-semibold text-coral-400">Hold</div>
        <div className="flex flex-1 items-center justify-center gap-1.5 rounded-xl bg-mint-500 py-2.5 text-sm font-semibold text-white">
          <Check className="h-4 w-4" strokeWidth={3} /> Approve
        </div>
      </div>
    </motion.div>
  );
}

function MeasureViz() {
  const stats: [string, string, string][] = [
    ['1,248', 'Tasks completed', '+18.6%'],
    ['98.6%', 'Success rate', '+3.2%'],
    ['312', 'Hours saved / mo', ''],
    ['2.4h', 'Avg approval SLA', ''],
  ];
  return (
    <div className="grid w-full max-w-[400px] grid-cols-2 gap-4">
      {stats.map(([v, l, d]) => (
        <motion.div key={l} variants={rise} className="rounded-2xl border border-white/[0.1] bg-void-card/80 p-5">
          <p className="text-3xl font-bold text-white">{v}</p>
          <p className="mt-1 text-xs text-fg-muted">{l}</p>
          {d && <p className="mt-1.5 text-xs font-medium text-emerald-400">{d}</p>}
        </motion.div>
      ))}
    </div>
  );
}

const SCENES = [
  { n: '01', label: 'Hire an AI Employee', Viz: HireViz },
  { n: '02', label: 'Grant Skills', Viz: SkillsViz },
  { n: '03', label: 'Brief with Knowledge', Viz: KnowledgeViz },
  { n: '04', label: 'Chain into Workflows', Viz: WorkflowViz },
  { n: '05', label: 'Gate with Approvals', Viz: ApprovalViz },
  { n: '06', label: 'Measure & scale', Viz: MeasureViz },
];

/**
 * In-hero auto-looping product explainer. Transparent — no card/border chrome,
 * so it reads as a live preview native to the hero (not "rendered in a box").
 * Loops through the six product steps with smooth Framer transitions.
 */
export function HeroDemo({ className = '' }: { className?: string }) {
  const [i, setI] = useState(0);
  useEffect(() => {
    const t = setInterval(() => setI((v) => (v + 1) % SCENES.length), 4000);
    return () => clearInterval(t);
  }, []);

  const S = SCENES[i];

  return (
    <div className={`flex flex-col items-center justify-center ${className}`}>
      {/* focus glow (blends with hero, not a container) */}
      <div aria-hidden className="pointer-events-none absolute left-1/2 top-1/2 h-80 w-80 -translate-x-1/2 -translate-y-1/2 rounded-full bg-violet/20 blur-[100px]" />

      <div className="relative flex min-h-[420px] w-full items-center justify-center">
        <AnimatePresence mode="wait">
          <motion.div
            key={S.n}
            variants={wrap}
            initial="hidden"
            animate="show"
            exit={{ opacity: 0, y: -16, transition: { duration: 0.35, ease: EASE } }}
            className="flex flex-col items-center"
          >
            <S.Viz />
          </motion.div>
        </AnimatePresence>
      </div>

      {/* caption + progress (minimal, no box) */}
      <div className="relative mt-6 flex flex-col items-center gap-3">
        <AnimatePresence mode="wait">
          <motion.p
            key={S.n}
            initial={{ opacity: 0, y: 8 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -8 }}
            transition={{ duration: 0.35, ease: EASE }}
            className="text-[15px] font-medium text-zinc-300"
          >
            <span className="mr-2 font-mono font-semibold text-violet-secondary">{S.n}</span>
            {S.label}
          </motion.p>
        </AnimatePresence>
        <div className="flex items-center gap-1.5">
          {SCENES.map((s, idx) => (
            <span
              key={s.n}
              className={`h-1 rounded-full transition-all duration-500 ${idx === i ? 'w-6 bg-violet' : 'w-1.5 bg-white/20'}`}
            />
          ))}
        </div>
      </div>
    </div>
  );
}
