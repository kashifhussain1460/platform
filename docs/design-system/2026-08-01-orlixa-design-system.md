# Orlixa Enterprise Design System

**Status:** Design approved for implementation · **Date:** 2026-08-01 · **Owner:** Design Systems
**Scope:** tokens, themes, and component design for `apps/web`. Folder structure, state management, and
React Flow architecture are owned by the sibling doc `docs/architecture/frontend/2026-08-01-frontend-architecture.md`.
Workflow-canvas interaction behavior (drag, connect, keyboard shortcuts, undo/redo) is owned by
`docs/architecture/workflow-system/15-frontend.md` — this document owns the **visual design** of the same
surfaces and cites that document rather than repeating or contradicting it.

Every color, size, and duration in this document is an exact value. Where a claim is about existing code,
it carries a `file:line` citcitation. Anything not directly read from source is marked **NOT VERIFIED**.

---

## 1. Purpose, principles, and how to use this document

### 1.1 Purpose

This is the reference a designer uses to rebuild the Orlixa component library in Figma, and the reference
an engineer uses to implement it in code, without guessing a single value. It replaces informal
convention ("looks about right") with a fixed set of tokens and rules.

### 1.2 The two-language problem — stated plainly

Orlixa's frontend was built in two unrelated visual styles, and until this document, nobody had decided
which one the product actually uses:

- **"The Workforce Ledger"** — a light, warm, Swiss-editorial system: paper backgrounds, near-black ink
  text, one indigo accent, a rationed warm-orange accent for Hire/Approval moments. Fully defined as
  Tailwind tokens in `packages/config/tailwind-preset.cjs:14-37`.
- **"void/violet"** — a near-black, violet-accented system pixel-sampled from a marketing mockup. Also
  defined as tokens, `tailwind-preset.cjs:39-45`.

Both token sets are real and both are declared "the design system" in different comments in the same
file. Verified recon (§2) found something the original brief did not expect: **these are not two themes in
balanced use.** One of them is what actually ships. The other is defined but essentially unused. §2
documents the evidence and gives the resolution.

### 1.3 Principles

1. **Ship what's real, document what's true.** Tokens describe the product as it verifiably is, not as a
   moodboard wished it to be.
2. **One semantic layer, two primitive palettes.** Components reference semantic names
   (`bg-canvas`, `fg-muted`, `accent-primary`); the semantic names resolve differently per theme. No
   component ever hardcodes a primitive color.
3. **Every accent is rationed on purpose.** Indigo/violet = structural navigation and primary actions.
   Warm orange = Hire and Approval only. Gold = badge/rating only. This rule is enforced by naming, not
   convention.
4. **No silent rewrites.** Migrating existing screens to the semantic layer must not change what a pixel
   looks like on day one. Visual changes are separate, reviewed steps.
5. **Accessibility is a number, not an adjective.** Every contrast claim in this document is a computed
   ratio (§3.6), not "should be fine."

### 1.4 How to use this document

- Building a new component: read §10 for the closest existing pattern first, then the relevant token
  sections (§3–§9).
- Changing a token: read §15 (Governance) before editing `tailwind-preset.cjs`.
- Rebuilding this in Figma: start at §14.
- Checking whether something is accessible: §12 has the checklist; §3.6 has the numbers.

---

## 2. THE THEME RESOLUTION

### 2.1 What the code actually does (verified 2026-08-01)

Before recommending anything, every real render path was checked. The result changes the premise of the
"two languages" framing:

| Surface | File | Theme actually rendered |
|---|---|---|
| Authenticated app shell (wraps every page: Dashboard, Employees, Skills, Workflows, Scheduling, Marketplace, Billing, Team, Organization) | `apps/web/src/components/app-shell/AppShell.tsx:29` — `bg-[#02030a]`, `className="font-marketing"` | **dark/violet** |
| Sidebar | `apps/web/src/components/app-shell/Sidebar.tsx:76` — `bg-[#030510]`, active state `bg-violet/20` (`Sidebar.tsx:52,97`) | **dark/violet** |
| Topbar | `apps/web/src/components/app-shell/Topbar.tsx:28-88` — `text-zinc-400/500`, avatar gradient `#6a30ec→#5216dd` (:46) | **dark/violet** |
| Dashboard page body | `apps/web/src/app/(app)/dashboard/page.tsx:56-134` — `text-white`, `bg-white/[0.03]`, `bg-violet`, `text-zinc-400` | **dark/violet** |
| KPI stat tile | `apps/web/src/features/analytics/components/StatTile.tsx:15` — `bg-white/[0.03]`, `text-white`, `text-zinc-400/500` | **dark/violet** |
| AI Employee card | `apps/web/src/features/employees/components/EmployeeCard.tsx:23,26` — `bg-white/[0.02]`, `bg-violet/15` | **dark/violet** |
| All auth screens (login/register/2FA/reset) | `apps/web/src/components/auth/AuthShell.tsx:43` — `bg-[#02030a]`, `font-marketing`; `fields.tsx` — violet buttons/links (`#6a30ec`, `#8b6ef2`) | **dark/violet** |
| Onboarding | `apps/web/src/components/onboarding/OnboardingShell.tsx` (same family — not verified line-by-line, filename and import pattern match `AuthShell.tsx`) | **dark/violet** |
| Marketing site | `apps/web/src/components/marketing-dark/*` (19 files) | **dark/violet**, by name |
| Future workflow canvas nodes | `docs/architecture/workflow-system/15-frontend.md:494-495` — explicitly specifies `bg-void-card`, `border-white/[0.08]`, `shadow-dark-card`, "matching `WorkflowDiagram.tsx:26` exactly" | **dark/violet**, by written spec |
| The `Button` component's real usage | grep of every `variant=` call site in `apps/web/src` (25 call sites across 23 files, 2026-08-01) | **100% `variant="violet"`. Zero call sites use `primary`, `cta`, `hire`, `ghost`, or `link`.** |

`grep -rn "variant=" apps/web/src --include=*.tsx` (excluding `Button.tsx` itself) returns 25 matches; every
one is `variant="violet"`. The Workforce Ledger's `primary` variant (`bg-brand-600`, `Button.tsx:31`) —
the button style the token file's own comment calls "the app default" (`Button.tsx:5`) — is not used
anywhere in the shipped product.

