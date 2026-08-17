'use client';

import Link from 'next/link';
import { motion, type Variants } from 'framer-motion';
import { Rocket, Play } from 'lucide-react';
import { HeroDemo } from './HeroDemo';

const EASE_SWISS = [0.22, 1, 0.36, 1] as const;

const fadeUp: Variants = {
  hidden: { opacity: 0, y: 24 },
  show: (i: number = 0) => ({
    opacity: 1,
    y: 0,
    transition: { duration: 0.6, delay: i * 0.1, ease: EASE_SWISS },
  }),
};

const LOGOS = ['Microsoft', 'Google', 'airbnb', 'HubSpot', 'stripe', 'Notion'];

const STATS: [string, string][] = [
  ['12+', 'AI Employee Roles'],
  ['500+', 'Integrations'],
  ['98.6%', 'Task Success Rate'],
  ['300+', 'Hours Saved Per Month'],
];

/** Dark/violet glassmorphic hero — pixel-matched to the reference screenshot. */
export function DarkHero() {
  return (
    <section className="relative overflow-hidden">
      {/* ambient violet glow behind the head */}
      <div
        aria-hidden
        className="pointer-events-none absolute -right-40 top-0 h-[720px] w-[720px] bg-dark-glow blur-3xl"
      />
      <div aria-hidden className="pointer-events-none absolute left-1/4 top-1/3 h-[420px] w-[420px] bg-dark-glow opacity-40 blur-3xl" />

      <div className="relative z-10 mx-auto max-w-[1440px]">
        <div className="grid items-center gap-10 lg:grid-cols-2">
          {/* ── Left: copy ───────────────────────────────────────────── */}
          <div>
            <motion.div
              variants={fadeUp}
              initial="hidden"
              animate="show"
              custom={0}
              className="inline-flex items-center gap-2 rounded-full border border-white/[0.08] bg-white/[0.04] px-4 py-1.5 text-sm font-medium text-zinc-200"
            >
              <Rocket className="h-4 w-4 text-gold" strokeWidth={2} />
              The Next Era of Work
            </motion.div>

            <motion.h1
              variants={fadeUp}
              initial="hidden"
              animate="show"
              custom={1}
              // 700, not 900. `font-black` at 72px turned the headline into a
              // solid slab — the counters close up, the descenders crowd, and it
              // shouted over the logo above it. The type scale tops out at 700
              // for display for exactly this reason.
              // 64 at the top end, the documented Display step. 72 overflowed
              // the hero column into four lines and stranded "limits." on its
              // own — a headline that big stops being emphasis and starts being
              // a layout problem.
              className="mt-6 text-[40px] font-bold leading-[1.05] tracking-tight text-white sm:text-[52px] lg:text-[54px]"
            >
              Build your AI workforce.
              <br />
              Grow{' '}
              <span className="bg-gradient-to-r from-violet to-violet-secondary bg-clip-text text-transparent">
                without limits.
              </span>
            </motion.h1>

            <motion.p
              variants={fadeUp}
              initial="hidden"
              animate="show"
              custom={2}
              className="mt-6 max-w-xl text-lg leading-relaxed text-zinc-400"
            >
              Hire AI employees that think, act and deliver results. Manage them, train them and let
              them handle the work — while you focus on growth.
            </motion.p>

            <motion.div variants={fadeUp} initial="hidden" animate="show" custom={3} className="mt-8 flex flex-wrap items-center gap-4">
              <Link
                href="/register"
                className="rounded-full bg-violet px-6 py-3.5 text-[15px] font-semibold text-white shadow-[0_0_30px_-6px_rgba(94,60,232,0.6)] transition-transform hover:scale-[1.03] hover:bg-violet-hover"
              >
                Hire AI Employee
              </Link>
              <Link
                href="/demo"
                className="flex items-center gap-2 rounded-full border border-white/[0.12] bg-white/[0.04] px-6 py-3.5 text-[15px] font-semibold text-white transition-colors hover:bg-white/[0.08]"
              >
                <Play className="h-4 w-4" strokeWidth={2} fill="currentColor" />
                Watch Demo
              </Link>
            </motion.div>
          </div>

          {/* ── Right: in-hero auto-looping product explainer ────────── */}
          <motion.div
            initial={{ opacity: 0, scale: 0.94 }}
            animate={{ opacity: 1, scale: 1 }}
            transition={{ duration: 0.8, delay: 0.2, ease: [0.22, 1, 0.36, 1] }}
            className="relative mx-auto h-[520px] w-full max-w-[600px] lg:h-[560px]"
          >
            <HeroDemo className="absolute inset-0" />
          </motion.div>
        </div>

        {/* ── Trusted-by logo row ──────────────────────────────────── */}
        <motion.div
          variants={fadeUp}
          initial="hidden"
          animate="show"
          custom={4}
          className="mt-20 text-center"
        >
          <p className="text-sm font-medium text-fg-muted">Trusted by forward-thinking companies</p>
          <div className="mt-6 flex flex-wrap items-center justify-center gap-x-12 gap-y-4 opacity-70 grayscale">
            {LOGOS.map((logo) => (
              <span key={logo} className="text-xl font-semibold text-zinc-300">
                {logo}
              </span>
            ))}
          </div>
        </motion.div>

        {/* ── Stats bar ────────────────────────────────────────────── */}
        <motion.div
          variants={fadeUp}
          initial="hidden"
          animate="show"
          custom={5}
          className="mt-10 grid grid-cols-2 gap-8 rounded-dark-lg border border-white/[0.08] bg-white/[0.03] p-8 backdrop-blur-xl sm:grid-cols-4"
        >
          {STATS.map(([value, label]) => (
            <div key={label} className="text-center">
              <p className="bg-gradient-to-r from-violet to-violet-secondary bg-clip-text text-3xl font-extrabold text-transparent sm:text-4xl">
                {value}
              </p>
              <p className="mt-1.5 text-sm text-zinc-400">{label}</p>
            </div>
          ))}
        </motion.div>
      </div>
    </section>
  );
}
