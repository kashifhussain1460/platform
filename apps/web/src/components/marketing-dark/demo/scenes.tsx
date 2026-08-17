'use client';

import { motion, type Variants } from 'framer-motion';
import {
  UserCheck,
  TrendingUp,
  Headphones,
  Calculator,
  Check,
  FileText,
  Sparkles,
} from 'lucide-react';
import { SlackIcon, GmailIcon, GoogleDriveIcon, HubSpotIcon, NotionIcon } from '../brand-icons';
import { OrlixaLockup } from '../OrlixaMark';

const EASE: [number, number, number, number] = [0.22, 1, 0.36, 1];

const container: Variants = {
  hidden: {},
  show: { transition: { staggerChildren: 0.12, delayChildren: 0.1 } },
};
const rise: Variants = {
  hidden: { opacity: 0, y: 22 },
  show: { opacity: 1, y: 0, transition: { duration: 0.6, ease: EASE } },
};
const pop: Variants = {
  hidden: { opacity: 0, scale: 0.8 },
  show: { opacity: 1, scale: 1, transition: { duration: 0.5, ease: EASE } },
};

/* ── Shared left-hand text column for step scenes ───────────────────────── */
function SceneShell({
  step,
  kicker,
  title,
  desc,
  config,
  children,
}: {
  step: string;
  kicker: string;
  title: string;
  desc: string;
  config: string[];
  children: React.ReactNode;
}) {
  return (
    <motion.div
      variants={container}
      initial="hidden"
      animate="show"
      className="grid h-full w-full max-w-[1100px] items-center gap-12 md:grid-cols-2"
    >
      <div>
        <motion.div variants={rise} className="flex items-baseline gap-4">
          <span className="bg-gradient-to-br from-violet-secondary to-violet bg-clip-text text-6xl font-black text-transparent">
            {step}
          </span>
          <span className="text-sm font-semibold uppercase tracking-[0.2em] text-violet-secondary">{kicker}</span>
        </motion.div>
        <motion.h2 variants={rise} className="mt-4 text-4xl font-bold leading-tight tracking-tight text-white">
          {title}
        </motion.h2>
        <motion.p variants={rise} className="mt-4 max-w-md text-lg leading-relaxed text-zinc-400">
          {desc}
        </motion.p>
        <motion.div variants={rise} className="mt-7">
          <p className="text-xs font-semibold uppercase tracking-[0.14em] text-fg-muted">You configure</p>
          <div className="mt-3 flex flex-wrap gap-2">
            {config.map((c) => (
              <span
                key={c}
                className="rounded-full border border-white/[0.1] bg-white/[0.04] px-3 py-1.5 text-sm text-zinc-200"
              >
                {c}
              </span>
            ))}
          </div>
        </motion.div>
      </div>
      <motion.div variants={pop} className="flex items-center justify-center">
        {children}
      </motion.div>
    </motion.div>
  );
}

/* ── Intro ──────────────────────────────────────────────────────────────── */
export function IntroScene() {
  return (
    <motion.div variants={container} initial="hidden" animate="show" className="flex flex-col items-center text-center">
      <motion.div variants={pop}>
        <OrlixaLockup width={340} />
      </motion.div>
      <motion.p variants={rise} className="mt-8 max-w-xl text-2xl font-medium leading-snug text-zinc-300">
        Build your <span className="text-violet-secondary">AI workforce</span> — in six simple steps.
      </motion.p>
    </motion.div>
  );
}

/* ── Step 1 — Hire ──────────────────────────────────────────────────────── */
const ROLES = [
  { label: 'AI Recruiter', Icon: UserCheck, hired: true },
  { label: 'AI Sales', Icon: TrendingUp },
  { label: 'AI Support', Icon: Headphones },
  { label: 'AI Accountant', Icon: Calculator },
];
export function HireScene() {
  return (
    <SceneShell
      step="01"
      kicker="Hire"
      title="Hire an AI Employee"
      desc="Pick a role from the marketplace. Each one arrives pre-trained and ready for duty in minutes."
      config={['Role', 'Name', 'Working hours', 'Owner']}
    >
      <div className="grid w-full max-w-sm grid-cols-2 gap-3">
        {ROLES.map((r, idx) => (
          <motion.div
            key={r.label}
            initial={{ opacity: 0, y: 16 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ delay: 0.5 + idx * 0.18, duration: 0.5, ease: EASE }}
            className={`relative flex items-center gap-2.5 rounded-xl border p-4 ${
              r.hired ? 'border-violet/60 bg-violet/[0.1]' : 'border-white/[0.08] bg-void-card'
            }`}
          >
            <span className="flex h-9 w-9 items-center justify-center rounded-lg bg-violet/20 text-violet-bright">
              <r.Icon className="h-4 w-4" strokeWidth={2} />
            </span>
            <span className="text-sm font-medium text-white">{r.label}</span>
            {r.hired && (
              <motion.span
                initial={{ opacity: 0, scale: 0.6 }}
                animate={{ opacity: 1, scale: 1 }}
                transition={{ delay: 1.5, duration: 0.4, ease: EASE }}
                className="absolute -right-2 -top-2 flex items-center gap-1 rounded-full bg-violet px-2 py-0.5 text-[11px] font-semibold text-white"
              >
                <Check className="h-3 w-3" strokeWidth={3} /> Hired
              </motion.span>
            )}
          </motion.div>
        ))}
      </div>
    </SceneShell>
  );
}

