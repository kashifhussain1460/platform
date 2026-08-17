/**
 * Shared Tailwind preset for V-AEP — "The Workforce Ledger" design system.
 * Swiss-editorial on warm paper: one indigo structural accent + a strictly
 * rationed warm accent reserved for the two human moments (Hire, Approval).
 * Everything is system-font + stroke-SVG + pure CSS so it prints crisp with
 * zero external assets. Apps reference this via `presets: [require('@vaep/config/tailwind')]`.
 *
 * @type {import('tailwindcss').Config}
 */
module.exports = {
  theme: {
    extend: {
      colors: {
        // Paper & surface — never pure white for the canvas.
        paper: { DEFAULT: '#FAFAF8', 2: '#F4F3EE' },
        surface: '#FFFFFF',
        // Ink — never #000.
        ink: { DEFAULT: '#14151A', 70: '#4A4B54', 40: '#8A8B92', 25: '#B8B7B0' },
        // Warm-grey hairlines so seams align.
        line: { DEFAULT: '#E5E4DD', strong: '#D6D5CC' },
        // Indigo — the ONE structural accent (existing brand, extended).
        brand: {
          50: '#eef2ff',
          100: '#e0e7ff',
          500: '#6366f1',
          600: '#4f46e5',
          700: '#4338ca',
          900: '#312e81',
        },
        // Warm human accent — ONLY on Hire + Approval moments.
        warm: { 100: '#FFF1E6', 400: '#FF9A62', 500: '#F97316' },
        amber: { 300: '#FCD34D' }, // approval "pending" pip + rating stars only
        coral: { 400: '#FB7185' }, // decline/hold half of an approval pair only
        // Success / live.
        mint: { 300: '#6EE7B7', 400: '#34D399', 500: '#10B981' },
        // One inverted spread (Approvals & Security).
        midnight: { DEFAULT: '#0E1020', 2: '#171933' },

        // ── The signed-in app: dark sidebar, LIGHT content.
        //
        // A cool near-white, not the warm `paper` scale above — the app reads as
        // a workspace beside a dark rail, and warm paper next to violet goes
        // muddy. Every step below is measured against every surface it is used
        // on, so a label cannot quietly fail on the raised card it lands in:
        //
        //            canvas    card    raised
        //   ink      17.29    18.32    16.57
        //   ink-2     8.15     8.63     7.81
        //   ink-3     4.91     5.20     4.70
        //   ink-4     3.19     3.37     3.05  ← below AA on purpose: placeholder
        //                                       and disabled only, never content
        app: {
          bg: '#F8F8FC',
          surface: '#FFFFFF',
          raised: '#F3F3F9',
          tint: '#F4F2FF', // violet-tinted panel (the "build it yourself" strip)
          border: '#E8E8F0',
          'border-strong': '#D9D9E5',
          ink: '#14141C',
          'ink-2': '#4A4A5E',
          'ink-3': '#6B6B80',
          'ink-4': '#8A8AA0',
        },

        // ── Foreground scale for the DARK product surfaces.
        //
        // Measured, not chosen by eye. The app is dark everywhere, and it was
        // using `zinc-500` (#71717A) and `zinc-600` (#52525B) as its muted text:
        // on the near-black canvas those come out at 4.19 and 2.62, so the
        // smaller of the two failed WCAG AA outright and the larger missed the
        // 4.5 body threshold on every single screen. A browser sweep found 66
        // failures across 11 pages from those two utilities alone.
        //
        // Each step below clears AA on the darkest surface (#05060A) AND on the
        // lightest card (#171A26), so a muted label stays readable wherever a
        // card happens to sit:
        //   muted    #9CA3AF → 7.98 / 6.82
        //   subtle   #8B8B94 → 6.00 / 5.13
        //   disabled #6B7280 → 4.19 (deliberately below AA; WCAG exempts
        //            disabled controls, and it must read as unavailable)
        fg: {
          DEFAULT: '#FFFFFF',
          secondary: '#D1D5DB',
          muted: '#9CA3AF',
          subtle: '#8B8B94',
          disabled: '#6B7280',
        },

        // ── Dark/violet marketing palette — pixel-sampled from the reference
        // mockup (not the earlier LayoutConfig.json guess, which ran slightly
        // magenta/light). Scoped, non-colliding names — used ONLY by the dark
        // marketing sections, kept separate from the Workforce Ledger tokens.
        void: { DEFAULT: '#030408', section: '#0C0E14', card: '#0F1017', 'card-hover': '#171923' },
        // `bright` is for text sitting on a violet TINT (`bg-violet/20`) over a
        // dark surface — the tint lifts the backdrop enough that `secondary`
        // drops to ~4.1, just under AA. On plain dark, `secondary` is still the
        // right step; this is only for the chip case.
        violet: {
          DEFAULT: '#5E3CE8',
          hover: '#7659F0',
          secondary: '#8B6EF2',
          bright: '#B7A2F8',
          accent: '#6D3FE0',
        },
        gold: { DEFAULT: '#F0B90D' }, // badge rocket + star-rating accent only

        // ── Workflow Builder tokens (doc 29). Dark, violet-accented; built on the
        // `void`/`violet`/`gold` scales above. Scoped names, no collision with the
        // light "Workforce Ledger" theme. Node categories: saturation encodes how
        // much a human should care (employee+approval warmest → machinery = slate).
        canvas: { DEFAULT: '#02030A', grid: '#0B0E18' },
        cat: {
          employee: '#8B6EF2', // AI Employee (the signature "person" node)
          trigger: '#22D3EE', // entry
          approval: '#F0B90D', // human gate
          tool: '#2DD4BF', // skill / action
          knowledge: '#818CF8', // retrieve
          memory: '#A78BFA', // remember / recall
          logic: '#94A3B8', // control flow
          data: '#64748B', // variables / transform
          util: '#475569', // timing / no-op
        },
        // Run + step statuses (never colour alone — always paired with an icon/shape).
        status: {
          pending: '#94A3B8',
          running: '#8B6EF2',
          waiting: '#F0B90D',
          // Author-time problem (a step that cannot run as configured) — distinct
          // in MEANING from `waiting`, which is a run-time state, even though the
          // two share a hue. Kept separate so either can be retuned alone.
          warning: '#F0B90D',
          succeeded: '#34D399',
          failed: '#F87171',
          cancelled: '#64748B',
          escalated: '#FB923C',
          expired: '#6B7280',
        },
        // Status text on a LIGHT surface. The `status` scale above was picked
        // against a near-black canvas and does not survive the move: on white,
        // succeeded lands at 1.85, waiting 1.93, escalated 2.50, pending 2.70,
        // running 3.62 and failed 3.14 — every one under AA for text. These are
        // the same meanings re-picked for white (all ≥ 4.5), and they stay a
        // separate group so the dark builder canvas keeps the original hues.
        //   pending 7.53 · running 6.39 · waiting 6.34 · warning 6.34
        //   succeeded 5.48 · failed 4.83 · cancelled 5.02 · escalated 5.31
        //   expired 5.20
        sl: {
          pending: '#475569',
          running: '#5E3CE8',
          waiting: '#92400E',
          warning: '#92400E',
          succeeded: '#047857',
          failed: '#DC2626',
          cancelled: '#64748B',
          escalated: '#C2410C',
          expired: '#6B7280',
        },
        edge: {
          idle: 'rgba(255,255,255,0.16)',
          hover: '#7659F0',
          live: '#8B6EF2',
          invalid: '#F87171',
          pending: 'rgba(139,110,242,0.6)',
        },
        // Builder text/border/feedback (dark surfaces).
        wf: {
          ink: '#F5F6FA',
          'ink-2': '#A6ADBB',
          // Was #6B7280 — 4.19 on the canvas and 3.58 on a raised node, so node
          // meta ("2 steps", "last run") sat under AA on the very screen people
          // read most closely. Matched to `fg.muted`.
          'ink-3': '#9CA3AF',
          hairline: 'rgba(255,255,255,0.07)',
          'hairline-hover': 'rgba(255,255,255,0.14)',
          focus: '#8B6EF2',
          ok: '#34D399',
          error: '#F87171',
        },
      },
      fontFamily: {
        sans: [
          'Helvetica Neue',
          'Helvetica',
          'Arial',
          'Segoe UI',
          'Roboto',
          'system-ui',
          '-apple-system',
          'sans-serif',
        ],
        // Workflow Builder display face (doc 29) — Space Grotesk carries the
        // "software with a personality" tone on node/employee names + panel titles.
        // Wired via next/font (CSS var); falls back to the system stack.
        display: [
          'var(--font-space-grotesk)',
          'Space Grotesk',
          'Segoe UI',
          'system-ui',
          'sans-serif',
        ],
        mono: [
          'var(--font-jetbrains-mono)',
          'JetBrains Mono',
          'ui-monospace',
          'SF Mono',
          'Cascadia Code',
          'Roboto Mono',
          'Menlo',
          'Consolas',
          'monospace',
        ],
      },
      letterSpacing: { kicker: '0.14em', tightest: '-0.035em' },
      borderRadius: { card: '6px', btn: '8px', node: '14px', 'dark-lg': '24px', 'dark-btn': '16px' },
      maxWidth: { container: '1200px', prose: '640px' },
      boxShadow: {
        card: '0 1px 0 #E5E4DD, 0 12px 32px -16px rgba(20,21,26,0.10)',
        lift: '0 1px 0 #D6D5CC, 0 22px 44px -20px rgba(20,21,26,0.14)',
        cta: '0 10px 30px -10px rgba(79,70,229,0.45)',
        warm: '0 10px 30px -12px rgba(255,154,98,0.40)',
        'dark-card': '0 10px 40px rgba(0,0,0,.45)',
      },
      backgroundImage: {
        'g-cta': 'linear-gradient(100deg,#4F46E5,#6366F1)',
        'g-hero-wash': 'linear-gradient(165deg,#FAFAF8 0%,#EEF2FF 55%,#FFF1E6 100%)',
        'dark-hero': 'linear-gradient(180deg,#05060A 0%,#0B0B13 60%,#05060A 100%)',
        'dark-cta': 'linear-gradient(135deg,#7C3AED,#9333EA)',
        'dark-glow': 'radial-gradient(circle,rgba(124,58,237,.35),transparent 70%)',
      },
      keyframes: {
        flow: { to: { strokeDashoffset: '-44' } },
        breathe: {
          '0%,100%': { opacity: '.35', transform: 'scale(1)' },
          '50%': { opacity: '.9', transform: 'scale(1.04)' },
        },
        rise: {
          from: { opacity: '0', transform: 'translateY(16px)' },
          to: { opacity: '1', transform: 'none' },
        },
        riseL: {
          from: { opacity: '0', transform: 'translateX(-24px)' },
          to: { opacity: '1', transform: 'none' },
        },
        riseR: {
          from: { opacity: '0', transform: 'translateX(24px)' },
          to: { opacity: '1', transform: 'none' },
        },
        ripple: {
          from: { transform: 'scale(0)', opacity: '.6' },
          to: { transform: 'scale(2.4)', opacity: '0' },
        },
        pulseDot: {
          '0%,100%': { boxShadow: '0 0 0 0 rgba(52,211,153,.5)' },
          '50%': { boxShadow: '0 0 0 6px rgba(52,211,153,0)' },
        },
        gridDrift: { to: { transform: 'translateY(-24px)' } },
        drawIn: { to: { strokeDashoffset: '0' } },
        twinkle: {
          '0%,100%': { opacity: '.6', transform: 'scale(.9)' },
          '50%': { opacity: '1', transform: 'scale(1.1)' },
        },
        spinSlow: { to: { transform: 'rotate(360deg)' } },
        floatY: {
          '0%,100%': { transform: 'translateY(0)' },
          '50%': { transform: 'translateY(-10px)' },
        },
        glowPulse: {
          '0%,100%': { opacity: '.55' },
          '50%': { opacity: '1' },
        },
      },
      animation: {
        flow: 'flow 2.4s linear infinite',
        breathe: 'breathe 3.6s ease-in-out infinite',
        rise: 'rise .48s cubic-bezier(.22,1,.36,1) both',
        ripple: 'ripple 4s ease-out infinite',
        pulseDot: 'pulseDot 2.4s ease-in-out infinite',
        gridDrift: 'gridDrift 40s linear infinite alternate',
        twinkle: 'twinkle 2.5s ease-in-out infinite',
        'spin-slow': 'spinSlow 40s linear infinite',
        float: 'floatY 4.5s ease-in-out infinite',
        'glow-pulse': 'glowPulse 3.2s ease-in-out infinite',
      },
      transitionTimingFunction: { swiss: 'cubic-bezier(.22,1,.36,1)' },
    },
  },
  plugins: [],
};