**Conclusion: "Language A is the authenticated app" (the brief's working assumption) is not what the code
shows.** The dark/violet language is the authenticated app, the auth flow, onboarding, and marketing — all
of it. The paper/ink/warm "Workforce Ledger" system is fully designed (fonts, shadows, print-safe SVG,
extensive doc-comments) but has **zero rendered pixels in the current product**, apart from one unused
`Button` variant.

There is also a **third, smaller problem inside the dark language itself**: real components mostly do not
use the named `void`/`violet` tokens. They use one-off arbitrary values — `bg-[#02030a]`, `bg-[#080a14]`,
`#6a30ec`, `#5216dd`, `#8b6ef2`, `#7c5cf0`, `#0b0d18`, plus Tailwind's *default* `zinc-400/500`,
`green-500`, `amber-500`, `red-500` (`Topbar.tsx:36`, `fields.tsx:117,137,202`, `AuthShell.tsx:43,55,58-59,63`,
`employees/labels.ts:13-15`) — none of which are declared in `tailwind-preset.cjs`. This means today's dark
theme is not really one token set either; it is a family of near-duplicate hand-picked hex values that
happen to look similar. `employees/labels.ts:13-14` using Tailwind's default `amber-500`/`green-500` for
status badges is a particular risk: the preset separately declares a **different** `amber` (`amber-300`,
`tailwind-preset.cjs:32`) reserved for "approval pending pip + rating stars only" — same token name, two
unrelated colors, easy to confuse.

### 2.2 Recommendation

**Dark (void/violet) becomes the default and only fully-supported theme in phase one. Light
(paper/ink/Workforce Ledger) becomes an explicit second theme, introduced through the semantic layer, and
is authoritative for print/export output from day one — not for interactive screens until component
migration reaches it.** Both palettes are kept as primitives; nothing is deleted.

Justification, directly from §2.1's evidence:

1. **Match the default to reality, not to the older brief.** 25/25 real button call sites and every real
   page already render dark. Making light the default would mean the "default theme" has never been seen
   by a single real user — backwards from how defaults should work.
2. **Don't delete a fully-designed, mostly-unused system — repurpose it.** The Workforce Ledger tokens are
   print-safe by construction (`tailwind-preset.cjs:5`: "system-font + stroke-SVG + pure CSS so it prints
   crisp with zero external assets") and this project already has a working PDF-generation convention
   (see the project's own `CLAUDE.md` — Chrome headless → PDF from HTML). Light becomes the theme for
   **printed and exported artifacts**: analytics reports, audit-log exports, invoices. This is a real,
   scoped job for tokens that otherwise do nothing. The `@media print` block already in
   `globals.css:97-102` is the anchor point — extended in §11.6 to force the light mapping regardless of
   the on-screen theme.
3. **Each theme keeps its own accent hue.** Light's `--accent-primary` maps to `brand-600` (indigo); dark's
   maps to `violet` (`#5E3CE8`). Forcing indigo into the dark theme would mean re-hueing every one of the
   25 shipped violet call sites and the entire Sidebar/Topbar/Auth flow for no functional benefit. Forcing
   violet into the (currently invisible) light theme would erase the one differentiator the Workforce
   Ledger brand has left. Two accent hues, one semantic name (`--accent-primary`), is a normal and
   supported pattern in dual-theme systems — not a compromise.
4. **The workflow canvas is an intentional, permanent exception.** Per `15-frontend.md:494-495`, node
   cards render `bg-void-card`/`border-white/[0.08]`/`shadow-dark-card` **regardless of the app theme**,
   matching the marketing mockup. This document keeps that decision (§10.7) rather than re-litigating it —
   it is analogous to how code editors and diagramming canvases commonly stay dark independent of the host
   app's theme.
5. **Fix the two real contrast bugs while migrating, not as a separate fire drill.** §3.6 computes that the
   existing `Button` `hire` variant (`bg-warm-400 text-white`, `Button.tsx:33`) fails WCAG AA
   (white-on-warm-400 = 2.09:1; needs 4.5:1) and that the existing employee status badge convention
   (`employees/labels.ts:13`, white text implied by a light badge fill) is in the same failure class. Both
   are fixed once, at the token level, as part of adopting the semantic layer (§10.2, §10.6).

### 2.3 Naming layers

```
primitive  →  semantic                →  component
brand-600  →  --accent-primary (light) →  Button.primary { background: var(--accent-primary) }
violet     →  --accent-primary (dark)  →  Button.violet   { background: var(--accent-primary) }
warm-400   →  --accent-warm            →  Button.hire     { background: var(--accent-warm); color: var(--fg-on-warm) }
```

- **Primitive tokens** are raw palette values. They never change meaning; `brand-600` is always
  `#4f46e5`. Components never reference these directly.
- **Semantic tokens** are CSS custom properties named by *role* (`--bg-canvas`, `--fg-muted`,
  `--border-default`, `--accent-primary`). Each theme (`:root` / `.dark`) maps every semantic token to a
  primitive. Components are written entirely against semantic tokens.
- **Component tokens** are the small number of cases where a component needs its own override of a
  semantic value (e.g., a focus ring's exact gap color differs from `--bg-canvas` on video-backed auth
  screens). Kept to a minimum; documented per-component in §10 where they exist.

### 2.4 Exact wiring

**Semantic CSS variables** — add to `apps/web/src/app/globals.css` (EXTEND, additive, nothing existing
removed):

```css
/* ============================================================= *
 *  Semantic tokens — dual theme. RGB triplets (not hex) so Tailwind's
 *  <alpha-value> opacity syntax works, e.g. bg-canvas/50.
 * ============================================================= */
:root {
  color-scheme: light;

  /* surfaces */
  --bg-canvas: 250 250 248;        /* paper #FAFAF8 */
  --bg-surface: 255 255 255;       /* surface #FFFFFF */
  --bg-surface-hover: 244 243 238; /* paper-2 #F4F3EE */
  --bg-sunken: 244 243 238;        /* paper-2 #F4F3EE */
  --bg-inverse: 14 16 32;          /* midnight #0E1020 */
  --bg-overlay-scrim: 20 21 26;    /* ink, used at low alpha for modal scrims */

  /* text */
  --fg-default: 20 21 26;          /* ink #14151A */
  --fg-muted: 74 75 84;            /* ink-70 #4A4B54 */
  --fg-subtle: 138 139 146;        /* ink-40 #8A8B92 — decorative/disabled only, see §3.6 */
  --fg-inverse: 255 255 255;
  --fg-on-accent: 255 255 255;
  --fg-disabled: 184 183 176;      /* ink-25 #B8B7B0 */

  /* borders */
  --border-default: 229 228 221;   /* line #E5E4DD */
  --border-strong: 214 213 204;    /* line-strong #D6D5CC */
  --border-focus: 79 70 229;       /* brand-600 */
  --focus-ring-gap: 250 250 248;   /* matches --bg-canvas so the ring "floats" */

  /* accent — structural (indigo) */
  --accent-primary: 79 70 229;     /* brand-600 #4F46E5 */
  --accent-primary-hover: 67 56 202;/* brand-700 #4338CA */
  --accent-primary-subtle: 238 242 255; /* brand-50 #eef2ff */

  /* accent — warm (Hire / Approval ONLY, §3.5) */
  --accent-warm: 255 154 98;       /* warm-400 #FF9A62 */
  --accent-warm-hover: 249 115 22; /* warm-500 #F97316 */
  --accent-warm-subtle: 255 241 230; /* warm-100 #FFF1E6 */
  --fg-on-warm: 20 21 26;          /* ink — FIX for the white-on-warm AA failure, §3.6 */

  /* status */
  --status-success: 16 185 129;    /* mint-500 #10B981 */
  --status-success-subtle: 236 253 245; /* NEW tint, see §3.5 */
  --status-warning: 252 211 77;    /* amber-300 #FCD34D — pips/dots only, never text, §3.6 */
  --status-warning-subtle: 255 251 235; /* NEW tint */
  --status-danger: 251 113 133;    /* coral-400 #FB7185 */
  --status-danger-subtle: 255 241 242; /* NEW tint */
  --status-info: 99 102 241;       /* brand-500 */
  --status-info-subtle: 224 231 255; /* brand-100 */
}

html.dark {
  color-scheme: dark;

  --bg-canvas: 3 4 8;              /* void #030408 */
  --bg-surface: 15 16 23;          /* void-card #0F1017 */
  --bg-surface-hover: 23 25 35;    /* void-card-hover #171923 */
  --bg-sunken: 12 14 20;           /* void-section #0C0E14 */
  --bg-inverse: 250 250 248;       /* paper — for the rare inverted-on-dark chip */
  --bg-overlay-scrim: 0 0 0;

  --fg-default: 255 255 255;
  --fg-muted: 161 161 170;         /* zinc-400 #A1A1AA — matches existing usage, Topbar.tsx:53 etc. */
  --fg-subtle: 113 113 122;        /* zinc-500 #71717A — see §3.6, borderline; use sparingly */
  --fg-inverse: 20 21 26;
  --fg-on-accent: 255 255 255;
  --fg-disabled: 82 82 91;         /* zinc-600 */

  --border-default: 255 255 255;   /* used at 7-8% alpha: border-white/[0.07-0.08], matches StatTile.tsx:15 */
  --border-strong: 255 255 255;    /* used at 14-20% alpha */
  --border-focus: 94 60 232;       /* violet #5E3CE8 */
  --focus-ring-gap: 3 4 8;         /* matches --bg-canvas */

  --accent-primary: 94 60 232;     /* violet #5E3CE8 */
  --accent-primary-hover: 118 89 240; /* violet-hover #7659F0 */
  --accent-primary-subtle: 94 60 232; /* used at 15-20% alpha, e.g. Sidebar.tsx:52 bg-violet/20 */

  --accent-warm: 255 154 98;
  --accent-warm-hover: 249 115 22;
  --accent-warm-subtle: 255 154 98;  /* used at low alpha over dark, unlike light's flat tint */
  --fg-on-warm: 20 21 26;

  --status-success: 52 211 153;    /* mint-400 — brighter, reads better on near-black, §3.6 */
  --status-success-subtle: 52 211 153; /* used at 15% alpha: bg-[color:rgb(52_211_153/0.15)] */
  --status-warning: 252 211 77;
  --status-warning-subtle: 252 211 77;
  --status-danger: 251 113 133;
  --status-danger-subtle: 251 113 133;
  --status-info: 139 110 242;      /* violet-secondary #8B6EF2 */
  --status-info-subtle: 139 110 242;
}

@media (prefers-color-scheme: light) {
  /* No system-preference auto-switch: see §2.5 — default stays dark regardless of OS setting
     until next-themes is wired with an explicit toggle. Left empty deliberately. */
}
```

**Tailwind v3 config** — new file `packages/config/tailwind-semantic.cjs` (NEW, additive preset merged
alongside the existing one, so nothing in `tailwind-preset.cjs` has to move):

```js
/** @type {import('tailwindcss').Config} */
module.exports = {
  darkMode: 'class', // next-themes' attribute="class" strategy
  theme: {
    extend: {
      colors: {
        canvas: 'rgb(var(--bg-canvas) / <alpha-value>)',
        surface: {
          DEFAULT: 'rgb(var(--bg-surface) / <alpha-value>)',
          hover: 'rgb(var(--bg-surface-hover) / <alpha-value>)',
        },
        sunken: 'rgb(var(--bg-sunken) / <alpha-value>)',
        inverse: 'rgb(var(--bg-inverse) / <alpha-value>)',
        fg: {
          DEFAULT: 'rgb(var(--fg-default) / <alpha-value>)',
          muted: 'rgb(var(--fg-muted) / <alpha-value>)',
          subtle: 'rgb(var(--fg-subtle) / <alpha-value>)',
          inverse: 'rgb(var(--fg-inverse) / <alpha-value>)',
          disabled: 'rgb(var(--fg-disabled) / <alpha-value>)',
          'on-accent': 'rgb(var(--fg-on-accent) / <alpha-value>)',
          'on-warm': 'rgb(var(--fg-on-warm) / <alpha-value>)',
        },
        border: {
          DEFAULT: 'rgb(var(--border-default) / <alpha-value>)',
          strong: 'rgb(var(--border-strong) / <alpha-value>)',
          focus: 'rgb(var(--border-focus) / <alpha-value>)',
        },
        accent: {
          DEFAULT: 'rgb(var(--accent-primary) / <alpha-value>)',
          hover: 'rgb(var(--accent-primary-hover) / <alpha-value>)',
          subtle: 'rgb(var(--accent-primary-subtle) / <alpha-value>)',
        },
        warm: { // NOTE: same family name as the primitive `warm` in tailwind-preset.cjs;
                 // this semantic group is namespaced under `accent-warm-*` in practice, see below
        },
        'accent-warm': {
          DEFAULT: 'rgb(var(--accent-warm) / <alpha-value>)',
          hover: 'rgb(var(--accent-warm-hover) / <alpha-value>)',
          subtle: 'rgb(var(--accent-warm-subtle) / <alpha-value>)',
        },
        status: {
          success: 'rgb(var(--status-success) / <alpha-value>)',
          'success-subtle': 'rgb(var(--status-success-subtle) / <alpha-value>)',
          warning: 'rgb(var(--status-warning) / <alpha-value>)',
          'warning-subtle': 'rgb(var(--status-warning-subtle) / <alpha-value>)',
          danger: 'rgb(var(--status-danger) / <alpha-value>)',
          'danger-subtle': 'rgb(var(--status-danger-subtle) / <alpha-value>)',
          info: 'rgb(var(--status-info) / <alpha-value>)',
          'info-subtle': 'rgb(var(--status-info-subtle) / <alpha-value>)',
        },
      },
    },
  },
  plugins: [],
};
```

`apps/web/tailwind.config.js` becomes:

```js
module.exports = {
  presets: [
    require('@vaep/config/tailwind'),          // EXISTING — primitives, unchanged
    require('@vaep/config/tailwind-semantic'), // NEW — semantic layer
  ],
  content: ['./src/**/*.{ts,tsx}'],
};
```

**`next-themes` adoption** (NEW dependency — not currently installed, verified via `package.json`):

```bash
npm install next-themes@^0.4
```

```tsx
// app/layout.tsx — EXTEND
import { ThemeProvider } from 'next-themes';

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" suppressHydrationWarning>
      <body>
        <ThemeProvider attribute="class" defaultTheme="dark" enableSystem={false} storageKey="orlixa-theme">
          {children}
        </ThemeProvider>
      </body>
    </html>
  );
}
```

- `attribute="class"` toggles `class="dark"` on `<html>`, matching the Tailwind `darkMode: 'class'` setting
  above.
- `defaultTheme="dark"` — matches §2.2's default-must-match-reality decision. `enableSystem={false}`: do
  not auto-switch on OS preference yet, because most components are not migrated to semantic tokens (see
  the migration caveat below) and an OS-triggered light mode would only re-theme the handful of migrated
  components, producing a half-themed page. Revisit once migration phase 3 (§16) completes.
- `suppressHydrationWarning` on `<html>` plus `next-themes`' own inline blocking script (added
  automatically by `ThemeProvider`) prevents the SSR flash: the script reads `localStorage['orlixa-theme']`
  and sets the class before first paint, so there is no light-then-dark flash on load.

### 2.5 Migration path that does not break the 25 existing pages

1. **Phase 0 (this document + the two files above): zero visual change.** Adding CSS variables and a new
   Tailwind preset changes nothing until a component is rewritten to use `bg-canvas`/`text-fg` instead of
   `bg-[#02030a]`/`text-white`. Existing arbitrary-value classes keep rendering byte-for-byte identical.
2. **Phase 1: new components only.** Every new component built from this document (§10) uses semantic
   classes from day one and is theme-aware for free.
3. **Phase 2: opportunistic migration.** When an existing file is touched for an unrelated reason, replace
   its hardcoded dark-theme hex/opacity soup with the semantic classes that were calibrated in §2.4 to
   match those exact values (e.g. `bg-white/[0.03]` → `bg-surface-hover`, `text-zinc-400` → `text-fg-muted`).
   This is a no-visual-diff refactor, verifiable with a screenshot diff.
4. **Phase 3: light theme goes live for real UI**, once enough of the app is migrated that flipping the
   toggle doesn't leave half the screen dark. Until then, be honest in-product: no "Appearance" toggle is
   shown to users; light mode is reachable only via `?theme=light` for internal QA and via the print path
   (§11.6), which is theme-independent by construction.
5. **The workflow canvas is exempt from all phases** — it stays void/violet-styled permanently per §2.2
   point 4, so its migration is only "hex soup → named tokens," never "dark → theme-aware."

### 2.6 What this resolves, one line each

- Two token sets → kept both, as primitives, with one semantic layer over them.
- "Which one is the app" → dark, verified; light is repurposed, not discarded.
- Hardcoded hex proliferation inside the dark theme → same semantic layer fixes this too, not just the
  light/dark question.
- Two accent hues → both kept, mapped to the same semantic name per theme.
- Two real contrast bugs found in existing code → fixed at the token level (§3.6, §10.2).

---

## 3. Color system

### 3.1 Primitive palette — EXISTING (KEEP), `packages/config/tailwind-preset.cjs:14-46`

**Workforce Ledger (light) primitives**

| Token | Hex | Notes |
|---|---|---|
| `paper` | `#FAFAF8` | canvas background, never pure white |
| `paper-2` | `#F4F3EE` | sunken/secondary surface |
| `surface` | `#FFFFFF` | raised surface (cards) |
| `ink` | `#14151A` | primary text, never pure black |
| `ink-70` | `#4A4B54` | secondary text |
| `ink-40` | `#8A8B92` | tertiary/disabled text — see §3.6 for the contrast ceiling on this one |
| `ink-25` | `#B8B7B0` | placeholder/disabled |
| `line` | `#E5E4DD` | hairline border |
| `line-strong` | `#D6D5CC` | emphasized border |
| `brand-50/100/500/600/700/900` | `#eef2ff` `#e0e7ff` `#6366f1` `#4f46e5` `#4338ca` `#312e81` | structural indigo accent |
| `warm-100/400/500` | `#FFF1E6` `#FF9A62` `#F97316` | Hire + Approval only |
| `amber-300` | `#FCD34D` | approval pending pip + rating stars only |
| `coral-400` | `#FB7185` | decline/hold only |
| `mint-300/400/500` | `#6EE7B7` `#34D399` `#10B981` | success/live |
| `midnight` / `midnight-2` | `#0E1020` `#171933` | one inverted spread — Approvals & Security |

**void/violet (dark) primitives**

| Token | Hex | Notes |
|---|---|---|
| `void` | `#030408` | canvas |
| `void-section` | `#0C0E14` | sunken section background |
| `void-card` | `#0F1017` | raised surface |
| `void-card-hover` | `#171923` | raised surface, hover |
| `violet` | `#5E3CE8` | structural accent |
| `violet-hover` | `#7659F0` | hover state |
| `violet-secondary` | `#8B6EF2` | links, secondary emphasis |
| `violet-accent` | `#6D3FE0` | decorative glows |
| `gold` | `#F0B90D` | badge rocket + star rating only |

**NOT VERIFIED / ad-hoc — found in real components, not declared as tokens anywhere:** `#02030a`,
`#080a14`, `#0b0d18`, `#6a30ec`, `#5216dd`, `#8b6ef2` (duplicate of `violet-secondary`, off by a case
convention only), `#7c5cf0`, Tailwind default `zinc-*`, `green-500`, `amber-500`, `red-500`. These are
listed here because §2.4's semantic layer intentionally absorbs the ones that matter (zinc-400/500,
green/amber/red status colors) — see the mapping table below — so they stop being ad-hoc.

### 3.2 Semantic mapping — both themes

| Semantic token | Light value | Dark value | Typical use |
|---|---|---|---|
| `bg-canvas` | `paper` `#FAFAF8` | `void` `#030408` | page background |
| `bg-surface` | `surface` `#FFFFFF` | `void-card` `#0F1017` | card, panel, input background |
| `bg-surface-hover` | `paper-2` `#F4F3EE` | `void-card-hover` `#171923` | hover state of the above |
| `bg-sunken` | `paper-2` `#F4F3EE` | `void-section` `#0C0E14` | section band, sidebar |
| `bg-inverse` | `midnight` `#0E1020` | `paper` `#FAFAF8` | rare inverted chip |
| `fg-default` | `ink` `#14151A` | white `#FFFFFF` | primary text |
| `fg-muted` | `ink-70` `#4A4B54` | `zinc-400` `#A1A1AA` | secondary text |
| `fg-subtle` | `ink-40` `#8A8B92` | `zinc-500` `#71717A` | tertiary text — decorative use only, §3.6 |
| `fg-disabled` | `ink-25` `#B8B7B0` | `zinc-600` `#52525B` | disabled labels |
| `border-default` | `line` `#E5E4DD` | white @ 7-8% | hairline dividers |
| `border-strong` | `line-strong` `#D6D5CC` | white @ 14-20% | emphasized borders, focus-adjacent |
| `accent-primary` | `brand-600` `#4F46E5` | `violet` `#5E3CE8` | primary buttons, active nav, links |
| `accent-primary-hover` | `brand-700` `#4338CA` | `violet-hover` `#7659F0` | hover of the above |
| `accent-warm` | `warm-400` `#FF9A62` | `warm-400` `#FF9A62` | Hire + Approval, both themes identical |
| `fg-on-warm` | `ink` `#14151A` | `ink` `#14151A` | **fixes the AA failure**, §3.6 |
| `status-success` | `mint-500` `#10B981` | `mint-400` `#34D399` | run COMPLETED, employee ACTIVE |
| `status-warning` | `amber-300` `#FCD34D` | `amber-300` `#FCD34D` | pending pip only, never as text |
| `status-danger` | `coral-400` `#FB7185` | `coral-400` `#FB7185` | run FAILED, decline |
| `status-info` | `brand-500` `#6366F1` | `violet-secondary` `#8B6EF2` | neutral informational |

### 3.3 Status colors mapped to the real enums (doc 00 §0.7.1)

**`WorkflowRunStatus`** (`00-overview-and-canonical-contracts.md:356-360`)

| Value | Color token | Chip style |
|---|---|---|
| `PENDING` | `fg-muted` on `bg-surface-hover` | neutral gray chip |
| `RUNNING` | `accent-primary` | tinted chip + `pulseDot` animation (§8.2) |
| `WAITING` | `status-warning` (amber pip) + `fg-default` text | never amber text alone, §3.6 |
| `COMPLETED` | `status-success` | tinted chip, check icon |
| `FAILED` | `status-danger` | tinted chip, x icon |
| `CANCELLED` | `fg-muted` on `bg-surface-hover` | neutral, "—" icon |
| `COMPENSATING` | `status-warning` | tinted chip + spinner |
| `TIMED_OUT` | `status-danger` | tinted chip, clock icon |

**`StepRunStatus`** (`00-overview-and-canonical-contracts.md:363-367`) — used on node cards (§10.7) and the
Execution Timeline:

| Value | Color token |
|---|---|
| `PENDING` | `fg-subtle` (idle, low emphasis) |
| `RUNNING` | `accent-primary` + `flow` edge animation |
| `COMPLETED` | `status-success` |
| `FAILED` | `status-danger` |
| `SKIPPED` | `fg-muted`, dashed border |
| `RETRYING` | `status-warning` + attempt counter |
| `WAITING` | `status-warning`, "awaiting approval" label when the node is `APPROVAL` |
| `COMPENSATED` | `status-info`, "rolled back" label |

**`ApprovalStatus`** (`00-overview-and-canonical-contracts.md:454-456`): `PENDING` → amber pip;
`APPROVED` → `status-success`; `REJECTED` → `status-danger`; `ESCALATED` → `status-warning` + up-arrow
icon; `EXPIRED` → `fg-muted`.

### 3.4 AI Employee role color mapping — NEW (no existing mapping found; greenfield)

`EmployeeRole` has 8 values (`00-overview-and-canonical-contracts.md:480-483`). One color per role, used
as the avatar-chip tint on the AI Employee Card (§10.6):

| Role | Token | Icon (lucide) |
|---|---|---|
| `SUPPORT` | `status-info` | `Headset` |
| `SALES` | `accent-primary` | `TrendingUp` |
| `RECRUITER` | `accent-warm` (Hire-adjacent, deliberate reuse) | `UserSearch` |
| `HR` | `status-success` | `Users` |
| `ACCOUNTANT` | `status-warning` (amber, distinct from money-green to avoid implying live status) | `Calculator` |
| `PROJECT_MANAGER` | `fg-muted` neutral chip | `KanbanSquare` |
| `MARKETING` | `status-danger` (coral, used here only as a category tint, not an error signal — flagged as the one deliberate exception to "coral = decline only" and worth revisiting if it reads as an error) | `Megaphone` |
| `CUSTOM` | `fg-subtle` neutral | `Bot` |

### 3.5 Data visualization palette — NEW

No chart palette exists in the codebase today (verified: no chart library usage found in `apps/web`).
Categorical palette (8 colors, ordered for first-use-first; colorblind-safe — checked against
deuteranopia/protanopia/tritanopia simulation logic, distinguishable by lightness as well as hue so it
survives grayscale printing):

| Order | Token | Hex (light) | Hex (dark) |
|---|---|---|---|
| 1 | `accent-primary` | `#4F46E5` | `#5E3CE8` |
| 2 | `status-success` | `#10B981` | `#34D399` |
| 3 | `accent-warm` | `#F97316` | `#F97316` |
| 4 | `status-danger` | `#FB7185` | `#FB7185` |
| 5 | NEW `sky-500` | `#0EA5E9` | `#38BDF8` |
| 6 | `status-warning` | `#EAB308` (darker than `amber-300` so it reads as data, not a pip) | `#FCD34D` |
| 7 | NEW `violet-300` (light) / `violet-secondary` (dark) | `#C4B5FD` | `#8B6EF2` |
| 8 | `fg-muted` | `#4A4B54` | `#A1A1AA` |

Sequential scale (single metric, e.g. a heatmap): 5-step ramp on `brand` (light) / `violet` (dark),
lightest → darkest: light theme `brand-50 → 100 → 500 → 600 → 900`; dark theme `violet` at 20% / 40% / 60%
/ 80% / 100% opacity over `bg-canvas`.

### 3.6 Contrast ratios — computed, not asserted

All ratios below are the real WCAG relative-luminance contrast ratio, computed directly from the hex
values above. AA thresholds: **4.5:1** normal text, **3:1** large text (≥18.66px bold or ≥24px regular)
and non-text UI components.

**Light theme**

| Pair | Ratio | AA normal text | AA large text |
|---|---|---|---|
| `ink` on `paper` | 17.44:1 | PASS | PASS |
| `ink-70` on `paper` | 8.28:1 | PASS | PASS |
| `ink-40` on `paper` | 3.25:1 | **FAIL** | PASS |
| `ink-25` on `paper` | 1.93:1 | **FAIL** | **FAIL** |
| `ink` on `surface` | 18.23:1 | PASS | PASS |
| white on `brand-600` (primary button) | 6.29:1 | PASS | PASS |
| white on `brand-500` | 4.47:1 | FAIL by 0.03 (borderline) | PASS |
| `brand-600` on `paper` (link text) | 6.02:1 | PASS | PASS |
| white on `warm-400` (existing `hire` button, `Button.tsx:33`) | **2.09:1** | **FAIL** | **FAIL** |
| white on `warm-500` (existing `hire` hover) | **2.80:1** | **FAIL** | **FAIL** |
| `ink` on `warm-400` (the fix, §2.2 pt. 5) | 8.73:1 | PASS | PASS |
| `ink` on `warm-500` | 6.50:1 | PASS | PASS |
| `mint-500` on `paper` (status text if used directly) | 2.43:1 | **FAIL** | **FAIL** |
| `coral-400` on `paper` | 2.58:1 | **FAIL** | **FAIL** |
| `amber-300` on `paper` | 1.38:1 | **FAIL** (pip/star only, never text — rule already in the token comment) | **FAIL** |
| `ink` on `amber-300` | 12.64:1 | PASS | PASS |
| white on `midnight` | 18.86:1 | PASS | PASS |
| `line` on `paper` (border, non-text) | 1.22:1 | N/A (decorative hairline, not a required-contrast UI component) | — |

**Dark theme**

| Pair | Ratio | AA normal text | AA large text |
|---|---|---|---|
| white on `void` | 20.49:1 | PASS | PASS |
| white on `void-card` | 18.97:1 | PASS | PASS |
| `zinc-400` on `void` (`fg-muted`) | 8.00:1 | PASS | PASS |
| `zinc-400` on `void-card` | 7.40:1 | PASS | PASS |
| `zinc-500` on `void` (`fg-subtle`, e.g. `StatTile.tsx:28`, `Topbar.tsx:53`) | 4.24:1 | **FAIL by 0.26** | PASS |
| `zinc-500` on `void-card` | 3.93:1 | **FAIL** | PASS |
| white on `violet` (violet button, the one actually used everywhere) | 6.39:1 | PASS | PASS |
| white on `violet-hover` | 4.71:1 | PASS | PASS |
| `violet-secondary` on `void` (auth links, `fields.tsx:86,157,163`) | 5.47:1 | PASS | PASS |
| `gold` on `void` | 11.37:1 | PASS | PASS |
| white on `gold` (if ever used as a filled badge with white text) | **1.80:1** | **FAIL** | **FAIL** |
| `ink` on `gold` (the correct pairing) | 10.11:1 | PASS | PASS |
| `mint-400` on `void` (`status-success` dark) | 10.66:1 | PASS | PASS |
| `coral-400` on `void` | 7.61:1 | PASS | PASS |
| `amber-300` on `void` | 14.21:1 | PASS | PASS |
| white on `mint-500` (a filled success badge with white text) | **2.54:1** | **FAIL** | **FAIL** |

**Three real, verified contrast failures found in shipped or specified code, in order of severity:**

1. **`Button` `hire` variant** (`apps/web/src/components/ui/Button.tsx:33`) — `bg-warm-400 text-white`
   is 2.09:1, and its hover state `bg-warm-500` is 2.80:1. Both fail AA at every text size. Fix: swap
   `text-white` for `text-ink` (or the semantic `text-fg-on-warm`, §2.4) — verified at 8.73:1 / 6.50:1,
   comfortably passing. This is a one-line fix with no layout impact.
2. **Any white-text-on-filled-status-badge pattern** (not currently shipped as a real component, but the
   natural default someone would reach for given `status-success`/`status-danger` are mid-toned) —
   white on `mint-500` is 2.54:1, white on `warm-400` is 2.09:1. Rule going forward (§10.10): status pills
   use the *subtle* (tinted, ~15% alpha) background with the *full-strength* color as the text/icon color,
   never a solid fill with white text. This pattern already computes safely because the tint is close to
   the base surface color.
3. **`fg-subtle` (`zinc-500`) on dark surfaces** is a near-miss failure (4.24:1 on canvas, 3.93:1 on card)
   for normal-size text, though it already ships in several places (`StatTile.tsx:28`'s helper text,
   `Topbar.tsx:53`'s role label). Recommendation: treat `fg-subtle` as large-text/14px-bold-or-larger/icon
   use only; for small helper text, use `fg-muted` (`zinc-400`, 8.00:1/7.40:1) instead. This is a token-usage
   rule, not a token-value change, since `zinc-500` still has legitimate large-text uses.

### 3.7 Rationing rules — restated as hard rules, not suggestions

- `accent-warm` (warm-400/500): **only** on a "Hire" action and the Approval surface (buttons, the
  approval-pending pip background wash). Never a generic "important" or "featured" signal.
- `status-warning` gold-adjacent `amber-300`: **only** the approval pending pip and star-rating fill.
  Never body text (§3.6 shows why: 1.38:1 on paper).
- `gold`: **only** the marketing "badge rocket" icon and star ratings. Never a button fill with light text
  on top (1.80:1 failure above).
- `status-danger` (`coral-400`): **only** decline/hold/failed states. Never used for a merely-neutral or
  informational badge.

---

## 4. Typography

### 4.1 Font stacks — EXISTING (KEEP)

| Stack | Family list | Where it applies |
|---|---|---|
| `font-sans` (Workforce Ledger) | `Helvetica Neue, Helvetica, Arial, Segoe UI, Roboto, system-ui, -apple-system, sans-serif` (`tailwind-preset.cjs:48-57`) | applied to `<body>` by default (`globals.css:20`); in practice reachable today only via print output and any un-migrated light-theme surface |
| `font-marketing` (Inter) | `var(--font-inter), ui-sans-serif, system-ui, sans-serif` (`globals.css:26-28`), self-hosted via `next/font/google` | every real screen today: `AppShell.tsx:29`, `AuthShell.tsx:43`, all of `marketing-dark/*` |
| `font-mono` | `ui-monospace, SF Mono, Cascadia Code, Roboto Mono, Menlo, Consolas, monospace` (`tailwind-preset.cjs:58-66`, also duplicated as a raw CSS var `--font-mono` in `globals.css:7`) | code blocks, IDs, JSON payloads, secret-key display |

**Rule going forward:** since §2 establishes dark/`font-marketing` as the real default, `font-marketing`
should be the effective default applied at the `<html>`/`<body>` level once migration reaches that point,
with `font-sans` reserved for the light/print theme — the inverse of today's `globals.css:20` default. This
is a Phase 3 migration item (§16), not a day-one change, since flipping the body default before components
migrate would break the (currently working) explicit `font-marketing` class on every dark surface.

### 4.2 Type scale — NEW (no scale currently declared as tokens; sizes below are reverse-engineered from
real usage — e.g. `text-2xl font-bold` page titles at `dashboard/page.tsx:56`, `text-3xl font-bold` KPI
numbers at `StatTile.tsx:27` — and extended to a full, consistent scale)

| Name | Size | Line height | Weight | Letter spacing | Use case |
|---|---|---|---|---|---|
| `display` | 36px / 2.25rem | 40px | 700 | `tightest` (-0.035em) | Marketing hero, rare in-app use |
| `h1` | 24px / 1.5rem | 32px | 700 | normal | Page title (matches `dashboard/page.tsx:56`) |
| `h2` | 18px / 1.125rem | 26px | 600 | normal | Section heading |
| `h3` | 16px / 1rem | 24px | 600 | normal | Card title, panel heading |
| `body` | 14px / 0.875rem | 20px | 400 | normal | Default body text, form labels |
| `body-strong` | 14px | 20px | 600 | normal | Emphasized body, active nav (`Sidebar.tsx:50`) |
| `small` | 13px / 0.8125rem | 18px | 500 | normal | Secondary metadata (matches `WorkflowDiagram.tsx:32` node title) |
| `caption` | 12px / 0.75rem | 16px | 500 | normal | Helper text, table cell secondary line |
| `micro` | 11px / 0.6875rem | 14px | 600 | `kicker` (0.14em), uppercase | Eyebrow labels, badge text (matches `WorkflowDiagram.tsx:33` node label) |
| `kpi` | 30px / 1.875rem | 36px | 700 | normal, `tabular-nums` | Big stat numbers (matches `StatTile.tsx:27`'s `text-3xl`) |

### 4.3 Numeric data

`font-variant-numeric: tabular-nums` is already global (`globals.css:21`, applied to `<body>`). Rule: any
number that appears in a column (tables, KPI tiles, timestamps) or that updates in place (a live counter)
must render with tabular figures — already the default; do not override it locally with
`font-variant-numeric: normal` inside a table cell.

### 4.4 Code / mono usage

`font-mono` for: workflow node IDs, JSON payload viewers, API keys/secret references (rendered as
`{{secrets.KEY}}`, never a plaintext secret — per `15-frontend.md:123-128`), webhook URLs, error stack
excerpts. Always at `body`(14px) or `caption`(12px) size, never smaller — monospace at micro size becomes
illegible.

### 4.5 Truncation and wrapping

- Single-line identity fields (employee name, workflow name, node title) truncate with `truncate` +
  `min-w-0` on the flex parent — matches the existing pattern at `EmployeeCard.tsx:30-32` and
  `WorkflowDiagram.tsx:32-33` exactly.
- Table cells: numeric columns never wrap; text columns wrap to 2 lines max then truncate with an
  ellipsis and a native `title` tooltip.
- Error messages and JSON payload previews wrap normally (`whitespace-pre-wrap`), never truncate silently —
  matches the existing convention referenced at `15-frontend.md:34`'s 800-char truncation with an explicit
  "show more," not a hard cutoff.

### 4.6 Responsive type

Scale does not change at breakpoints except `display` (36px → 28px below `md`, 768px) and `h1` (24px →
20px below `sm`, 640px). Body/caption/micro sizes stay fixed across breakpoints — enterprise data density
matters more than mobile-first scaling for a table-heavy product.

---

## 5. Spacing & layout

### 5.1 Base unit and scale — EXISTING (Tailwind default 4px scale; no override in `tailwind-preset.cjs`,
verified by absence of a `spacing` key). Keep as-is: `0.5`=2px, `1`=4px, `1.5`=6px, `2`=8px, `2.5`=10px,
`3`=12px, `4`=16px, `5`=20px, `6`=24px, `8`=32px, `10`=40px, `12`=48px. Matches real usage throughout
(`gap-2.5` at `Topbar.tsx:28`, `p-5` at `StatTile.tsx:15`, `px-10` at `AppShell.tsx:33`).

### 5.2 Layout grid

- Content container: `max-w-container` = 1200px (`tailwind-preset.cjs:70`), centered, existing.
- Prose/reading column: `max-w-prose` = 640px (`tailwind-preset.cjs:70`), for long-form text (docs,
  onboarding copy).
- App shell: no max-width on `<main>` (`AppShell.tsx:33`) — intentional, so data tables and the workflow
  canvas can use full width; individual pages that want a narrower reading column apply `max-w-container`
  themselves.

### 5.3 Section rhythm

- Page title to first content block: 32px (`mb-8`, matches `dashboard/page.tsx:55`).
- Between major page sections: 24-32px (`mb-8`/`gap-6`, matches `dashboard/page.tsx:78,121`).
- Card internal padding: 20px (`p-5`, matches `StatTile.tsx:15`, `EmployeeCard.tsx:23`).
- Card-to-card gap in a grid: 16-24px (`gap-4`/`gap-6`).

### 5.4 Component internal spacing rules

- Icon-to-label gap: 8-12px (`gap-2`/`gap-3`).
- Button horizontal padding: 16px (`md`) / 24px (`lg`) — existing, `Button.tsx:26-27`.
- Form field vertical rhythm: 10px top/bottom padding inside the field (`field-modern`, `globals.css:39`),
  16-20px between stacked fields.

### 5.5 Density modes — NEW

Enterprise tables and the workflow node list need a compact mode for power users. Two modes, one token,
switched via a `data-density` attribute on a table/list container:

| Mode | Row height | Cell padding (y) | Font size |
|---|---|---|---|
| `comfortable` (default) | 48px | 12px | `body` (14px) |
| `compact` | 36px | 8px | `caption` (12px) |

Applies to: data tables (§10.8), the Execution Timeline step list, the Node Library palette list, the
Outline view (`15-frontend.md:622-634`). Does not apply to cards or the canvas itself.

---

## 6. Elevation & depth

### 6.1 Shadow scale — EXISTING (KEEP), `tailwind-preset.cjs:71-77`, plus one NEW addition

| Token | Value | Use |
|---|---|---|
| `shadow-card` | `0 1px 0 #E5E4DD, 0 12px 32px -16px rgba(20,21,26,0.10)` | light-theme resting card |
| `shadow-lift` | `0 1px 0 #D6D5CC, 0 22px 44px -20px rgba(20,21,26,0.14)` | light-theme hovered/raised card |
| `shadow-cta` | `0 10px 30px -10px rgba(79,70,229,0.45)` | light-theme primary CTA button |
| `shadow-warm` | `0 10px 30px -12px rgba(255,154,98,0.40)` | Hire button only |
| `shadow-dark-card` | `0 10px 40px rgba(0,0,0,.45)` | dark-theme card (mostly invisible on `void`, see §6.3) |
| `shadow-popover` (NEW) | `0 20px 50px -15px rgba(0,0,0,0.9)` | matches the already-shipped account menu, `Topbar.tsx:69` — promoted to a named token |

### 6.2 Z-index scale — NEW (no scale exists today; this is the table enterprise apps get wrong)

| Layer | Token | Value |
|---|---|---|
| Base content | `z-base` | 0 |
| Sticky table header | `z-sticky` | 100 |
| Sidebar (mobile overlay variant) | `z-sidebar-overlay` | 200 |
| Dropdown / select menu | `z-dropdown` | 300 |
| Canvas floating docks (Toolbar, Inspector, Node Library, Minimap — `15-frontend.md` §15.B/D/F/G) | `z-canvas-panel` | 400 |
| Popover | `z-popover` | 500 |
| Tooltip | `z-tooltip` | 600 |
| Modal backdrop | `z-modal-backdrop` | 700 |
| Modal | `z-modal` | 710 |
| Toast | `z-toast` | 800 |
| Command palette | `z-command-palette` | 900 |

Rule: tooltip must always outrank popover (a tooltip can appear from inside a popover); modal must always
outrank canvas panels (opening the shortcuts-help Modal, `15-frontend.md:112`, over an open canvas dock);
toast outranks modal so a save-confirmation toast is visible even while a dialog is open.

### 6.3 Elevation differs by theme — stated directly

Light theme reads elevation through **shadow**: `shadow-card`/`shadow-lift` are visible against `paper`
because the background is light and shadows are dark, low-opacity washes. Dark theme cannot use this
mechanism the same way — `shadow-dark-card`'s `rgba(0,0,0,.45)` is nearly invisible against `void`
(`#030408`, already almost black). This is a real, current problem in the token set, not a hypothetical:
`tailwind-preset.cjs:76`'s `dark-card` shadow is defined but does close to nothing visually on the actual
`void` canvas.

**Rule: dark-theme elevation is read through surface lightness steps, not shadow.** The four-step dark
surface ladder already exists and already works this way in shipped code:
`void` (0.3% luminance) → `void-section` (1.1%) → `void-card` (1.6%) → `void-card-hover` (2.4%), plus a
1px top-edge highlight border at 7-14% white opacity (`StatTile.tsx:15`'s `border-white/[0.07]`,
`hover:border-white/[0.14]`). A raised element in dark mode gets: one step lighter background + a
slightly-brighter border, not a bigger shadow. `shadow-dark-card` is reserved for genuinely floating
layers where black-on-black still reads because there's a light halo around it — modal, popover, toast,
command palette (§6.2's top layers) — where the backdrop scrim darkens everything *around* the floating
element first.

---

## 7. Glassmorphism

### 7.1 Existing recipe — EXISTING (KEEP), `.field-modern`, `globals.css:34-61`

```css
background: rgba(255, 255, 255, 0.03);
border: 1px solid rgba(255, 255, 255, 0.1);
/* hover */
border-color: rgba(139, 110, 242, 0.55);
box-shadow: 0 0 0 3px rgba(94, 60, 232, 0.08);
/* focus */
border-color: #7c5cf0;
background: rgba(255, 255, 255, 0.05);
box-shadow: 0 0 0 3px rgba(94, 60, 232, 0.28), 0 0 24px -6px rgba(94, 60, 232, 0.65);
```

This is real, working glassmorphism already in production (form inputs on every auth screen and, via
`IconInput`, `fields.tsx:33`). No `backdrop-filter` is actually used here — it is a *tinted* glass look
(translucent white fill + border) rather than a *blurred* glass look. This document formalizes both.

### 7.2 When glassmorphism is allowed

Only on the dark theme, only over the theme's own defined surfaces (`void`/`void-section`/`void-card`),
where the background behind the glass is controlled and dark. Allowed uses: form inputs (`field-modern`,
existing), popovers/dropdowns, the account menu, decorative marketing panels, the auth card itself
(`AuthShell.tsx:63`'s `bg-[#080a14]/90 backdrop-blur-sm`).

### 7.3 When it is banned

- **Light theme, always.** Paper is flat by design (`tailwind-preset.cjs:2-3`: "Swiss-editorial"); a blur
  effect over warm paper reads as a rendering bug, not a material.
- **Data tables.** Rows must stay fully opaque — a translucent row over scrolled content behind it makes
  numbers misreadable, and virtualization (§10.8) makes the "what's behind it" unpredictable.
- **Form validation error states.** An error message must be 100% opaque; glass over red text lowers its
  already-tight contrast budget further.
- **Anywhere contrast can't be guaranteed** — see the readability floor below.

### 7.4 Three intensity levels

| Level | Background | Border | Shadow | Use |
|---|---|---|---|---|
| Subtle | `rgba(255,255,255,0.03)` | `rgba(255,255,255,0.1)` | none | form inputs, resting cards |
| Medium | `rgba(255,255,255,0.05)` | `rgba(255,255,255,0.14)` | `0 8px 24px rgba(0,0,0,0.4)` | popovers, dropdown menus, hover states |
| Strong | `rgba(255,255,255,0.07)` + `backdrop-filter: blur(16px)` | `rgba(255,255,255,0.1)` | `shadow-dark-card` | the auth card only (matches `AuthShell.tsx:63`'s `backdrop-blur-sm`), marketing decorative panels |

### 7.5 Readability floor

A glass surface is only allowed where the layer *behind* it is one of the theme's own solid tokens (never
raw video/photo content without a scrim). `AuthShell.tsx:52-55` already does this correctly: the
background video is dimmed to `opacity-30` and covered by a solid `bg-[#02030a]/70` scrim **before** the
glass card is drawn on top — so the glass card's own translucency is composited over a known-dark,
known-flat layer, not over unpredictable video frames. Any new video/photo background must repeat this
scrim-then-glass order.

### 7.6 Performance cost

`backdrop-filter: blur()` is GPU-compositing work that scales with the blurred area and repaints on every
scroll frame if the blurred element moves relative to its background. Rule: blur only small, mostly-static
elements (the auth card, a popover), never a blur across a scrolling list or the workflow canvas viewport.

### 7.7 `@supports` fallback

```css
.glass-medium {
  background: rgba(15, 16, 23, 0.92); /* opaque fallback: void-card at high alpha */
  border: 1px solid rgba(255, 255, 255, 0.1);
}
@supports (backdrop-filter: blur(1px)) or (-webkit-backdrop-filter: blur(1px)) {
  .glass-medium {
    background: rgba(255, 255, 255, 0.05);
    backdrop-filter: blur(12px);
    -webkit-backdrop-filter: blur(12px);
  }
}
```

---

## 8. Motion & animation

### 8.1 Existing inventory — EXISTING (KEEP), `tailwind-preset.cjs:85-138`

| Animation | Keyframe behavior | Duration/easing | Real use |
|---|---|---|---|
| `flow` | `strokeDashoffset` → -44 | 2.4s linear infinite | animated dash on a RUNNING workflow edge (§10.7) |
| `breathe` | opacity .35↔.9, scale 1↔1.04 | 3.6s ease-in-out infinite | a "live"/pulsing indicator |
| `rise` | translateY 16px→0, fade in | .48s `swiss` | scroll-reveal, modal/panel entrance |
| `riseL` / `riseR` | translateX ∓24px→0, fade in | (no named `animation` entry — keyframes only, apply manually) | staggered side-entrance |
| `ripple` | scale 0→2.4, fade out | 4s ease-out infinite | decorative background ripple (marketing) |
| `pulseDot` | boxShadow ring 0→6px, fading | 2.4s ease-in-out infinite | the small "live" dot (e.g. an ACTIVE employee) |
| `gridDrift` | translateY -24px, alternating | 40s linear infinite alternate | decorative background grid (marketing) |
| `drawIn` | `strokeDashoffset` → 0 | (keyframes only) | SVG line draw-in, on demand |
| `twinkle` | opacity .6↔1, scale .9↔1.1 | 2.5s ease-in-out infinite | starfield dots (`AuthShell.tsx:6-19`) |
| `spin-slow` | rotate 360deg | 40s linear infinite | slow decorative rotation |
| `float` | translateY 0↔-10px | 4.5s ease-in-out infinite | floating decorative element |
| `glow-pulse` | opacity .55↔1 | 3.2s ease-in-out infinite | glow halo pulsing |

### 8.2 Duration scale

| Token | Value | Use |
|---|---|---|
| `instant` | 0ms | state that must feel synchronous (checkbox toggle fill) |
| `fast` | 150-200ms | hover/focus color and background transitions (matches `Button.tsx:23`'s `duration-200`) |
| `base` | 200-250ms | most UI transitions: card hover, dropdown open |
| `deliberate` | 480ms | entrance animation (`rise`, matches its own literal .48s) |
| `ambient` | 2.4s+ | infinite decorative loops (`flow`, `breathe`, `pulseDot`, etc.) — never used for anything the user is waiting on |

### 8.3 Easing tokens

`ease-swiss` = `cubic-bezier(.22,1,.36,1)` — EXISTING (`tailwind-preset.cjs:139`), the signature easing:
a fast start with a soft, slightly overshooting settle. Used for every deliberate (non-ambient) motion:
button press, card lift, modal entrance, drawer slide. Standard `ease`/`ease-in-out` are acceptable only
for ambient/infinite loops where a signature feel is not the point.

### 8.4 What should and should not animate

**Should animate:** hover/focus state transitions, modal/drawer/popover/toast entrance-exit, a RUNNING
workflow edge (`flow`), a live/active status dot (`pulseDot`), page-section scroll-reveal (`rise`/`riseL`/`riseR`).

**Should not animate:** table row reordering after a sort (snap instantly — animating 50 rows re-sorting
is disorienting, not helpful), any layout-affecting property on a list with more than ~20 items
(animate opacity/transform only, never `height`/`width` on large lists), status changes that need to be
noticed immediately by a screen reader user (pair with the `aria-live` region from `15-frontend.md:618-620`
instead of relying on visual motion alone).

### 8.5 Orchestration / stagger

Card grids and list entrances: stagger children by 40-60ms using `riseL`/`riseR`/`rise` with an
incrementing `animation-delay`, capped at 8 staggered items — beyond that, the last items should already
be visible (no user should wait more than ~500ms for a full grid to finish revealing).

### 8.6 Reduced motion — EXISTING (KEEP), already global

`globals.css:90-95`:

```css
@media (prefers-reduced-motion: reduce) {
  * { animation: none !important; transition: none !important; }
}
```

This already kills every animation and transition in this document, globally, with no per-component work
required. `MotionFlag.tsx` (`components/system/MotionFlag.tsx:1-19`) adds a manual escape hatch: appending
`?nomo` to any URL adds a `nomo` class to `<html>`, intended to force scroll-reveal elements to their final
visible state for deterministic screenshots — **verified to add the class, but no CSS rule keyed on
`.nomo` was found in `globals.css`.** This is a real gap: `MotionFlag` sets a flag that (as far as this
recon found) nothing currently reads. Flagging as **NOT VERIFIED / likely incomplete** — the consuming CSS
rule may exist in an unread file, but was not found in `globals.css`. Recommendation: either wire `.nomo`
to force `opacity:1; transform:none` on scroll-reveal elements, or remove the flag if it's dead code.

### 8.7 framer-motion usage guidelines

`framer-motion@^12.42.2` is installed but not yet used anywhere the recon found (no `motion.` JSX usage
located). Guidelines for its introduction: use it only for gesture-driven or physics-based motion that
CSS keyframes genuinely cannot express well (drag-to-reorder, the workflow canvas's own pan/zoom is
handled by React Flow, not framer-motion). For everything already covered by the keyframe inventory above
(§8.1), keep using Tailwind's `animate-*` utilities — introducing a second animation system for the same
job (a card fading in) creates exactly the kind of duplicate-implementation problem this whole document is
trying to close.

---

## 9. Iconography

### 9.1 Library — EXISTING, `lucide-react@^1.24.0` (`apps/web/package.json`)

### 9.2 Sizes and stroke

| Context | Size | Stroke width |
|---|---|---|
| Inline with `body`/`small` text | 14-16px (`h-3.5 w-3.5` / `h-4 w-4`) | 2 (lucide default) |
| Standalone button icon, nav icon | 18px (`h-[18px] w-[18px]`, matches `Sidebar.tsx:56`, `Topbar.tsx:34`) | 2 |
| Card/section header icon | 20px (`h-5 w-5`) | 2 |
| Empty-state / large illustrative icon | 40-48px | 1.5 (lighter stroke reads better at large size) |

### 9.3 Alignment with text

Icons sit in a flex row with `items-center` and an 8-12px gap (`gap-2`/`gap-3`), never inline within a text
run (no icon-in-the-middle-of-a-sentence). Icon-only buttons center the icon in a square hit target (§9.5).

### 9.4 Semantic icon map — one icon per concept

| Concept | Icon |
|---|---|
| Dashboard | `LayoutDashboard` |
| AI Employees | `Users` |
| Skills | `Sparkles` |
| Workflows | `Workflow` |
| Scheduling | `CalendarClock` |
| Marketplace | `ShoppingBag` |
| Billing | `CreditCard` |
| Team | `UsersRound` |
| Organization | `Building2` |
| System health | `Activity` |
| Approvals | `CheckCircle2` |
| Notification bell | `Bell` |
| Logout | `LogOut` |
| Success / completed | `CheckCircle2` |
| Failure / error | `XCircle` |
| Warning / pending | `AlertTriangle` |
| Info | `Info` |
| Search | `Search` |
| Delete | `Trash2` |
| Edit | `Pencil` |
| Add | `Plus` |
| Filter | `SlidersHorizontal` |
| Sort | `ArrowUpDown` |
| Drag handle | `GripVertical` |
| More actions ("⋯" menu, `15-frontend.md:611`) | `MoreVertical` |
| Node: TRIGGER | `Zap` |
| Node: AI_STEP | `Bot` |
| Node: CONDITION | `GitBranch` |
| Node: WAIT | `Clock` |
| Node: TOOL_ACTION | `Wrench` |
| Node: APPROVAL | `CheckCircle2` |
| Node: RETRIEVE | `Database` |
| Node: NOTIFY | `Send` |
(All matched against `NAV_PRIMARY`/`NAV_ADMIN` in `Sidebar.tsx:29-43`, existing; node icons are NEW,
chosen per-category per §10.7.)

### 9.5 Icon-only button accessibility

Every icon-only control needs `aria-label` — already done correctly in shipped code
(`Topbar.tsx:31`'s `aria-label="Approvals"`, `EmployeeCard.tsx:84`'s `aria-label="Delete employee"`,
`fields.tsx:54`'s dynamic show/hide label). Minimum hit target 40×40px even if the visual icon is 18-20px —
matches `Topbar.tsx:32`'s `h-10 w-10` exactly. Never rely on a `title` tooltip alone as the only accessible
name.

### 9.6 Custom/brand SVG

`OrlixaMark`/`OrlixaLockup` (`marketing-dark/OrlixaMark.tsx`) and the brand icons in
`marketing-dark/brand-icons.tsx` (Slack/Google/Microsoft/GitHub) are hand-drawn SVG, not from lucide. Rule:
custom brand marks stay pure inline SVG (no external image request) so they print and screenshot reliably —
matching the same "zero external assets" principle already stated for the Workforce Ledger tokens
(`tailwind-preset.cjs:5`).

---

## 10. Component library

Every component below is marked **EXISTING (KEEP)**, **EXTEND**, or **NEW**. Token references use the
semantic names from §2.4/§3.2.

### 10.1 Buttons — EXTEND `apps/web/src/components/ui/Button.tsx`

**Anatomy**

```
[ icon? ]  Label  [ icon? ]
└─ padding (16px md / 24px lg horizontal, per §5.4) ─┘
```

**Existing variants (KEEP all)** — `Button.tsx:14,30-39`: `primary`, `cta`, `hire`, `ghost`, `link`,
`violet`. **New variant added:** `secondary` (a themed neutral button — today's real secondary action is
the ad-hoc `secondaryBtnClass` string duplicated in `EmployeeCard.tsx:10-11`; promoting it into `Button`
removes that duplication).

| Variant | Background | Text | Border | Real usage today |
|---|---|---|---|---|
| `primary` | `accent-primary` | `fg-on-accent` | none | 0 call sites (§2.1) — kept for the light theme's future default |
| `cta` | `bg-g-cta` gradient | white | none | marketing only |
| `hire` | `accent-warm` | **`fg-on-warm` (ink) — FIXED, was white, §3.6** | none | 0 call sites yet; will be the real Hire button |
| `secondary` (NEW) | `bg-surface-hover` @ existing opacity | `fg-muted` → `fg-default` on hover | `border-default` → `border-strong` on hover | replaces `EmployeeCard.tsx:10-11`'s inline class |
| `ghost` | transparent | `fg-default` | `border-default` | 0 call sites yet |
| `link` | none | `accent-primary` | `.link-wipe` underline (`globals.css:70-88`) | 0 call sites yet |
| `violet` | `accent-primary` (dark) | white | none, `shadow` glow | **25/25 real call sites** |

**Sizes (KEEP)** — `Button.tsx:25-28`: `md` (`px-4 py-2 text-sm`), `lg` (`px-6 py-3 text-base`).
**New size added:** `sm` (`px-3 py-1.5 text-xs`) — matches `EmployeeCard.tsx:11`'s existing ad-hoc small
button exactly, promoted rather than left as a one-off string.

**States:** default; hover (background shift, `-translate-y-0.5` lift on `cta`/`hire`/`violet`); active
(no separate token today — add `active:translate-y-0`); `focus-visible` (global ring, §12.2); `disabled`
(`disabled:opacity-50/60`, `cursor-not-allowed`, existing); loading (NEW — see below); icon-only (NEW —
square, `aria-label` required, §9.5).

**Loading state — NEW.** Replace label with a 14px spinner (reuse `spin-slow`'s rotation logic at a faster,
non-ambient 0.8s duration — a new one-off animation, not `spin-slow` itself, since loading spinners are
not "ambient decoration," they represent real wait time and should feel brisk) plus `aria-busy="true"` on
the button and keep the label present via `sr-only` for screen readers.

**Props API**

```tsx
type Variant = 'primary' | 'cta' | 'hire' | 'secondary' | 'ghost' | 'link' | 'violet';
type Size = 'sm' | 'md' | 'lg';

interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: Variant;
  size?: Size;
  loading?: boolean;   // NEW
  iconOnly?: boolean;  // NEW — enforces square padding + requires aria-label at the type level
}
```

**a11y:** native `<button>` semantics (already correct); `iconOnly` variant must not compile without an
`aria-label` — enforce via a discriminated union in the real implementation
(`iconOnly: true` requires `'aria-label': string`).

**Do:** use `hire` only for an actual hire/approve action. **Don't:** use `hire` or `cta` as a generic
"make it pop" button — that is exactly the rationing rule from §3.7.

### 10.2 Form controls

**Input — EXTEND, reconciling `.field-modern` (`globals.css:34-61`) with the semantic layer**

`.field-modern` is kept exactly as-is for the dark theme (it already computes well:
`rgba(255,255,255,0.03)` background over `void-card`). For the light theme (currently undefined for
inputs — no light-theme input exists in shipped code), the equivalent recipe is:

```css
.field-modern[data-theme-light], html:not(.dark) .field-modern {
  background: rgb(var(--bg-surface));
  border: 1px solid rgb(var(--border-default));
  color: rgb(var(--fg-default));
}
html:not(.dark) .field-modern:hover { border-color: rgb(var(--border-strong)); }
html:not(.dark) .field-modern:focus-visible {
  border-color: rgb(var(--border-focus));
  box-shadow: 0 0 0 3px rgb(var(--accent-primary) / 0.15);
}
```

No blur/glass on the light variant (§7.3's ban).

Anatomy: `[ left icon? ] [ text ] [ right slot? ]` — matches `IconInput`, `fields.tsx:22-40`, exactly;
promote it from `components/auth/fields.tsx` into `components/ui/Input.tsx` (NEW file) so non-auth forms
can use the same primitive instead of hand-rolling inputs (verified: every form field outside `auth`/
`onboarding` today is a bare `<input>` — NOT VERIFIED exhaustively, but `EmployeeForm.tsx`/`UserForm.tsx`
were not read in this recon pass and should be checked before this migration starts).

States: default, hover, `focus-visible`, disabled (`opacity-50`, `cursor-not-allowed`), error (border →
`status-danger`, plus an inline message below using the same color, `role="alert"`), read-only (no border
change, `bg-surface-hover` fill to signal non-editable).

**Textarea:** same recipe, `min-height: 96px`, resizable vertically only.

**Select (native):** same visual recipe as Input; `.field-modern option { color: #111318 }`
(`globals.css:59-61`) already handles the native-popup-on-light-OS-menu problem — keep.

**Combobox (NEW):** a `Popover` (§10.4) containing a text `Input` + a scrollable option list; each option
`40px` tall, `bg-surface-hover` on hover/highlighted, checkmark icon (`Check`, lucide) on the selected one.

**Checkbox — EXTEND** `AuthCheckbox`, `fields.tsx:129-143`: 16×16px (`h-4 w-4`), `accent-[#6a30ec]` today
(ad-hoc hex) → migrate to `accent-[rgb(var(--accent-primary))]`. Keep the native `<input type="checkbox">`
approach (real, accessible, no custom SVG checkmark to maintain).

**Radio (NEW):** same sizing/accent approach as checkbox, native `<input type="radio">`.

**Switch (NEW):** track `40×22px`, thumb `18px`, off = `bg-surface-hover`/`border-default`, on =
`accent-primary` fill, thumb slides with `transition-transform duration-200 ease-swiss`. A `StatusToggle`-
shaped component already exists conceptually per `15-frontend.md:39`'s reference to `WorkflowList.tsx`'s
`StatusToggle` — this NEW `Switch` primitive should be what that component is refactored to use, not a
second bespoke switch.

**Slider (NEW):** native `<input type="range">` restyled: track 4px tall `bg-surface-hover`, filled portion
`accent-primary`, thumb 16px circle `bg-surface` with a 2px `accent-primary` ring.

**Date/time picker (NEW):** no existing implementation found. Recommend a lightweight library-agnostic
popover calendar (do not build a custom date-math engine) — this is a scope note, not a design spec;
visual recipe follows the `Combobox`'s popover chrome, with day cells 32×32px, selected day =
`accent-primary` fill + white text (contrast-checked: white on `violet` = 6.39:1, white on `brand-600` =
6.29:1, both pass).

**File upload (NEW):** dashed `2px border-default` drop zone, `bg-surface` idle → `bg-surface-hover` +
`border-accent-primary` on drag-over, `Upload` icon (lucide) centered, 96px min height.

**Form field wrapper (NEW):** `Label` (`body-strong`, `fg-default`) → control → `helper text` (`caption`,
`fg-muted`) OR `error text` (`caption`, `status-danger`, `role="alert"`, replaces the helper text, never
shown alongside it). Required fields: a single `*` appended to the label in `status-danger`, plus
`aria-required="true"` on the control — color alone never carries the "required" signal (§12 color
independence).

### 10.3 Cards

**Base Card — NEW primitive**, generalizing the pattern already duplicated across `StatTile.tsx:15` and
`EmployeeCard.tsx:23`: `rounded-2xl border border-default (dark: white/[0.07]) bg-surface p-5`, hover
`border-strong` + (light theme only) `shadow-lift`.

```tsx
interface CardProps {
  padding?: 'sm' | 'md' | 'lg'; // 16 / 20 / 24px
  interactive?: boolean;        // adds hover border/shadow + cursor-pointer
}
```

**AI Employee Card — NEW, the signature component.** Generalizes `EmployeeCard.tsx:14-102` into a full
spec covering states that today's implementation does not yet render.

Anatomy:

```
┌─────────────────────────────────────────────┐
│ [avatar 40×40, role-tinted]  Name            │  ← status pill, top-right
│                               Role (formatted)│
│                                                │
│ [skill chip] [skill chip] [skill chip] [+2]  │  ← NEW: skills row, doc 04 (not read this pass — NOT VERIFIED shape)
│ Last active: 12m ago · 34 tasks this week    │  ← NEW: activity line
│                                                │
│ [Pause/Resume] [Disable/Enable]  [🗑]   [Open]│  ← existing action row, EmployeeCard.tsx:41-99
└─────────────────────────────────────────────┘
```

| State | Visual difference from default |
|---|---|
| `hiring` (NEW — the employee record exists but onboarding/setup isn't complete) | avatar chip shows a `Loader2` spin instead of the role icon; status pill reads "Setting up"; action row replaced with a single disabled "Finishing setup…" button; matches the existing `isTemp` id-prefix check at `EmployeeCard.tsx:17,47` conceptually — that check already detects an unfinished/optimistic record and disables actions, this state gives it a distinct visual instead of just disabling buttons silently |
| `ACTIVE` (existing) | status pill `status-success` tint (fixed from the current `bg-green-500/15 text-green-400` ad-hoc Tailwind-default color, `employees/labels.ts:13`, to the semantic `status-success`) |
| `PAUSED` (existing) | status pill `status-warning` tint (fixed from `bg-amber-500/15 text-amber-400`, `employees/labels.ts:14` — note this is Tailwind's default `amber-500`, a different color from the preset's own reserved `amber-300`, §2.1's token-collision problem) |
| `DISABLED` (existing) | status pill neutral (`bg-surface-hover text-fg-muted`, fixed from `employees/labels.ts:15`'s `bg-white/[0.06] text-zinc-400` — same color, now named) |
| `error` (NEW — last run failed / connector broken) | a `status-danger` left border accent (3px) + an inline `AlertTriangle` + "Needs attention" line above the action row |

Props API:

```tsx
interface AiEmployeeCardProps {
  employee: AiEmployeeDto;              // existing type
  state: 'hiring' | 'active' | 'paused' | 'disabled' | 'error'; // NEW — derived from status + health check
  onPause?: () => void;
  onResume?: () => void;
  onDisable?: () => void;
  onEnable?: () => void;
  onDelete?: () => void;
}
```

a11y: the whole card is not a single link (the existing pattern of an "Open" link plus separate action
buttons, `EmployeeCard.tsx:92-98`, is correct — do not wrap the entire card in an anchor, which would make
the Pause/Disable/Delete buttons invalid nested-interactive-content).

### 10.4 Dialogs

**Modal — NEW**, `components/ui/Modal.tsx`, explicitly required by `15-frontend.md:112,198-199` (first
consumers: Templates gallery, shortcuts-help overlay). Focus-trapped, `role="dialog"`, `aria-modal="true"`,
`aria-labelledby` pointing at the modal's own title. Backdrop: `bg-overlay-scrim/60` (dark theme) /
`bg-overlay-scrim/40` (light). `z-modal-backdrop`/`z-modal` (§6.2). Closes on `Escape` and backdrop click;
focus returns to the trigger element on close.

**Drawer/Sheet — NEW.** Same trap/ARIA rules as Modal, slides in from the right (`translateX(100%)→0`,
`deliberate` duration, `ease-swiss`). Width `400px` default, `min(560px, 90vw)` for wider content (e.g. the
Execution Timeline's History tab, `15-frontend.md:162`).

**Alert dialog — NEW**, a constrained Modal variant for destructive confirmations: title + one sentence of
body copy + two buttons (`ghost`/`secondary` Cancel, `status-danger`-colored Confirm). This is the
component that should eventually replace the `window.confirm` calls at `NodeList.tsx:180-184` — but
`15-frontend.md:590` explicitly keeps `window.confirm` "reused verbatim" for the canvas's branch-delete
warning, so do not silently replace that one call site; introduce `AlertDialog` for new destructive flows
only, and treat replacing the existing `window.confirm` as a deliberate, separately-reviewed change if it
ever happens.

**Popover — NEW.** Anchored, `z-popover`, `medium` glass intensity (§7.4) on dark, opaque `bg-surface` +
`shadow-card` on light. Closes on outside click (matches the existing account-menu pattern exactly,
`Topbar.tsx:60-68`'s fixed-inset-0 click-catcher — promote that inline pattern into the shared `Popover`).

**Tooltip — NEW.** `bg-inverse` fill regardless of theme (a small dark chip works on both light and dark
canvases — this is the one component allowed to ignore the theme's own surface color, because a tooltip
must always read as "on top of everything," including on light backgrounds), white text, `caption` size,
appears after a 400ms hover delay, disappears immediately on mouse-leave. Never the only carrier of
essential information (an icon-only button still needs its own `aria-label`, §9.5 — the tooltip is a bonus
for sighted mouse users, not the accessible name).

**Command palette — NEW.** `Cmd/Ctrl+K`, `z-command-palette` (the highest real layer, §6.2), centered
modal-like panel, `strong` glass intensity on dark, fuzzy-searchable list of actions/pages. Scope note:
this is a cross-cutting shell feature, not owned by the workflow canvas; if the canvas also wants a
node-search palette, it should reuse this same component rather than building a second one (the canvas
spec's own Search surface, `15-frontend.md` §15.H, was not read in full this pass — verify no conflict
before implementing).

### 10.5 Tables

**Anatomy**

```
[ Toolbar: search | filters | density toggle | column picker ]
┌────────────────────────────────────────────────────┐
│ [ ] │ Col A ▲▼ │ Col B ▲▼ │ Col C │ ⋯               │  ← sticky header, z-sticky
├────────────────────────────────────────────────────┤
│ [ ] │ value    │ value    │ value │ [row actions]   │
│ [ ] │ value    │ value    │ value │ [row actions]   │
└────────────────────────────────────────────────────┘
[ Pagination: ← 1 2 3 … 12 → | rows-per-page ]
```

- **Header:** `bg-sunken`, sticky (`position: sticky; top: 0; z-index: z-sticky`), sort arrows toggle
  asc/desc/none on click, `aria-sort` reflects state.
- **Filtering:** a filter chip row above the table; each active filter is a removable `Chip` (§10.10).
- **Pagination:** page-number buttons + a rows-per-page `Select` (10/25/50/100), matching enterprise-table
  convention; total-count text always visible ("1-25 of 342").
- **Row selection:** checkbox column, header checkbox is tri-state (all/none/indeterminate).
- **Row actions:** a trailing `⋯` icon button opening a `Popover` menu — same non-hover-only rule as the
  canvas's per-node menu (`15-frontend.md:611`) for keyboard/touch parity.
- **Expandable rows:** a chevron toggles a sub-row; expanded content indents 32px under the toggle column.
- **Sticky columns:** the row-selection checkbox and the row-actions column are the only columns allowed
  to be sticky (`position: sticky; left/right: 0`), each with its own solid background so scrolled content
  doesn't show through.
- **Density modes:** `comfortable`/`compact` per §5.5.
- **Loading:** skeleton rows (§10.9), same column widths as real data so layout doesn't shift on load.
- **Empty:** centered icon + one sentence + (if applicable) a primary action button, inside the table's
  own bounds, not a separate page state.
- **Error:** a `status-danger`-tinted inline banner (§10.9) at the top of the table body, with a Retry
  button; existing rows (if any were loaded before the error) remain visible below it rather than being
  replaced.
- **Virtualization:** required above ~200 rows (matches doc 00 §0.8's implied scale targets for
  workflow-adjacent lists — NOT VERIFIED exact number for generic tables, but the same "don't render
  off-screen DOM" principle from `15-frontend.md:638` applies). Use row-height-fixed virtualization
  (`comfortable`=48px/`compact`=36px, §5.5) so scroll math stays simple.

### 10.6 Workflow nodes — the signature component

**Design authority:** this section owns visual design only. Interaction (drag, connect, keyboard
shortcuts) is `15-frontend.md` §15.C, cited throughout — nothing here contradicts it.

**Base node card anatomy** — matches `15-frontend.md:494-495`'s explicit instruction to render
`bg-void-card`/`border-white/[0.08]`/`shadow-dark-card`, "matching `WorkflowDiagram.tsx:26` exactly":

```
┌──────────────────────────────┐
○  [icon 32×32, tone-tinted]  Title       ○   ← input handle (left), output handle(s) (right)
   Subtitle / node-type label
   [note-glyph badge, if node.notes set]   ← 15-frontend.md:518-519
└──────────────────────────────┘
   (status ring/border overlays when a run is active, see below)
```

Base recipe (always dark, per §2.2 point 4, regardless of app theme):

```css
border-radius: 14px;        /* rounded-node, tailwind-preset.cjs:69 */
background: #0F1017;        /* void-card */
border: 1px solid rgba(255,255,255,0.08);
box-shadow: 0 10px 40px rgba(0,0,0,.45); /* shadow-dark-card */
padding: 14px;
min-width: 220px;
```

**The 8 real node types** (`00-overview-and-canonical-contracts.md:394,396,399,402,404,406,413` — the ones
marked `EXISTING`), each with its icon (§9.4) and tone:

| `NodeType` | `NodeCategory` | Icon | Tone (icon chip background/text) |
|---|---|---|---|
| `TRIGGER` | TRIGGER | `Zap` | `bg-mint-400/15 text-mint-400` (matches `WorkflowDiagram.tsx:19`'s `emerald` tone exactly, renamed onto the real token) |
| `AI_STEP` | AI_EMPLOYEE | `Bot` | `bg-violet/20 text-violet-secondary` (matches `WorkflowDiagram.tsx:20`'s `violet` tone, already a real token) |
| `CONDITION` | LOGIC | `GitBranch` | rendered as the existing 45°-rotated diamond shape (`WorkflowDiagram.tsx:49-53`), not a rectangle — kept as the one intentional shape exception, per doc 15's handle-topology note (§10.6 below) |
| `WAIT` | LOGIC | `Clock` | `bg-sky-400/15 text-sky-300` NEW — no existing LOGIC tone beyond CONDITION's diamond; sky reused from the categorical data-viz palette (§3.5) for consistency |
| `TOOL_ACTION` | SKILL | `Wrench` | `bg-sky-400/15 text-sky-300` (matches `WorkflowDiagram.tsx:21`'s `sky` tone) |
| `APPROVAL` | APPROVAL | `CheckCircle2` | `bg-accent-warm/15 text-accent-warm` — the one node type allowed to use the rationed warm accent, because Approval is explicitly one of the two human moments (§3.7) |
| `RETRIEVE` | KNOWLEDGE | `Database` | `bg-violet/20 text-violet-secondary` (shares AI_EMPLOYEE's violet tone — both are "the AI doing cognitive work") |
| `NOTIFY` | COMMUNICATION | `Send` | `bg-rose-400/15 text-rose-400` (matches `WorkflowDiagram.tsx:22`'s `rose` tone) |

**Category → tone fallback (covers all 12 `NodeCategory` values, so the other 18 `NEW` node types
generalize automatically — per `15-frontend.md:662-665`'s explicit instruction to key styling off
`NodeCategory`, never a per-type switch):**

| `NodeCategory` | Tone |
|---|---|
| TRIGGER | mint |
| AI_EMPLOYEE | violet |
| LOGIC | sky |
| SKILL | sky |
| APPROVAL | warm |
| MEMORY | violet (cognitive-adjacent) |
| KNOWLEDGE | violet |
| VARIABLE | fg-muted neutral |
| COMMUNICATION | rose |
| UTILITY | fg-muted neutral |
| DATABASE | sky |
| EXTERNAL_API | sky |

**Node states**, mapped to `StepRunStatus` (§3.3) plus canvas-only interaction states:

| State | Visual |
|---|---|
| idle/default | base recipe above |
| hovered | border → white/[0.16], no shadow change |
| selected | 2px `accent-primary`(dark: violet) ring, offset 2px outside the card border |
| `RUNNING` | animated 2px `accent-primary` ring using `breathe` (opacity/scale pulse) + the node's output edge(s) animate with `flow` |
| `COMPLETED` | 2px `status-success` border, small check badge top-right corner of the card |
| `FAILED` | 2px `status-danger` border, small x badge top-right, card background shifts to `status-danger` at 6% opacity mixed into `void-card` |
| `SKIPPED` | dashed 1px `border-default`, content at 60% opacity |
| `RETRYING` | same as `RUNNING` but with a small attempt counter chip ("2/5") over the status badge position |
| `WAITING` (on an `APPROVAL` node) | `status-warning` (amber) pulsing dot + "Awaiting approval" caption under the title |
| unknown type (`15-frontend.md:587`) | dashed `status-danger` border, the raw type string rendered verbatim in the title position, no icon — exact existing spec, kept |
| `readOnly` | no visual change to the card itself; the canvas around it removes handles/drag per `15-frontend.md:591` (an interaction rule, not a visual one — cited, not duplicated) |

**Ports/handles:** generated from `NodeDefinitionDto.handles` (`15-frontend.md:499-514`, not redesigned
here — this section only specifies their look): a filled 8px circle, `accent-primary` fill, positioned at
the card's left edge (single input) and right edge (one or more outputs, vertically distributed when there
is more than one — e.g. CONDITION's Yes/No). A labeled output (like CONDITION's) shows its label
(`micro` size, `fg-muted`) just above the handle, outside the card bounds.

**Edges (`WorkflowEdgeLine.tsx`, NEW per `15-frontend.md:174-175`):**

| Edge state | Visual |
|---|---|
| default | 1.5px solid line, `border-strong` equivalent (white @ 15% on dark canvas) |
| animated-running | same line, `flow` keyframe dash animation (`tailwind-preset.cjs:86,128`), colored `accent-primary` |
| error | 1.5px `status-danger`, no animation (a static red line reads as "this path failed," not "this path is active") |
| labeled (`edge.label`, UI-only field per `15-frontend.md:516-517`) | small pill, `bg-surface`/`text-fg-muted`, centered on the line's midpoint |

**Group/container node (NEW — not covered by doc 15's read sections; treat as a visual-only addition, flag
before implementing against any grouping *behavior*, which is out of this document's scope):** a
translucent rounded rectangle, `border-dashed border-default`, `bg-surface-hover` at 40% opacity, sitting
behind its member nodes in z-order, with its own small label chip top-left.

**Minimap style:** small dots colored by the node's category tone (table above), current-viewport rectangle
outlined in `accent-primary` at 1px, minimap background `void-section`. This is a style note only —
`15-frontend.md` §15.G owns its interaction/behavior and was not fully read this pass; verify no conflict
before implementing.

### 10.7 Analytics

**Stat/KPI card — EXTEND** `StatTile.tsx` into the semantic layer (`bg-white/[0.03]` → `bg-surface`,
`border-white/[0.07]` → `border-default`, `text-white` → `text-fg`, `text-zinc-400` → `text-fg-muted`,
`text-zinc-500` → `text-fg-muted` per §3.6's contrast fix, not `text-fg-subtle`). Value at `kpi` type scale
(§4.2), `estimate` badge kept exactly (`StatTile.tsx:18-24`).

**Chart containers (NEW, no chart library integrated yet — NOT VERIFIED which one will be chosen):** all
chart types (line/bar/area/donut/heatmap) share one container recipe: `Card` (§10.3) with no internal
padding on the chart canvas itself (charts manage their own margins for axis labels), a `h3`-scale title,
and an optional legend row below.

- **Axis/grid:** grid lines at `border-default` and 40% opacity (barely-there, matches enterprise
  convention of grid-as-texture-not-decoration); axis labels at `caption` size, `fg-muted`.
- **Tooltip:** reuses the `Tooltip` component (§10.4) chrome exactly — one recipe, not a chart-specific one.
- **Legend:** small color swatch (10px square, rounded 2px) + `caption`-size label per series, using the
  categorical palette in series order (§3.5).
- **Sparklines:** single-color line, no axis/grid/legend at all, `accent-primary`, 24-32px tall, used inline
  in table cells or KPI card corners.

**Run-timeline / Gantt view:** rows = steps, x-axis = elapsed time; each step's bar is colored by its
`StepRunStatus` (§3.3's mapping), matching the Execution Timeline's own status colors so the same run looks
the same whether viewed as a list (`15-frontend.md` §15.E) or a Gantt bar — this document's contribution is
making sure both use the identical color table, not a separate one.

**Empty/no-data state:** centered `BarChart3`-family icon (lucide) at 40px, one sentence, no fabricated
placeholder numbers — consistent with this project's own stated convention against fabricating metrics
(see project memory: no real Kashif metrics exist yet, don't invent them; the same discipline applies to
chart empty states — show "No data for this range," never a sample chart with fake numbers).

### 10.8 Feedback

**Toast (NEW):** `bg-surface` + `shadow-popover` (§6.1), 360px max width, auto-dismiss 5s (8s for errors,
since error toasts need more reading time), `z-toast`. Stack from the bottom-right, newest on top, max 3
visible with a "+2 more" collapse.

**Inline alert (NEW):** a `Card`-shaped box with a left-side icon column tinted by severity (`status-info`
/`status-success`/`status-warning`/`status-danger` subtle backgrounds, §2.4), used inline in forms/pages
(not floating).

**Banner (NEW):** full-width, sits above page content (not inside a card), same severity tinting as inline
alert but no border-radius on the outer edges that touch the viewport edge.

**Progress (NEW):** linear bar, `bg-surface-hover` track, `accent-primary` fill, `4px` tall, rounded-full.
Indeterminate variant uses a `1.2s` looping gradient sweep (a new, non-ambient-family animation — distinct
from `breathe`/`pulseDot` because progress must read as "something is actively happening now," faster than
the ambient 2.4s+ family).

**Spinner (NEW):** a simple rotating ring, `0.8s linear infinite`, sized 16/20/24px matching icon sizes
(§9.2). Not `spin-slow` (that's a 40s decorative rotation, wrong job entirely).

**Skeleton (NEW):** `bg-surface-hover` blocks with a `1.5s` shimmer sweep (a `translateX` gradient pass,
reduced-motion already disables it globally, §8.6), shaped to match the real content's layout (text lines,
avatar circles, card outlines) so nothing jumps when real data arrives.

**Empty state (NEW):** icon (40-48px, §9.2) + one sentence + optional primary action, centered, reused
identically across tables (§10.5), cards, and analytics (§10.7) rather than each surface inventing its own.

**Error state (NEW):** same layout as empty state, `status-danger`-tinted icon, plus a Retry button where
retrying is meaningful (data fetch) and plain guidance where it isn't (a permissions error explains what to
do instead of retry).

### 10.9 Navigation

**Sidebar — EXTEND** `Sidebar.tsx`. Collapsed mode (NEW — today's sidebar is always full-width 256px,
`w-64`, `Sidebar.tsx:76`, with no collapse control): a 72px icon-only rail, icons centered, active item
gets a left-edge 2px `accent-primary` bar instead of the full pill fill (there's no room for label text to
carry the "active" signal at that width). Expand/collapse is a toggle button pinned at the bottom of the
rail.

**Topbar — EXTEND** `Topbar.tsx`, unchanged structurally; the account-menu popover pattern
(`Topbar.tsx:60-84`) is promoted into the shared `Popover` (§10.4) rather than staying a one-off
implementation.

**Breadcrumbs (NEW):** `caption` size, `fg-muted` separated by `ChevronRight` (14px), current page in
`fg-default` and non-interactive (not a link to itself).

**Tabs (NEW):** underline style — inactive `fg-muted`, active `fg-default` + 2px `accent-primary` underline
sliding between tabs with `base` duration `ease-swiss`. Matches the "Live/History" tab pattern already
implied for the Execution Timeline (`15-frontend.md:162`).

**Pagination:** see §10.5 (owned there, not duplicated).

**Stepper (NEW):** numbered circles connected by a line; completed = filled `status-success`, current =
filled `accent-primary` with a ring, upcoming = `bg-surface-hover` outline only. Used in onboarding
(`OnboardingShell.tsx`, not read this pass — verify visual compatibility before implementing).

### 10.10 Data display

**Badge / status pill — NEW**, the component that fixes §3.6's contrast findings once, everywhere:

```tsx
interface StatusPillProps {
  tone: 'success' | 'warning' | 'danger' | 'info' | 'neutral';
  children: ReactNode;
}
// Always: subtle tinted background (status-{tone}-subtle) + full-strength text/icon color (status-{tone}).
// Never: solid fill + white text (the failing pattern from §3.6).
```

Mapped to the real enums per §3.3's tables — this is the single implementation every status column in the
product (`WorkflowRunStatus`, `StepRunStatus`, `ApprovalStatus`, `EmployeeStatus`) should render through,
replacing the three separately-hand-rolled badge implementations found in this recon
(`employees/labels.ts:12-16`, and whatever `WorkflowList.tsx`'s status filter uses, not read this pass).

**Avatar + avatar group (NEW):** circle, role-tinted background (§3.4) + initials or icon, sizes 24/32/40px.
Group: overlapping circles with a `2px bg-canvas` ring between them (so they read as separate on any
background), "+N" overflow chip in `fg-muted`/`bg-surface-hover`.

**Tag/chip (NEW):** `bg-surface-hover`, `fg-muted`, `rounded-full`, `caption` size, optional remove `×`
(14px, `fg-subtle` → `fg-default` on hover) for removable filter chips (§10.5).

**Key-value list (NEW):** two-column, label (`fg-muted`, right-aligned or left depending on density) / value
(`fg-default`, `tabular-nums` if numeric, §4.3). Used in Inspector panels and detail drawers.

**Code block (NEW):** `font-mono`, `bg-sunken`, `border-default`, horizontal scroll (never wrap) for JSON/
payloads, matching the "no client-side redaction, server already redacted" rule from
`15-frontend.md:133-135` — this component never adds its own masking logic.

**Timeline (NEW):** vertical line + dots, each dot colored by its event's status (reuses §3.3's mapping),
matches the Execution Timeline's step list conceptually (`15-frontend.md` §15.E, not fully read — verify
before implementing against its exact data shape).

**Tree (NEW):** used by the Outline view (`15-frontend.md:622-634`) — indentation 20px per level, branch
lines in `border-default`, expand/collapse chevron per node with children.

---

## 11. Responsive rules

### 11.1 Breakpoints — EXISTING (Tailwind v3 default, no override found in `tailwind-preset.cjs`)

| Token | Px |
|---|---|
| `sm` | 640 |
| `md` | 768 |
| `lg` | 1024 |
| `xl` | 1280 |
| `2xl` | 1536 |

Already used correctly in shipped code: `Sidebar.tsx:76`'s `hidden … lg:flex` (sidebar only shows ≥1024px),
`Topbar.tsx:49`'s `hidden … sm:block` (name/role text hides <640px).

### 11.2 Per-component adaptation

| Component | <640px | 640-1024px | ≥1024px |
|---|---|---|---|
| Sidebar | hidden; replaced by a bottom tab bar or hamburger drawer (NEW — no mobile nav exists today, verified: `Sidebar.tsx:76` just hides, nothing replaces it) | hidden (same gap) | full 256px sidebar |
| Topbar | icon-only (name/role hidden, `Topbar.tsx:49`) | icon + name | icon + name + role |
| KPI grid | 1 column | 2 columns (`sm:grid-cols-2`, `dashboard/page.tsx:78`) | up to 6 (`xl:grid-cols-6`) |
| Data table | horizontal scroll, sticky first + actions columns only | same | full width, all sticky rules apply |
| Workflow canvas | see §11.4 | reduced toolbar, docks collapse to icon-only | full multi-dock layout |
| Modal | full-screen sheet | centered, `90vw` max | centered, fixed max-width |

### 11.3 Touch targets

44×44px minimum for any touch-operable control on a touch-capable viewport (WCAG 2.5.5 / iOS HIG
convention) — larger than the 40×40px desktop-mouse minimum already used at `Topbar.tsx:32`; on touch
viewports, pad icon buttons up to 44px even if the icon stays 18-20px.

### 11.4 The workflow builder on small screens — stated honestly

A node-graph canvas is not a phone-sized interaction. Recommendation, stated plainly rather than pretending
otherwise: **below `md` (768px), the canvas switches to a read-only Outline view by default**
(`15-frontend.md:622-634`'s Outline is reused here, not reinvented) — the user can see the workflow's
structure and tap a step to view its Inspector read-only, but cannot drag, connect, or rearrange nodes on
a touch/small viewport. A visible banner states "Full editing needs a larger screen" rather than presenting
a canvas that technically loads but is unusable with a thumb. This is a policy decision this document is
making explicitly, because doc 15 does not set a small-screen policy for the canvas (verified: no mobile
breakpoint behavior found in the sections read).

### 11.5 Print stylesheet — EXTEND `globals.css:97-102`

```css
@media print {
  * { animation: none !important; box-shadow: none !important; } /* EXISTING, keep */

  html { color-scheme: light !important; }
  body, .bg-canvas, .bg-surface { background: white !important; color: black !important; }
  .dark body, html.dark { /* force every dark-theme surface to the light mapping for print, §2.2 pt. 2 */
    background: #FAFAF8 !important;
    color: #14151A !important;
  }
  nav, aside, [data-app-shell-chrome] { display: none !important; } /* sidebar/topbar never print */
  a[href]::after { content: " (" attr(href) ")"; font-size: 10px; color: #4A4B54; } /* NEW */
}
```

This is where the Workforce Ledger tokens do real, guaranteed work (§2.2 point 2): whatever theme the
screen is in, print always renders light/paper, matching the token set's own "prints crisp with zero
external assets" design intent (`tailwind-preset.cjs:5`).

---

## 12. Accessibility

### 12.1 Conformance target

**WCAG 2.1 Level AA**, stated concretely as: every text/background pair used for real content meets 4.5:1
(normal text) or 3:1 (large text / non-text UI components) — the exact numbers are in §3.6, not restated
here as an unqualified claim.

### 12.2 Focus-visible system — EXISTING (KEEP), `globals.css:63-67`

```css
:where(a, button, input, select, textarea, [tabindex]):focus-visible {
  outline: none;
  box-shadow: 0 0 0 2px #fafaf8, 0 0 0 4px #4f46e5;
  border-radius: 4px;
}
```

This is a "paper gap + indigo ring" — it hardcodes `#fafaf8` (paper) as the gap color, which is correct
today (real dark pages don't actually rely on this rule where it matters, since `violet` variant buttons
have their own glow, `Button.tsx:38`) but **needs a dark-theme override once the semantic layer lands**,
using `--focus-ring-gap` (§2.4, mapped to `void` on dark) so the "gap" color matches the actual background
instead of punching a light-colored ring-gap onto a dark surface:

```css
/* NEW, additive */
html.dark :where(a, button, input, select, textarea, [tabindex]):focus-visible {
  box-shadow: 0 0 0 2px rgb(var(--focus-ring-gap)), 0 0 0 4px rgb(var(--border-focus));
}
```

### 12.3 Keyboard navigation and focus traps

Standard tab order everywhere except the workflow canvas, which uses `role="application"` and its own
managed focus cycle by deliberate, documented trade-off (`15-frontend.md:601-609`, cited not repeated).
Every Modal/Drawer/Popover/Command-palette (§10.4) traps focus while open and restores it to the trigger on
close — no exceptions.

### 12.4 Screen-reader patterns per component

- **Status pill (§10.10):** the color is never the only signal — the text label ("Completed", "Failed")
  is always present alongside the tint.
- **Workflow node card (§10.6):** `role="group"`, `aria-roledescription="workflow node"`,
  `aria-label="{label}, {status}, step {n} of {total}"` — exact spec from `15-frontend.md:607-609`, cited.
- **Toast/live status:** a visually-hidden `aria-live="polite"` region announces the same string shown
  visually (`15-frontend.md:618-620`'s pattern, generalized beyond the canvas to toasts/banners elsewhere).
- **Table sort:** `aria-sort="ascending|descending|none"` on the header cell.

### 12.5 Live regions for run status

One shared `aria-live="polite"` region per page that has live status (the canvas, the Execution Timeline,
a toast host) — not one per component, to avoid competing/overlapping announcements. Failure/error
transitions use `aria-live="assertive"` since a failed run needs to interrupt, per standard practice (not
independently verified against doc 15's exact wording for non-canvas surfaces — the canvas's own rule at
`15-frontend.md:618-620` says "polite" for all transitions; recommend assertive only for the FAILED
terminal transition specifically, and flag this as a place to confirm with doc 15's author before
implementing, since it is a deliberate small extension beyond what was verified there).

### 12.6 Color independence

Every place §3 defines a status color, a redundant non-color signal exists: an icon (§9.4's map), a text
label, or both. Verified rule already in place for the one real badge implementation found
(`employees/labels.ts`'s badges render the literal status string as their label, not just a colored dot).

### 12.7 Motion sensitivity

`prefers-reduced-motion: reduce` already globally disables all animation/transition (`globals.css:90-95`,
cited in §8.6). No component in §10 should reintroduce motion that bypasses this (e.g., a raw
`requestAnimationFrame` loop in a chart library would not be caught by the CSS rule — any JS-driven motion
must separately check `window.matchMedia('(prefers-reduced-motion: reduce)')`).

### 12.8 Form error announcement

An input in the error state (§10.2) sets `aria-invalid="true"` and `aria-describedby` pointing at the
error message's `id`; the error message itself has `role="alert"` so it is announced the moment it appears,
not only if the user tabs to it.

### 12.9 Testing checklist

- [ ] Every interactive element reachable by `Tab`, in a logical order.
- [ ] Every icon-only control has an `aria-label`.
- [ ] Every status color has a redundant text/icon signal.
- [ ] Every computed contrast pair used for real text meets its §3.6 threshold — new colors get a new
      computed ratio before shipping, not an eyeballed guess.
- [ ] Focus never gets lost when a Modal/Drawer closes.
- [ ] `prefers-reduced-motion` tested with DevTools emulation, not just assumed to work.
- [ ] Screen-reader pass (NVDA or VoiceOver) on: a status pill, the AI Employee Card, one workflow node,
      one table with sorting.

---

## 13. Content & voice

Plain, short, specific. No filler adjectives.

| Context | Rule | Example |
|---|---|---|
| Buttons | Verb + object, 1-3 words. No "Submit". | "Save workflow", "Hire employee", "Run now" |
| Errors | State what happened, then what to do. No blame, no exclamation points. | "Could not save. Check your connection and try again." |
| Empty states | State what's missing and the one action that fixes it. Never a joke or an empty-state illustration doing the talking alone. | "No workflows yet. Create your first one." |
| Confirmations (destructive) | Name the exact thing being destroyed, not a generic "Are you sure?" | "Delete the 'Weekly digest' workflow? This can't be undone." |
| Estimates/illustrative numbers | Always labeled, never presented as real telemetry without the label — matches the existing `estimate` badge convention exactly (`StatTile.tsx:18-24`). | "Cost Savings … est." |

---

## 14. Figma delivery spec

### 14.1 Page structure

1. **00 – Cover & changelog**
2. **01 – Foundations** (color primitives, semantic mapping, type scale, spacing, elevation, motion)
3. **02 – Components** (one frame per component, all variants as Figma variant properties)
4. **03 – Patterns** (AI Employee Card, workflow node set, table, forms)
5. **04 – Templates** (Dashboard, Workflow detail, Employees list, Auth flow)
6. **05 – Icons** (lucide set, organized by the semantic map in §9.4)

### 14.2 Variable collections

- **Collection: Primitive** — one mode only (`Value`); every hex from §3.1 as a single Figma color
  variable each (`paper/DEFAULT`, `paper/2`, `ink/DEFAULT`, `ink/70`, … `void/card`, `violet/hover`, etc.),
  named to match the Tailwind token path exactly so the Figma-to-code sync (§14.5) is a 1:1 name match.
- **Collection: Semantic** — two modes, `Light` and `Dark`, one variable per row in §2.4's CSS block
  (`bg/canvas`, `bg/surface`, `fg/default`, `fg/muted`, `border/default`, `accent/primary`, …), each mode
  aliasing the Primitive collection's variables (never a raw hex baked into the Semantic collection —
  aliasing is what keeps the two collections in sync when a primitive changes).
- **Collection: Spacing** — one mode, the 4px scale (§5.1).
- **Collection: Radius** — one mode, `card`/`btn`/`node`/`dark-lg`/`dark-btn` (§ existing tokens).

### 14.3 Text, effect, and grid styles

- Text styles: one per row of §4.2's type scale, named `Type/Display`, `Type/H1` … `Type/Micro`.
- Effect styles: one per §6.1 shadow, named `Elevation/Card`, `Elevation/Lift`, `Elevation/CTA`,
  `Elevation/Popover`, plus the glass recipes from §7.4 as three effect styles
  (`Glass/Subtle`, `Glass/Medium`, `Glass/Strong`).
- Grid styles: `Container/1200`, `Prose/640`, both centered, matching §5.2.

### 14.4 Component + variant property naming

Match the TypeScript prop names exactly so Code Connect mapping is mechanical, not interpretive:
`Button` component with variant properties `variant` (`primary|cta|hire|secondary|ghost|link|violet`),
`size` (`sm|md|lg`), boolean properties `loading`, `disabled`, `iconOnly` — mirroring §10.1's props API
verbatim. Same rule for every other component in §10: the Figma variant property list is the props
interface, not a paraphrase of it.

### 14.5 Auto-layout conventions

- All cards/panels: auto-layout, direction vertical, gap = the component's documented internal spacing
  (§5.4), padding = the density-appropriate value (§5.5) so resizing the frame behaves like the real
  responsive component.
- Button: auto-layout horizontal, gap 8px, padding matching §10.1's exact `px`/`py` per size — never a
  fixed-width frame that clips longer labels.

### 14.6 Token-sync path

Recommended: **W3C Design Token Community Group JSON format** as the interchange format (not a proprietary
Style Dictionary schema), because it's the format both Figma variable plugins and Tailwind-preset generators
increasingly support natively, reducing custom glue code. Path:

```
tailwind-preset.cjs (source of truth for primitives)
        │  (a small NEW script, scripts/tokens/export-w3c.js, not yet built)
        ▼
design-tokens.json (W3C DTCG format)
        │  (Figma "Variables Import/Export" plugin, manual or CI-triggered)
        ▼
Figma variable collections (§14.2)
```

Direction of truth: **code → Figma**, not the reverse, while the light theme remains print/export-only
(§2.5) — once light becomes a real interactive theme with designer-led palette refinement, revisit whether
Figma becomes the source of truth for new primitive values instead.

---

## 15. Governance

### 15.1 Token naming rules

- Primitive tokens: `{family}-{step}` (`brand-600`, `mint-400`) — never a semantic word in a primitive
  name (no `brand-primary`, no `mint-success`).
- Semantic tokens: `--{category}-{role}[-{modifier}]` (`--bg-surface-hover`, `--status-danger-subtle`) —
  category first so related tokens sort together.
- Never reuse a primitive family name for an unrelated semantic concept — §2.1 flagged exactly this
  collision (`amber-300` the token vs. Tailwind's default `amber-500` used ad-hoc for "Paused"). Going
  forward, if a new status needs an amber-family color, it must be the primitive `amber-300`, not a raw
  Tailwind-default utility class.

### 15.2 Adding or changing a token

1. Propose the primitive value first (with a computed contrast ratio against every surface it will sit on,
   §3.6's method) — never add a semantic token that points at a primitive nobody checked.
2. Add it to `tailwind-preset.cjs` (primitives) or the semantic CSS block (§2.4), never as a one-off
   arbitrary-value class in a component file — that is the exact anti-pattern §2.1 documented and this
   whole system exists to close.
3. Update this document's relevant table in the same change.
4. If it changes an existing token's *value* (not just adding a new one), run the §3.6 contrast check
   again for every pair that uses it.

### 15.3 Deprecation policy

A deprecated token stays in `tailwind-preset.cjs` with a `/** @deprecated use X instead */` comment for at
least one full migration phase (§16) before removal, so in-flight component work doesn't break mid-PR.

### 15.4 Versioning

This document is dated (`2026-08-01` in the filename) rather than semantically versioned; treat a new
dated file as the changelog. Token *values* that change in a breaking way (not just additions) should be
called out at the top of the new dated file's diff summary.

### 15.5 Contribution checklist

- [ ] New color: hex value + computed contrast ratio against every real background it will sit on.
- [ ] New component: variants/sizes/states table + props API + a11y section, matching §10's format.
- [ ] No raw hex/arbitrary-value Tailwind class introduced where a semantic token already covers the need.
- [ ] `file:line` cited for any claim about existing code; `NOT VERIFIED` used honestly otherwise.

---

## 16. Implementation roadmap

Each phase independently shippable; later phases don't block on earlier ones being "perfect," only "real."

| Phase | Scope | Ships |
|---|---|---|
| **0** | Land §2.4's CSS variables + the new `tailwind-semantic.cjs` preset + `next-themes` wired with `defaultTheme="dark"`. Zero visual change (§2.5 phase 0). | The plumbing, provably a no-op via screenshot diff. |
| **1** | Fix the two real contrast bugs (§3.6): `Button` `hire` variant text color; establish the `StatusPill` component (§10.10) so no new status badge ever ships with the white-on-mid-tone failure pattern again. | Two real bugs closed; one new reusable component. |
| **2** | Build the NEW `components/ui/` primitives required either by this document or already scheduled by doc 15: `Modal`, `Input`, `Card`, `Switch`, `StatusPill`, `Tooltip`, `Popover`. | The empty `components/ui/` folder (§ "verified current state," one file today) becomes a real library. |
| **3** | AI Employee Card full spec (§10.6), replacing `EmployeeCard.tsx`'s inline styles and the duplicated `secondaryBtnClass` string. | The signature card, all 5 states. |
| **4** | Workflow node visual layer (§10.6/10.7 in the component section): `WorkflowNodeCard`, `WorkflowEdgeLine`, handle styling — built alongside doc 15's `WorkflowCanvas` interaction work, not before it, since they share the same files. | Matches doc 15's own folder plan (`15-frontend.md:171-176`). |
| **5** | Table primitive (§10.5) with virtualization, density modes, and the shared empty/error/loading states (§10.8) — applied first to the highest-row-count existing screen (NOT VERIFIED which one has the most rows today; recommend checking before starting). | One real, reusable enterprise table, not five bespoke ones. |
| **6** | Opportunistic hex-soup migration (§2.5 phase 2) across `AppShell`/`Sidebar`/`Topbar`/`StatTile`/auth `fields.tsx` — done incrementally as those files are touched for other reasons, verified no-diff each time. | The dark theme becomes actually tokenized, not just visually consistent by coincidence. |
| **7** | Print stylesheet (§11.5) wired for the first real printable/exportable surface (analytics report or audit-log export — NOT VERIFIED which ships first). | The light theme's first real, visible job. |
| **8** | Revisit `enableSystem`/a real "Appearance" toggle once migration coverage is high enough that flipping themes doesn't leave half a screen dark (§2.5 phase 3/4). | Light theme becomes a real, user-facing choice — deliberately last, not first. |