/* ── Step 2 — Skills ────────────────────────────────────────────────────── */
const SKILLS = [
  { Icon: SlackIcon, a: 'top-0 left-1/2 -translate-x-1/2' },
  { Icon: GmailIcon, a: 'top-1/4 right-0' },
  { Icon: GoogleDriveIcon, a: 'bottom-1/4 right-0' },
  { Icon: HubSpotIcon, a: 'bottom-0 left-1/2 -translate-x-1/2' },
  { Icon: NotionIcon, a: 'bottom-1/4 left-0' },
];
export function SkillsScene() {
  return (
    <SceneShell
      step="02"
      kicker="Skills"
      title="Grant Skills"
      desc="Connect the tools your employee needs — every skill is scoped and revocable in one click."
      config={['Slack', 'Gmail', 'Calendar', 'Stripe', '40+ more']}
    >
      <div className="relative h-64 w-64">
        {/* center employee node */}
        <motion.div
          initial={{ scale: 0.7, opacity: 0 }}
          animate={{ scale: 1, opacity: 1 }}
          transition={{ duration: 0.5, ease: EASE }}
          className="absolute left-1/2 top-1/2 flex h-16 w-16 -translate-x-1/2 -translate-y-1/2 items-center justify-center rounded-2xl border border-violet/50 bg-violet/15"
        >
          <UserCheck className="h-6 w-6 text-violet-secondary" strokeWidth={2} />
        </motion.div>
        {SKILLS.map((s, idx) => (
          <motion.div
            key={idx}
            initial={{ opacity: 0, scale: 0.5 }}
            animate={{ opacity: 1, scale: 1 }}
            transition={{ delay: 0.6 + idx * 0.22, duration: 0.45, ease: EASE }}
            className={`absolute ${s.a} flex h-12 w-12 items-center justify-center rounded-xl border border-white/[0.12] bg-void-card p-2.5 shadow-[0_0_20px_-6px_rgba(94,60,232,0.6)]`}
          >
            <s.Icon className="h-full w-full" />
          </motion.div>
        ))}
      </div>
    </SceneShell>
  );
}

/* ── Step 3 — Knowledge ─────────────────────────────────────────────────── */
export function KnowledgeScene() {
  return (
    <SceneShell
      step="03"
      kicker="Knowledge"
      title="Brief with Knowledge"
      desc="Upload your playbooks and docs. Answers stay grounded in your business — always with a citation."
      config={['PDFs', 'Docs', 'Price lists', 'Past tickets']}
    >
      <div className="relative h-64 w-72">
        {[0, 1, 2].map((i) => (
          <motion.div
            key={i}
            initial={{ opacity: 0, y: 20, x: i * 4 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ delay: 0.4 + i * 0.15, duration: 0.5, ease: EASE }}
            className="absolute flex h-40 w-32 flex-col gap-2 rounded-xl border border-white/[0.1] bg-void-card p-3"
            style={{ left: i * 22, top: i * 12 }}
          >
            <FileText className="h-5 w-5 text-violet-secondary" strokeWidth={2} />
            <span className="h-1.5 w-full rounded bg-white/[0.12]" />
            <span className="h-1.5 w-3/4 rounded bg-white/[0.12]" />
            <span className="h-1.5 w-5/6 rounded bg-white/[0.12]" />
          </motion.div>
        ))}
        <motion.div
          initial={{ opacity: 0, scale: 0.7 }}
          animate={{ opacity: 1, scale: 1 }}
          transition={{ delay: 1.4, duration: 0.5, ease: EASE }}
          className="absolute bottom-2 right-0 flex items-center gap-2 rounded-xl border border-violet/50 bg-violet/[0.12] px-3 py-2"
        >
          <Sparkles className="h-4 w-4 text-violet-secondary" strokeWidth={2} />
          <span className="text-sm font-medium text-white">Answer + cite</span>
        </motion.div>
      </div>
    </SceneShell>
  );
}

