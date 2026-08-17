# Orlixa design-system QA report

Real Chromium, real running app (`localhost:3200` + API `localhost:4000`), real
signed-in session. Baseline this is measured against:
`orlixa-design-system-baseline.md`.

Tools written for this pass, re-runnable as a gate:

| Tool | What it proves |
|---|---|
| `e2e/tools/contrast-audit.mjs` | Every rendered text node's contrast, using computed colour, the resolved background (including gradient stops), inherited opacity, and the actual size/weight |
| `e2e/tools/layout-a11y-probe.mjs` | Horizontal overflow at 8 viewports; whether tabbing to a control visibly changes anything |
| `e2e/tools/overflow-probe.mjs` | Names the element causing a sideways scroll |
| `e2e/tools/screens.mjs` | Evidence screenshots → `e2e/report/screens/` |

---

## Result

| Metric | Before | After |
|---|---|---|
| CRITICAL contrast defects | 10 | **0** |
| HIGH contrast defects | 125 | **0** |
| MEDIUM contrast defects | 167 | **0** |
| Pages scrolling sideways | 1 (of 15 × 2) | **0** (of 15 × 8 viewports) |
| Controls with no visible focus | 2 | **0** |
| Reachable nav links on a phone | 1 | **15** |

Viewports swept: 1440×900, 1366×768, 1280×800, 1024×768, 768×1024, 430×932,
390×844, 375×812.

Pages audited (15): `/`, `/pricing`, `/login`, `/register`, `/forgot-password`,
`/dashboard`, `/employees`, `/skills`, `/knowledge`, `/workflows`, `/runs`,
`/approvals`, `/billing`, `/organization`, `/team`.

---

## Defects found and fixed

