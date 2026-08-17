# Orlixa design-system baseline

What the frontend looked like **before** any change in this pass. Written first,
from the repository and from a real browser, so the fixes that follow can be
judged against something factual.

Sources: `packages/config/tailwind-preset.cjs`, `apps/web/src/app/globals.css`,
`apps/web/tailwind.config.js`, the app shell, auth shells, marketing-dark
components, and a rendered-DOM sweep of 15 pages at two viewports.

---

## 1. Colours — three systems in one preset

The preset is not one palette. It carries three, with no shared vocabulary:

| System | Tokens | Intent |
|---|---|---|
| **Workforce Ledger** (light) | `paper` #FAFAF8, `paper-2`, `surface` #FFF, `ink` #14151A / 70 / 40 / 25, `line`, `brand` indigo 50–900, `warm`, `amber`, `coral`, `mint`, `midnight` | "Swiss-editorial on warm paper" — a light print-like theme |
| **Dark marketing** | `void` #030408 / section #0C0E14 / card #0F1017 / card-hover #171923, `violet` #5E3CE8 / hover #7659F0 / secondary #8B6EF2 / accent #6D3FE0, `gold` #F0B90D | The dark site + app surfaces |
| **Workflow Builder** | `canvas` #02030A / grid, `cat.*` (employee/trigger/approval/tool/knowledge/memory/logic/data), `wf.ink` #F5F6FA / ink-2 #A6ADBB / ink-3 #6B7280, `wf.hairline`, `wf.focus`, `wf.ok`, `wf.error` | Node canvas |

### Conflicting brand accents
Three different purples were in play as "the brand colour":

| Where | Value |
|---|---|
| `brand.600` (Workforce Ledger CTA, `g-cta` gradient) | `#4F46E5` |
| `violet.DEFAULT` (marketing + app) | `#5E3CE8` |
| `dark-cta` gradient | `#7C3AED` → `#9333EA` |
| Auth submit button (inline, not a token) | `#6a30ec` → `#5216dd` |

### The root contradiction
`globals.css` set the page canvas to the **light** system:

```css
body { @apply bg-paper font-sans text-ink antialiased; }   /* #FAFAF8 on #14151A */
```

Every screen — marketing, auth, onboarding, app — then painted a dark surface on
top. So the product was a dark sheet laid over a white page. Consequences:

- anything that failed to paint its own background (a mis-sized container, a
  route transition, an overscroll bounce) showed **white**;
- any text that inherited `color` arrived **near-black on near-black**;
- automated tooling that resolves "what is behind this text" walks up to `body`
  and gets the wrong answer — this is not hypothetical, it made the first
  contrast run report 47 false CRITICALs.

## 2. Typography

| Role | Before |
|---|---|
| `font-sans` (the app) | Helvetica Neue, Helvetica, Arial, Segoe UI, Roboto, system-ui |
| `.font-marketing` | Inter via `next/font/google` — used by marketing, auth and the app shell |
| Workflow display | Space Grotesk |

So the product already had an intentional production font (**Inter**) applied
through `.font-marketing`, while the Tailwind `sans` default underneath it was a
different, older Helvetica stack. Per the directive's rule ("if an existing
approved font exists, keep it"), Inter is kept and is what every audited screen
actually renders.

Sizes were mostly Tailwind's scale, with arbitrary values in places
(`text-[15px]`, `text-[11px]`, `text-[10px]`). Weights ranged 400–900, including
`font-black` on the marketing hero.

## 3. Spacing, radius, shadows

- Radius tokens: `card` 6px, `btn` 8px, `node` 14px, `dark-lg` 24px, `dark-btn` 16px, plus ad-hoc `rounded-xl`/`rounded-2xl`/`rounded-full` throughout.
- Shadows: `card`, `lift`, `cta`, `warm`, `dark-card`, plus inline `shadow-[0_14px_34px_-12px_rgba(...)]` on buttons and cards.
- Spacing followed Tailwind's 4px rhythm; no systemic violations found.

## 4. Measured accessibility problems

A rendered-DOM sweep (15 pages × 2 viewports, real Chromium, computed colour vs
resolved background vs inherited opacity vs actual size/weight):

| Defect | Ratio | Count | Where |
|---|---|---|---|
| `text-zinc-600` (#52525B) as muted text on the near-black canvas | **2.62–2.66** | 10 CRITICAL + 54 HIGH | dashboard, skills, billing, sidebar |
| `text-zinc-500` (#71717A) as secondary text | 3.58–4.19 | 56 HIGH | **11 of 15 pages** |
| `wf-ink-3` (#6B7280) node/meta text | 3.58–4.19 | 7 HIGH | workflows |
| `text-white/80` on the violet CTA band | 4.22 | 2 MEDIUM | home |
| Sub-caption text (`text-[10px]`, `text-[11px]`) carrying real information | — | 49 uses | sidebar section labels, skill/billing meta |
| **Primary submit buttons had no focus indicator at all** | — | 2 | `/login`, `/register` |
| **No navigation on mobile**: the sidebar is `hidden lg:flex` and nothing replaced it — exactly **1** reachable link at 390px | — | every app page | app shell |
| Dashboard scrolled sideways at 390px | — | 1 | `/dashboard` |

Totals before fixes: **CRITICAL 10 · HIGH 125 · MEDIUM 167 · 1 overflow page.**

## 5. Duplicate / conflicting tokens

- Three purples for one brand accent (above), plus a fourth hardcoded inline in the auth buttons.
- Two greys doing the same "muted text" job (`zinc-500`, `zinc-600`) with neither passing AA on the surfaces they were used on.
- `wf-ink-3` duplicating that muted role a third time, with a third value.
- A light system (`paper`/`ink`/`line`/`brand`) that only `components/ui/Button.tsx` still references, while `body` applied it to every page.

## 6. Pages using inconsistent styles

- **Auth** had two shells: a centred card for five screens and a split video layout for login alone, so signing in and then verifying your email looked like two different products. (Consolidated in this pass.)
- **Pricing** existed twice with different numbers — the home section sold "Pro $99" while the pricing page sold "Business $99". (Consolidated to one source in this pass.)
- **Marketing nav** linked every item to `#`.

## 7. What was already good

Worth recording so it is not "fixed":

- One dark surface scale (`void`) used consistently across marketing and app.
- Inter already applied everywhere that matters, via `.font-marketing`.
- Focus rings already present on most inputs, dialogs and the workflow canvas.
- Status colours (`mint`, `amber`, `coral`, `wf.ok`, `wf.error`) already paired with icons and text, not colour alone.