/* ── Step 4 — Workflow ──────────────────────────────────────────────────── */
const WF_NODES = ['New Email', 'AI screens', 'Qualified?', 'Schedule'];
export function WorkflowScene() {
  return (
    <SceneShell
      step="04"
      kicker="Workflows"
      title="Chain into Workflows"
      desc="Compose steps on a visual canvas and hand work between employees automatically — 24/7."
      config={['Trigger', 'AI step', 'Condition', 'Approval', 'Notify']}
    >
      <div className="flex w-full max-w-sm flex-col gap-3">
        {WF_NODES.map((n, idx) => (
          <motion.div key={n} className="flex items-center gap-3">
            <motion.div
              initial={{ opacity: 0, x: -16 }}
              animate={{ opacity: 1, x: 0 }}
              transition={{ delay: 0.4 + idx * 0.3, duration: 0.45, ease: EASE }}
              className={`flex-1 rounded-xl border px-4 py-3 text-sm font-medium ${
                idx === 2
                  ? 'border-violet/50 bg-violet/[0.1] text-white'
                  : 'border-white/[0.1] bg-void-card text-zinc-200'
              }`}
            >
              {n}
            </motion.div>
          </motion.div>
        ))}
      </div>
    </SceneShell>
  );
}

/* ── Step 5 — Approvals ─────────────────────────────────────────────────── */
export function ApprovalScene() {
  return (
    <SceneShell
      step="05"
      kicker="Approvals"
      title="Gate with Approvals"
      desc="Set the line no employee crosses alone. Risky actions wait for one-tap human approval — every action logged."
      config={['Spend limits', 'Risky tools', 'Reviewers']}
    >
      <div className="w-full max-w-xs rounded-2xl border border-white/[0.1] bg-void-card p-5">
        <p className="text-[11px] font-semibold uppercase tracking-[0.14em] text-fg-muted">Approval needed</p>
        <p className="mt-2 text-[15px] font-semibold text-white">AI Finance · Send invoice</p>
        <p className="text-sm text-zinc-400">$12,000 → Acme Co.</p>
        <div className="mt-4 flex gap-3">
          <div className="flex-1 rounded-lg border border-coral-400 py-2 text-center text-sm font-semibold text-coral-400">
            Hold
          </div>
          <motion.div
            initial={{ boxShadow: '0 0 0 0 rgba(52,211,153,0)' }}
            animate={{ boxShadow: ['0 0 0 0 rgba(52,211,153,0.5)', '0 0 0 10px rgba(52,211,153,0)'] }}
            transition={{ delay: 1.4, duration: 1, repeat: 2, ease: 'easeOut' }}
            className="flex flex-1 items-center justify-center gap-1.5 rounded-lg bg-mint-500 py-2 text-sm font-semibold text-white"
          >
            <motion.span
              initial={{ scale: 0 }}
              animate={{ scale: 1 }}
              transition={{ delay: 1.4, duration: 0.3, ease: EASE }}
            >
              <Check className="h-4 w-4" strokeWidth={3} />
            </motion.span>
            Approved
          </motion.div>
        </div>
      </div>
    </SceneShell>
  );
}

/* ── Step 6 — Measure ───────────────────────────────────────────────────── */
export function MeasureScene() {
  return (
    <SceneShell
      step="06"
      kicker="Measure"
      title="Measure & scale"
      desc="Watch output on the dashboard — tasks completed, hours saved, approval SLA. Clone what works."
      config={['KPIs', 'Goals', 'Alerts']}
    >
      <div className="grid w-full max-w-sm grid-cols-2 gap-3">
        {[
          ['1,248', 'Tasks completed', '+18.6%'],
          ['98.6%', 'Success rate', '+3.2%'],
          ['312', 'Hours saved / mo', ''],
          ['2.4h', 'Avg approval SLA', ''],
        ].map(([v, l, d], idx) => (
          <motion.div
            key={l}
            initial={{ opacity: 0, y: 16 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ delay: 0.4 + idx * 0.15, duration: 0.45, ease: EASE }}
            className="rounded-xl border border-white/[0.08] bg-void-card p-4"
          >
            <p className="text-2xl font-bold text-white">{v}</p>
            <p className="mt-0.5 text-xs text-fg-muted">{l}</p>
            {d && <p className="mt-1 text-xs font-medium text-emerald-400">{d}</p>}
          </motion.div>
        ))}
      </div>
    </SceneShell>
  );
}

/* ── Outro ──────────────────────────────────────────────────────────────── */
export function OutroScene() {
  return (
    <motion.div variants={container} initial="hidden" animate="show" className="flex flex-col items-center text-center">
      <motion.div variants={pop}>
        <OrlixaLockup width={220} />
      </motion.div>
      <motion.h2 variants={rise} className="mt-6 max-w-2xl text-5xl font-black leading-tight tracking-tight text-white">
        Start building your <span className="text-violet-secondary">AI workforce.</span>
      </motion.h2>
      <motion.div variants={rise} className="mt-8 flex items-center gap-4">
        <span className="rounded-full bg-white px-6 py-3 text-[15px] font-semibold text-violet-accent">
          Hire your first AI Employee
        </span>
        <span className="text-lg font-semibold tracking-wide text-zinc-300">orlixa.io</span>
      </motion.div>
    </motion.div>
  );
}