| # | Page(s) | Viewport | Issue | Root cause | Fix | Verified |
|---|---|---|---|---|---|---|
| 1 | dashboard, skills, billing, sidebar | all | Muted text at **2.62–2.66** — below AA by a wide margin | `text-zinc-600` (#52525B) used as muted text on a near-black canvas | New measured `fg.subtle` #8B8B94 (6.00 on canvas, 5.13 on the lightest card); 41 call sites | PASS |
| 2 | 11 of 15 pages | all | Secondary text at **3.58–4.19** — under the 4.5 body threshold everywhere | `text-zinc-500` (#71717A) | New `fg.muted` #9CA3AF (7.98 / 6.82); 251 call sites | PASS |
| 3 | workflows | all | Node/meta text at 3.58–4.19 | `wf.ink-3` = #6B7280 | Token raised to #9CA3AF | PASS |
| 4 | home | all | CTA body copy at 4.22 on the violet band | `text-white/80` | `text-white/90` (4.9) | PASS |
| 5 | sidebar, skills, billing | all | 10–11px text carrying real information | arbitrary `text-[10px]` / `text-[11px]` | Raised to the 12px caption step | PASS |
| 6 | **every app page** | ≤ lg | **No navigation at all on mobile** — 1 reachable link | Sidebar is `hidden lg:flex`; nothing replaced it | Drawer: menu trigger in the topbar, `role="dialog"` + `aria-modal`, Escape to close, body scroll lock, auto-close on navigate | PASS — 1 → 15 links, verified in browser |
| 7 | `/login`, `/register` | all | Primary submit button showed **nothing** on keyboard focus | Button styled hover + glow, no focus rule | `focus-visible` ring, offset outside the violet surface | PASS — 0 controls without visible focus |
| 8 | dashboard | 390×844 | Whole page scrolled sideways (scrollWidth 659 vs 390) | Grid item defaults to `min-width:auto`, so the 7-column table grew the column and the wrapper's `overflow-x-auto` could never fire | `min-w-0` on the grid section | PASS — scrollWidth 390 |
| 9 | every page | all | Dark product rendered on a **light** `body` canvas — white flashes on any unpainted area, inherited near-black text | `body { @apply bg-paper text-ink }` from the light "Workforce Ledger" system | `bg-void` + `text-white` | PASS |

### Not defects — recorded, deliberately not "fixed"

| Observation | Why it stands |
|---|---|
| Disabled buttons measure ~3.25 (white at 60% on violet) | They are switched off and must read that way; WCAG exempts disabled components. The audit now excludes them rather than inviting a fix that removes the signal. |
| Gradient-filled headings (`bg-clip-text` + transparent colour) | Painted by their background, not `color`; a computed ratio would be fiction. Reported separately. |

### Corrections to the measurement itself

Two tool bugs were found and fixed before trusting any number — worth recording,
because both would have caused wrong work:

1. **47 false CRITICALs.** The background walk fell through gradients to `body`,
   which carried the light canvas, so white-on-dark hero text scored as
   white-on-white. Fixed by resolving a gradient's own colour stops.
2. **Three pages measured as a fourth.** A signed-in browser redirects `/login`
   and `/register` to `/dashboard`, so the auth screens were never audited and
   the dashboard was counted three times. Fixed with separate anonymous and
   authenticated contexts.

---

## Design system now in place

**Colour.** One measured foreground scale in the shared preset, replacing three
competing greys:

```
fg.DEFAULT   #FFFFFF
fg.secondary #D1D5DB
fg.muted     #9CA3AF   7.98 on #05060A · 6.82 on #171A26
fg.subtle    #8B8B94   6.00 · 5.13
fg.disabled  #6B7280   4.19 — intentionally below AA; disabled must read as off
```

Every step clears AA on the darkest surface **and** the lightest card, so a muted
label stays readable wherever the card it sits on happens to be.

**Typography.** Inter, already applied through `.font-marketing`, kept and
standardised around; the caption floor is now 12px.

**Canvas.** `body` is the product's real surface (`void` #030408), not the light
paper theme.

---

## Gates

| Gate | Result |
|---|---|
| `tsc --noEmit` (web) | PASS |
| `pnpm -w run lint` | PASS — 0 errors (1 pre-existing warning in the API) |
| `pnpm build:web` | PASS — compiled, 32 static pages |
| Web unit tests | PASS — 93/93 |
| Browser journeys (`e2e/`) | 8/8 PASS — run after the token sweep, **before** defects 6–8 were fixed |
| Contrast audit | PASS — 0/0/0 |
| Layout + focus probe | PASS — 0 overflow, 0 focus failures |

Evidence: `e2e/report/contrast-audit.json`, `e2e/report/layout-a11y.json`,
24 screenshots in `e2e/report/screens/` plus `dashboard-phone-nav-open.png`.

## Honest gaps

- The 8/8 browser-journey run predates the mobile-nav, focus-ring and
  `min-w-0` fixes. Those three were each verified directly in the browser
  (link count 1→15, focus failures 2→0, scrollWidth 659→390), but the journey
  suite has not been re-run since. Re-run it before release.
- `/onboarding`, `/analytics`, `/settings` and `/workflows/[id]` were **not**
  audited: the first three have no route in this build and the fourth needs a
  published workflow, which the seeded tenant does not have.
- Hover, loading, empty and error states were not systematically swept — only
  the states these pages happened to be in. Empty states were covered
  incidentally (the seeded tenant is nearly empty).
- The light "Workforce Ledger" palette still exists in the preset and is still
  referenced by `components/ui/Button.tsx`. It is now unreachable as a page
  canvas but has not been removed.

---

# Addendum — the light app canvas (2026-08-16)

The product moved from dark-everywhere to **dark sidebar + light main content**,
on the customer's decision. This is what that took and what it found.

## Scope of the change

| Stays dark | Turns light |
|---|---|
| Sidebar + mobile nav drawer | Every signed-in page's main content |
| Marketing site (`/`, `/pricing`) | Topbar |
| Auth pages + `AuthShell` | Cards, tables, forms, badges, dialogs |
| Onboarding | AI Assist landing + workspace chat column |
| Workflow **builder canvas** (`builder/canvas/`, doc 29) | Everything around the canvas |

Two new token groups in `packages/config/tailwind-preset.cjs`, both with the
measured ratios recorded beside them:

- `app.*` — the light canvas scale (`bg`/`surface`/`raised`/`tint`/`border`/
  `border-strong` + `ink` … `ink-4`). `ink-4` is deliberately below AA and
  documented as placeholder/disabled-only.
- `sl.*` — status colours **re-picked for white**. The existing `status.*` scale
  was chosen against a near-black canvas: on white, `succeeded` measures 1.85,
  `waiting` 1.93, `escalated` 2.50, `pending` 2.70, `failed` 3.14 and `running`
  3.62 — every one under AA. `sl.*` keeps the meanings and clears 4.5; `status.*`
  is untouched so the dark canvas keeps its hues.
- `violet.bright` — for text on a violet **tint** over a dark surface, where
  `violet.secondary` drops to ~4.0.

## What a mechanical sweep gets wrong (worth reading before the next one)

Class-for-class replacement is the fast way to do this and it introduces real
bugs. Every one of these was caught, none by typecheck:

1. **`text-white` is usually right.** It sits on violet buttons and coloured
   chips. A blanket flip turned the Topbar avatar into near-black on violet. The
   rule that worked: only flip `text-white` on a class string that paints **no**
   background of its own; leave the rest to the contrast audit.
2. **Shared components cross theme boundaries.** `features/auth/*` and
   `builder/canvas/*` were swept by accident and had to be reverted — the auth
   forms live on a dark panel and the canvas is its own dark design system.
3. **An empty input has no text, so the contrast audit cannot see it.** The
   shared `.field-modern` kept its dark-theme 3%-white fill and 10%-white
   border; on a white card both vanish. **26 controls across 7 screens** had a
   fill AND border ratio of 1.00 — invisible, and passing every check. Fixed
   with an `.app-light .field-modern` override, hooked off a class on `AppShell`.
   New tool: `e2e/tools/field-visibility-probe.mjs`.
4. **`divide-white/[0.06]` row separators** disappear the same way, for the same
   reason, and are equally invisible to a text-contrast audit.
5. **Badge tone maps are theme-specific.** The `-300`/`-400` steps that read on
   near-black measure 1.48–3.74 on white. Moved to `-700`, then to `-800`
   wherever the badge sits on its own `/15` tint (which lifts the background
   enough to cost ~0.5).

## Three audit defects that were producing false passes

The contrast audit had been reporting clean on pages it never actually measured.

| Defect | Effect | Fix |
|---|---|---|
| `needsAuth = APP.includes(path)` | Any path given on the command line — every detail URL — opened in the **anonymous** browser, bounced to `/login`, and the 10-node sign-in form was reported as that page passing | Invert: only marketing + auth are anonymous |
| Fixed 1.2s settle | Heavier screens were measured as loading skeletons and scored `CRITICAL=0` | Wait for `networkidle`, then until the rendered text stops growing |
| Translucent backgrounds skipped | The walk fell past `bg-green-600/90` to the white card behind and scored the **Approve** button white-on-white (1.00) instead of its true 2.93 | Composite the translucent layer stack onto the first opaque surface |

The audit now also reports pages it could **not** measure (redirected, still
loading, or almost no text) rather than counting them as passes. Adding these
three fixes turned a "0 findings" run into 35 real findings, all since fixed.

## A crash the redesign surfaced

`/assist/[sessionId]` died with *"Element type is invalid … got: undefined"* —
the entire workspace, blank. Cause: `assist-test-tool.ts` did
`row.status as AssistTestStep['status']`. A cast is not a conversion. The DB
enum `StepRunStatus` has **eight** members, the DTO union had four, and any step
in one of the other four reached the browser as a string the icon map had no
entry for. **An approval gate leaves its step `WAITING`** — so this was on the
happy path of the very feature the panel exists to explain.

Fixed at both ends: a total `stepStatusFor()` on the server, `WAITING` added to
the union, and the client maps typed `Record<AssistTestStep['status'], …>` so
the next added state fails the build instead of the page. The client also falls
back rather than rendering `undefined`, because a bad value on the wire should
cost a generic dot, not a screen.

**This one predates the redesign** — verified by stashing the changed files and
reproducing the crash without them.

## Other real defects fixed

- **AI Assist user chat bubble**: `bg-violet/25` over the light canvas is pale
  lavender; the white text on it measured **1.06**. Now solid `violet` (6.39).
- **Approve button**: `green-600/90` composites to rgb(45,172,92) → 2.93. Now
  solid `green-700` (5.02). It is the one control in the product that commits an
  irreversible action.
- **Assist workspace slid sideways on a phone** (scrollWidth 571 vs 390). Cause
  was one `sr-only` span: `position:absolute` with no positioned ancestor, so it
  escaped the stage rail's `overflow-x-auto` and stretched the document. Fixed
  with `relative` on the rail (plus `min-w-0 overflow-x-hidden` on the page).
- Workflow-name input in the canvas footer went dark-on-dark in the sweep.

## Verification (2026-08-16, real browser, dev server on :3200)

| Check | Result |
|---|---|
| Contrast audit — 17 pages × 2 viewports | **CRITICAL=0 HIGH=0 MEDIUM=0**, overflow 0 |
| Contrast audit — detail pages (`/assist/<id>`, `/employees/<id>`, `/workflows/new`) | **0/0/0**, overflow 0 |
| Field-visibility probe — 12 screens | **0 invisible controls** |
| `tsc --noEmit` — `@vaep/web` and `@vaep/api` | clean |
| AI Assist flow, live | button disabled→enabled, `POST /assist/sessions` 201, routed to `/assist/<id>?start=1`, workspace renders, 0 page errors |
| Screenshots | `e2e/report/screens/` (26 files, desktop + phone) |

**A Tailwind preset change does not reach a running dev server.** The preset is
`require`d, so Node's module cache holds the old copy and the new tokens simply
are not in the CSS — `bg-app-*` resolved to nothing and the "light" app rendered
dark while the audit happily reported 0 findings. Restart the dev server after
touching `tailwind-preset.cjs`, and verify a new token is really in the served
CSS before trusting any measurement.

## Still open

- The **Playwright journey suite has not been re-run** since this conversion.
- On a STARTER plan the AI Assist page renders in full but every action returns
  403 (`This feature requires the BUSINESS or ENTERPRISE plan`). The inline error
  is correct and this predates the redesign, but the page should probably say so
  before the user types a prompt.
- `/schedules` at 390px is reported as "almost no text" — it is a genuine empty
  state, not a render failure.
- The light "Workforce Ledger" palette (`paper`/`ink`/`line`/`brand`) still
  exists in the preset alongside the new `app.*` scale. Two light systems is one
  too many; `components/ui/Button.tsx` still uses `brand`.
