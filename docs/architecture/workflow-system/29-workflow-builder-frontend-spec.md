# Orlixa V-AEP — Workflow Builder · Frontend Specification

> **Status:** Implementation-ready design specification (no code — spec only).
> **Scope:** The complete production Workflow Builder UX for the AI Employee Platform.
> **Grounded in (frozen contracts):** `05-execution-engine`, `13-api`, `14-json-contract`, `15-frontend`, `16-workflow-runtime-spec`, `17-node-library-spec`, `26-mvp-node-contract-freeze`, `27-hr-employee-workflows`, `28-marketing-employee-workflows`, plus the shipped P3 backend (templates, permissions, approval routing + SLA). Every endpoint/field is verified against shipped code; unconfirmed dependencies are flagged in Appendix C.
> **Stack:** Next.js App Router · Tailwind · TanStack Query · Zustand · react-hook-form + zod. Reuses the shipped dark/violet Orlixa theme.

## Backend delta (2026-08-02) — several Appendix-C.2 degrades are now obsolete

The backend gaps this spec surfaced have been partly closed; the frontend can now consume real contracts instead of degrading:
- **Node registry:** `GET /workflows/node-definitions` → `NodeDefinitionDto[]` (category, label/description, `inputs`, `outputs[]` with named branches, `configSchema[]`, `hasSideEffects`, `canPauseForApproval`, `dynamicOutputs?`). **Replaces the client node-registry.** Note the shipped shape is flat `outputs` (not `handles.outputs`) and `canPauseForApproval` (not `pausesRun`) — reconcile field names when wiring. `GET /workflows/node-types` still returns `{ types }` (back-compat).
- **DTO fields shipped:** `WorkflowDto` now has `ownerUserId`, `activeVersionId`, `draftVersionId`, `category`. `WorkflowRunDto` now has `failureClass`, `resumeNodeId`, `startedByUserId`, `workflowVersionId`. `WorkflowStepRunDto` now has `attempt`. `UserDto` now has `departmentId`, `teamId`, `managerUserId` (so the routing/permissions subject pickers group by dept/team from `GET /users`).
- **Run controls shipped:** `POST /workflows/runs/:id/cancel` (non-terminal → CANCELLED; authoritative for PENDING/WAITING, best-effort for RUNNING) and `POST /workflows/runs/:id/retry` (starts a fresh run, never resurrects). The RunBar cancel/retry are no longer disabled-with-reason.
- **EVENT single-active is now ENFORCED** (not just warned): activating a 2nd EVENT workflow with the same eventType + overlapping connector → **409**. The ActivateConfirm can rely on the server rejecting the conflict.
- **Directory pickers confirmed shipping:** `/users` (now with dept/team), `/departments`, `/teams`, `/employees` (role incl. `MARKETING` — G10 is closed), `/billing/subscription`, `/skills/installed`. Knowledge categories = the static `EMPLOYEE_ROLES` constant + Shared (no endpoint needed).

**Still deferred (documented):** the realtime WS gateway (P5-01 — the `seq`-outbox machinery exists but only the state-machine engine writes it, and it's off by default; the 1s poll remains the path for all companies); the dedicated `/runs/:id/timeline` · `/attempts` · `/tool-calls` routes + `compensate` (P5-02/03 — the DebugPanel uses `getRun`'s steps + the new `attempt` field); version `diff`/`rollback`/`clone` (client composes from `GET version` + `PUT /draft`); a live Slack channel picker (free-text channel is the honest degrade); AI-employee `avatarUrl` (role icons + initials).

## Design thesis

The builder is a **roster you delegate to, not a board you wire.** The canvas reads top-to-bottom as one plain sentence — *“When a candidate emails, **Emma (HR)** reads the CV, **the Recruiter** signs off, then the email goes out”* — and it makes the safety seam physically visible: an AI Employee **drafts**, a named human **approves**, and only then does a tool **act**. The single signature move: `AI_EMPLOYEE_STEP` nodes render as **people** (portrait, real name, role badge), while everything mechanical — logic, data, timing, tools — is deliberately *under-designed* into quiet slate instruments. The eye always lands on *who is doing the work* and *who is signing off*. That tension — an org-chart of people living inside a flowchart of operations — is the product truth, and it is what makes this an **AI Employee Operating System** and not another node-wiring tool.

## How to read this

Every component defines the same 12 attributes: **purpose · states · interactions · props · data requirements · API dependencies · responsive · keyboard · accessibility · loading · error · disabled.** Sections 1–2 are the shared foundation (tokens, node visual language, interaction model, IA) that every component inherits; Section 3 specs each surface; the appendices give the API-dependency matrix, the full state inventory, resolved decisions + unconfirmed deps, and a build order.

## Table of contents
- **1. Foundations** — thesis, design tokens, typography, node visual language, status colors, edge language, motion, z-index *(Spine Part 1)*
- **2. Interaction model & information architecture** — canvas interactions, keyboard shortcuts, context menus, animation system, IA + builder shell, global loading/error/empty/disabled patterns, a11y + responsive strategy *(Spine Part 2)*
- **3. Components**
  - 3.A Entry surfaces — Workflow list · Create workflow · Template selection
  - 3.B Canvas system — infinite canvas · connection validation · edges · canvas interactions
  - 3.C Node library · search · add-node
  - 3.D Node cards — AI Employee · Trigger · Logic · Skill · Approval · Knowledge · Memory
  - 3.E Inspector — config forms · param binding · approval routing · permissions
  - 3.F Execution & observability — live run · debug panel · run history
  - 3.G Lifecycle & system states — version history · publish flow · errors · empty · loading · disabled
- **Appendices** — A: API dependency matrix · B: state inventory · C: decisions + unconfirmed deps · D: build order · E: key files

---

# DESIGN SPINE

## Part 1 — Identity + Visual System
# ORLIXA V-AEP WORKFLOW BUILDER — DESIGN SPINE, PART 1

## Identity + Visual System (foundation the whole builder inherits)

All tokens below are grounded in the shipped codebase palette (`packages/config/tailwind-preset.cjs`, `globals.css`) and extend it — nothing here contradicts the dark/violet app. New values are additive and named so they can drop straight into the Tailwind preset.

---

## 1. THE THESIS

The builder is a **roster you delegate to**, not a board you wire. The canvas reads top-to-bottom as one sentence — *"When a candidate emails, **Emma (HR)** reads the CV, **the Recruiter** signs off, then the email goes out"* — and the graph makes the safety seam physically visible: an AI Employee **drafts**, a named human **approves**, and only then does a tool **act**. The ONE signature element is that **`AI_EMPLOYEE_STEP` nodes are rendered as people** — a portrait avatar, the employee's real name as the title, a role badge (HR / Marketing) — categorically unlike every other node, which is a quiet instrument. Everything else on the canvas (logic, data, timing, tools) is deliberately *under-designed*: small, monochrome, low-contrast plumbing, so the eye is always drawn to *who is doing the work* and *who is signing off*. We deliberately do **NOT** ship: rainbow node palettes, a generic "function box" grid, an `error`-port on every node (the engine has none), decorative step numbers, or n8n's symmetric left-right node farm. The real aesthetic risk we take is **mixing two visual languages on one surface** — an org-chart of *people* (portrait cards) living inside a flowchart of *operations* (instrument chips). It could read as inconsistent; we justify it because that tension *is the product truth*: a managed AI employee is simultaneously a colleague and a process step, and making the employee card look like a hired person — while its tools look like machinery — is exactly what stops this from feeling like Zapier with a violet skin.

---

## 2. DESIGN TOKENS

### 2.1 Color — surfaces & canvas (reuse of shipped `void` scale)

| Token | Hex | Use |
|---|---|---|
| `canvas` | `#02030A` | React Flow canvas backdrop (matches AppShell literal) |
| `canvas-grid` | `#0B0E18` | dot-grid pattern dots (12px pitch, 1px, opacity via color) |
| `surface-void` | `#030408` | deepest wells, minimap frame |
| `surface-section` | `#0C0E14` | docked panel bodies (Inspector, Timeline, Library) |
| `surface-card` | `#0F1017` | node fill base |
| `surface-card-hover` | `#171923` | node hover / list-row hover |
| `surface-raised` | `#0B0D18` | popovers, dropdowns, Run popover (matches Topbar dropdown) |

### 2.2 Color — violet accent (verbatim from shipped `violet` token) + brand gradient

| Token | Hex | Use |
|---|---|---|
| `violet` | `#5E3CE8` | primary accent, selection ring, active handle |
| `violet-hover` | `#7659F0` | hover on violet controls |
| `violet-secondary` | `#8B6EF2` | RUNNING accent, focus glow, branch-True |
| `violet-accent` | `#6D3FE0` | secondary emphasis |
| `violet-cta-from` | `#6A30EC` | primary-CTA gradient start (Save/Publish/Run) |
| `violet-cta-to` | `#5216DD` | primary-CTA gradient end |
| `violet-wash` | `rgba(94,60,232,0.12)` | selected-node fill wash, active-nav wash |
| `gold` | `#F0B90D` | WAITING / human-gate / approval accent |

> Primary CTAs reuse the shipped custom gradient `linear-gradient(135deg,#6A30EC 0%,#5216DD 100%)` with `shadow-[0_14px_34px_-12px_rgba(91,33,230,0.85)]`. `Button variant="violet"` remains the secondary-action button.

### 2.3 Color — node category accents (the left-rail / tone-badge color per bucket)

Each category owns exactly ONE accent, applied only to a 3px left identity-rail + the 32px tone-badge — never as a full fill (fills stay `surface-card`). This is what lets category read at a glance without labels.

| Category | Token | Hex | Icon language (lucide, verified ≤1.24) |
|---|---|---|---|
| AI Employee | `cat-employee` | `#8B6EF2` (violet-secondary) | `user-round` in avatar; role dot |
| Trigger | `cat-trigger` | `#22D3EE` (cyan) | `zap` / `calendar` / `webhook` / `mouse-pointer-click` |
| Approval (human gate) | `cat-approval` | `#F0B90D` (gold) | `shield-check` / `stamp` |
| Skill / Tool | `cat-tool` | `#2DD4BF` (teal) | `wrench` + skill glyph (`mail`, `calendar`, `message-square`) |
| Knowledge | `cat-knowledge` | `#818CF8` (indigo) | `search` / `book-open` |
| Memory | `cat-memory` | `#A78BFA` (soft violet) | `brain` (read) / `bookmark-plus` (write) |
| Logic | `cat-logic` | `#94A3B8` (slate) | `git-branch` / `split` / `git-merge` / `repeat` / `octagon-x` |
| Data | `cat-data` | `#64748B` (muted slate) | `variable` / `filter` |
| Timing / Utility | `cat-util` | `#475569` (dim slate) | `clock` / `circle` |

Rationale: employees and their approvers get the two *warmest, most saturated* accents (violet + gold) — the two things a manager cares about. Everything mechanical decays toward slate. Colour saturation itself encodes "how much a human should care."

### 2.4 Color — edges, text, focus, feedback

| Token | Hex / value | Use |
|---|---|---|
| `edge-idle` | `rgba(255,255,255,0.16)` | default connection |
| `edge-hover` | `#7659F0` | hovered/selected edge |
| `edge-live` | `#8B6EF2` | animated `flow` dash during a run |
| `edge-invalid` | `#F87171` | illegal connection (red dashed) |
| `edge-pending` | `rgba(139,110,242,0.6)` | in-progress drag (violet dashed) |
| `text-primary` | `#F5F6FA` | node titles, headings |
| `text-secondary` | `#A6ADBB` | subtitles, hints, muted labels |
| `text-muted` | `#6B7280` | disabled, placeholder, metadata |
| `text-on-accent` | `#FFFFFF` | text on violet/gold fills |
| `border-hairline` | `rgba(255,255,255,0.07)` | card/panel borders (shipped convention) |
| `border-hover` | `rgba(255,255,255,0.14)` | hover borders |
| `border-node` | `rgba(255,255,255,0.08)` | node card border (shipped `WorkflowDiagram`) |
| `focus-ring` | `#8B6EF2` | `:focus-visible` (shipped globals ring) |
| `feedback-ok` | `#34D399` | inline "Saved." text |
| `feedback-error` | `#F87171` | inline error text (shipped `text-red-400` family) |

### 2.5 Typography — a deliberate 3-face pairing

Loaded via `next/font` (all Google-served, self-hosted at build, no CLS). Inter is already in the app; we add **one** display face for personality and pin a mono for config/JSON.

| Role | Family | Why (deliberate, not default) |
|---|---|---|
| **Display** | **Space Grotesk** (500/600/700) | Node employee names, panel titles, section headers, toolbar workflow name. Its slightly mechanical, humanist-geometric letterforms read as *"software with a personality"* — warm enough for a person's name, precise enough for a system. This is the "typography carries personality" spend. |
| **Body / UI** | **Inter** (`var(--font-inter)`, 400/500/600) | Every inspector form, list, hint, button, dense metadata. Already loaded; unbeatable at 11–14px on dark. |
| **Mono** | **JetBrains Mono** (400/500) | Node ids, `{{templates}}`, branch labels, JSON fields, `outputKey`, status codes. Signals "this is a literal, verbatim value." |

**Type scale (px / line-height / weight / tracking):**

| Token | Size/LH | Weight | Face | Use |
|---|---|---|---|---|
| `display-lg` | 22 / 28 | 600 | Space Grotesk | Inspector title, workflow name in toolbar |
| `display-md` | 18 / 24 | 600 | Space Grotesk | Panel section headers |
| `node-title` | 14 / 18 | 600 | Space Grotesk | Node title / employee name |
| `body` | 13 / 18 | 400 | Inter | default UI text |
| `body-strong` | 13 / 18 | 600 | Inter | field labels, buttons |
| `subtitle` | 12 / 16 | 400 | Inter | node subtitle, hints (`text-secondary`) |
| `caption` | 11 / 14 | 500 | Inter | badges, chips, metadata (tracking +0.02em, uppercase for eyebrows) |
| `mono-sm` | 12 / 16 | 400 | JetBrains Mono | config values, node id |
| `mono-xs` | 11 / 14 | 400 | JetBrains Mono | branch labels, seq numbers |

### 2.6 Spacing scale (4px base — matches shipped `p-5`/`rounded-2xl` usage)

`space-0.5=2 · space-1=4 · space-2=8 · space-3=12 · space-4=16 · space-5=20 · space-6=24 · space-8=32 · space-10=40 · space-12=48`. Node internal padding = `space-3` (12px). Panel padding = `space-5` (20px). Canvas node-to-node dagre gap = 48px rank / 32px node.

### 2.7 Radius scale (extends shipped `rounded-node:14`)

| Token | px | Use |
|---|---|---|
| `radius-sm` | 4 | inner chips, status dot container |
| `radius-card` | 6 | inspector sub-cards |
| `radius-btn` | 8 | buttons, inputs (`.field-modern`) |
| `radius-tone` | 10 | 32px tone-badge (shipped `rounded-lg`) |
| `radius-node` | 14 | **all standard node cards** (shipped `rounded-node`) |
| `radius-lg` | 16 | employee person-card (slightly larger to distinguish) |
| `radius-xl` | 24 | panels, modal (shipped `dark-lg`) |
| `radius-pill` | 999 | trigger lozenge, branch labels, badges, avatar |

### 2.8 Elevation / shadow (dark-tuned)

| Token | Value | Use |
|---|---|---|
| `elev-node` | `0 10px 40px rgba(0,0,0,0.45)` | node rest (shipped `shadow-dark-card`) |
| `elev-node-hover` | `0 14px 48px rgba(0,0,0,0.55)` | node hover |
| `elev-selected` | `0 0 0 2px #5E3CE8, 0 0 24px -6px rgba(94,60,232,0.7)` | selected node (ring + violet glow) |
| `elev-running` | `0 0 0 1.5px #8B6EF2, 0 0 28px -4px rgba(139,110,242,0.55)` | running node halo (animated `breathe`) |
| `elev-waiting` | `0 0 0 1.5px #F0B90D, 0 0 24px -6px rgba(240,185,13,0.45)` | waiting-on-approval node |
| `elev-panel` | `0 24px 70px rgba(0,0,0,0.6)` | docked Inspector / popover / modal |

### 2.9 Motion tokens (deliberate; reduced-motion already killed globally in `globals.css`)

| Token | Value | Use |
|---|---|---|
| `dur-fast` | 120ms | hover, focus, button press |
| `dur-base` | 180ms | node select, panel field reveal |
| `dur-slow` | 240ms | inspector slide-in, edge highlight |
| `ease-standard` | `cubic-bezier(0.2, 0, 0, 1)` | most transitions |
| `ease-out` | `cubic-bezier(0.16, 1, 0.3, 1)` | panel/inspector enter |
| `ease-in` | `cubic-bezier(0.4, 0, 1, 1)` | element exit |
| `anim-flow` | `flow 2.4s linear infinite` | live edge dash (shipped keyframe — do not reinvent) |
| `anim-breathe` | `breathe 3.6s ease-in-out infinite` | RUNNING node halo (shipped) |
| `anim-pulseDot` | `pulseDot 2.4s ease-out infinite` | RUNNING status dot ping (shipped) |

Motion discipline: **only running/live state animates.** Selection, hover, and validity are instant/static — motion is reserved to mean "something is happening right now," so a live run is unmistakable and a static canvas is calm.

### 2.10 Z-index layers

| Layer | z | Contents |
|---|---|---|
| `z-canvas` | 0 | background, dot-grid |
| `z-edges` | 1 | edge paths + branch labels |
| `z-nodes` | 2 | node cards |
| `z-node-active` | 3 | selected / dragging node |
| `z-minimap` | 10 | minimap, canvas controls |
| `z-toolbar` | 30 | top CanvasToolbar (sticky) |
| `z-panel` | 40 | docked Inspector / Timeline / Library |
| `z-popover` | 50 | Run popover, ⋯ menus, context menu |
| `z-modal` | 60 | Templates modal, shortcuts help (focus-trapped) |
| `z-live` | 70 | `aria-live` region, inline toast strings |

---

## 3. NODE VISUAL LANGUAGE

**Registry-driven (ADR-003): never `switch(NodeType)`.** All visuals key off `NodeCategory` (or registry flags `handles.outputs`, `highRisk`, `pausesRun`). The table maps each of the 9 builder categories to a *shape + rail + badge* signature.

### 3.1 Category signatures (readable without labels)

| Category | Shape | Fill | Identity rail / badge | Ports | How it differs at a glance |
|---|---|---|---|---|---|
| **AI Employee** *(signature)* | `radius-lg` (16) **person-card**, wider (240px), taller header | `surface-card` + faint violet top-glow `rgba(139,110,242,0.06)` | **40px circular portrait avatar** (initials or photo) + role badge pill ("HR" / "Marketing"); left rail `cat-employee` 3px | 1 top in · 1 bottom out | The ONLY node with a round portrait + a person's name as title. Reads as a colleague, not a box. |
| **Trigger** | **pill / lozenge** (`radius-pill`), 200px, no top-port | `surface-card`, cyan-tinted rail | `zap`/`calendar`/`webhook`/`cursor` tone-badge; caption eyebrow "WHEN…" | 1 bottom out only (no input) | Capsule shape + missing input port = "this is where it starts." |
| **Approval (human gate)** | `radius-node` with a **top notch** (shield silhouette) | `surface-card`, **gold** rail (2px, brighter) | `shield-check` gold tone-badge; persistent caption "Signed off by <role>" | 1 in · 1 out (forward only) | Gold is used *nowhere else* except WAITING — gold = a human decides here. Notch = a gate. |
| **Skill / Tool** | `radius-node`, standard 216px | `surface-card`, teal rail | skill glyph in tone-badge (e.g. `mail` for Gmail); optional 🔴 "Pauses for approval" badge if `highRisk` | 1 in · 1 out | Teal + a recognizable app glyph = "an action leaves the system here." |
| **Knowledge (RETRIEVE)** | `radius-node`, standard | `surface-card`, indigo rail | `search` tone-badge; mono subtitle shows the query | 1 in · 1 out | Indigo + magnifier = "looks something up." |
| **Memory (READ / WRITE)** | `radius-node`, standard | `surface-card`, soft-violet rail | `brain` (Recall) / `bookmark-plus` (Remember) | 1 in · 1 out | Paired brain glyphs; WRITE badge "saves" = side-effect. |
| **Logic — Condition** | **45°-rotated diamond** (shipped `rotate-45 rounded-xl`) | `surface-card`, slate rail | `git-branch`; content counter-rotated upright | 1 in (top) · **2 out**: `True` / `False` bottom | Diamond is the universal "decision." Only branch node with a diamond. |
| **Logic — Switch** | diamond variant, slightly wider | slate | `split` | 1 in · **N out** (one per case + `default`), labels from `handles.outputs` | Multiple labelled outs fan out. |
| **Logic — Split/Merge/Loop/Stop** | compact `radius-node`, small (168px) | slate | `split`/`git-merge`/`repeat`/`octagon-x` | Split: 1→N · Merge: N→1 · Loop: body+done out · Stop: **no out** | Small + slate + no portrait = pure control. Stop has no output handle at all. |
| **Data (Set value / Transform)** | **compact chip** (`radius-btn`, 44px tall) | `surface-card`, muted-slate rail | `variable`/`filter`; mono value inline | 1 in · 1 out | Smallest, quietest, mono — reads as plumbing you skim past. |
| **Timing / Utility (Wait)** | compact chip | dim slate | `clock` + duration | 1 in · 1 out | Dim; a labelled pause. (NOOP + NOTIFY are **not surfaced** in the palette.) |

### 3.2 Node anatomy (shared skeleton)

```
┌───────────────────────────────────────────────┐  ← border-node, radius-node, elev-node
│ ▍ [tone-badge 32]  Title (node-title)      ⋯  │  ← 3px left rail (cat color) · always-visible ⋯ menu
│ ▍                  Subtitle (subtitle, muted) │  ← one-line summary (instruction / query / op)
│ ▍  [badges: 🔴 Pauses · Test run · v2]         │  ← contextual badge row (only if present)
└───────────────────────────────────────────────┘
        ▲ input handle (top-center)  ▼ output handle(s) (bottom-center; labelled if branching)
```

- **Header:** tone-badge (32px `radius-tone`, category-tinted 20% bg) OR 40px portrait for employees · title · status dot (top-right when a run is loaded) · **always-visible `⋯` menu** (not hover-only — a11y requirement; opens the same actions as right-click).
- **Subtitle:** the human summary — employee instruction, tool "Send email (Gmail)", condition `left op right`, wait duration. Truncates with ellipsis; full text in Inspector.
- **Badges:** `🔴 Pauses for approval` (highRisk tool), `Test run` (dry-run), version pill, `⚠` invalid marker.
- **Ports/handles:** 10px dots, `edge-idle` ring at rest, `violet` fill when connectable/hovered, 14px hit-target padding. Branch outputs carry a `mono-xs` label pill beneath the handle.

### 3.3 Shared node states (every node renders these)

| State | Border | Fill / rail | Shadow | Extra signal (never color-only) |
|---|---|---|---|---|
| **idle** | `border-node` | `surface-card` | `elev-node` | — |
| **hovered** | `border-hover` | `surface-card-hover` | `elev-node-hover` | ⋯ menu emphasises; cursor `grab` |
| **selected** | `2px violet` | `violet-wash` overlay | `elev-selected` | Inspector opens; ring is static (no anim) |
| **invalid** | `1.5px edge-invalid` dashed | rail unchanged | `elev-node` | `⚠` badge + red underline on offending field; issue in Outline |
| **running** | `1.5px violet-secondary` | subtle top-glow | `elev-running` (`anim-breathe`) | spinner icon in status dot + `anim-pulseDot`; incoming edge `anim-flow` |
| **waiting-approval** | `1.5px gold` | gold top-glow | `elev-waiting` | `shield` status icon (not spinner) + caption "Waiting on <approver>"; steady, not animated |
| **succeeded** | `border-node` | rail unchanged | `elev-node` | green `check` status dot + green left-tick |
| **failed** | `1.5px edge-invalid` | faint red top-wash | `elev-node` | red `x` status dot + error preview in subtitle |
| **disabled** | `border-hairline` | 45% opacity | none | no handles active; `not-allowed` cursor; excluded from tab order |
| **dry-run** | `border-node` dashed | rail unchanged | `elev-node` | `Test run` badge; tool nodes add "preview / not sent" |

---

## 4. STATUS COLORS

Colorblind-safe rule: **status is always shape/icon + color, never color alone.** Each status owns a distinct lucide glyph and a distinct motion signature, so the mapping survives greyscale.

| Run status | Step status | Color token | Hex | Icon (lucide) | Motion | On a node | On an edge |
|---|---|---|---|---|---|---|---|
| PENDING | PENDING | `status-pending` | `#6B7280` | `circle-dashed` | none | dim node, dashed status dot | edge-idle |
| RUNNING | RUNNING | `status-running` | `#8B6EF2` | `loader` (spin) | `breathe` + `pulseDot` | violet halo, spinner dot | **incoming** edge `anim-flow` (violet) |
| WAITING | WAITING | `status-waiting` | `#F0B90D` | `shield-alert` | none (steady) | gold ring, shield dot | upstream edge solid gold |
| COMPLETED | COMPLETED | `status-ok` | `#34D399` | `check-circle` | 1× fade-in | green tick dot | edge turns solid green, `flow` stops |
| FAILED | FAILED | `status-fail` | `#F87171` | `x-circle` | 1× shake (120ms) | red top-wash, x dot | edge solid red |
| CANCELLED | (SKIPPED) | `status-cancel` | `#64748B` | `slash` / `minus-circle` | none | 55% opacity, slash dot | edge dimmed dashed |
| — | RETRYING | `status-retry` | `#FB923C` | `rotate-cw` | slow spin | amber-orange ring, retry dot + "attempt 2 of 3" chip | edge amber pulse |
| ESCALATED | — | `status-escalated` | `#FFA94D` | `arrow-up-circle` | none | on APPROVAL node: up-arrow chip + "escalated → <next>" | n/a (approval side-panel) |
| EXPIRED | — | `status-expired` | `#9CA3AF` | `clock-x` | none | strikethrough approver name, muted | n/a |
| TIMED_OUT | — | `status-timeout` | `#FB7185` | `alarm-clock-off` | none | rose ring + "ran past deadline" | edge rose dashed |
| COMPENSATING | COMPENSATED | `status-compensate` | `#C084FC` | `undo-2` | reverse `flow` | purple ring, undo dot | edge dashes **reverse** direction |
| SKIPPED | SKIPPED | `status-skipped` | `#64748B` | `minus-circle` | none | 55% opacity | edge dimmed |

Notes tying to the execution ground truth: `COMPENSATING`/`TIMED_OUT`/`RETRYING` only appear on state-machine runs (attempt rows) — under the live legacy walk a node throw jumps straight to FAILED, so the viz degrades to the PENDING→RUNNING→COMPLETED/FAILED/WAITING set and never *invents* the richer states. `outcomeUnknown` attempts render distinctly as `status-timeout` color + `help-circle` glyph + copy "outcome unknown — a person should check," never as a plain failure.

---

## 5. EDGE VISUAL LANGUAGE + BEHAVIOUR

### 5.1 Look

- **Curve:** vertical **bezier** (top-down flow, matching the shipped marketing `WorkflowDiagram` mental model), `strokeWidth 1.5` idle → `2` on hover/selected. Never right-angle "circuit board" elbows except where two branches must clear a node (see routing).
- **Color:** `edge-idle` `rgba(255,255,255,0.16)` at rest; `edge-hover` `#7659F0` when hovered or when either endpoint node is selected.
- **Arrowhead:** small 6px filled chevron in the edge's current color, at the target handle. One arrowhead per edge, target end only.
- **Endpoints:** edges connect bottom-out → top-in; the handle dot brightens to `violet` while an edge is attached.

### 5.2 Branch edges (the meaning-carrying ones)

A branch edge carries a **`mono-xs` label pill** centered on the path: `rounded-pill`, `surface-raised` bg, `border-hairline`, 11px JetBrains Mono.

- **CONDITION:** two edges labelled **`True`** (violet-secondary pill) and **`False`** (slate pill) — semantic, not just colored. The engine routes on `branch:'true'|'false'`; the label pill text is authoritative and must match exactly.
- **SWITCH:** one pill per case = the author's branch label (e.g. `enterprise`, `smb`) plus a `default` pill. Labels come from `NodeDefinitionDto.handles.outputs` — never hardcoded.
- **APPROVAL:** rendered as a *single forward edge* (approved→continue). Rejection is NOT an edge (engine fails the run) — so there is deliberately no "rejected" branch drawn; the Inspector states "If rejected, the run stops." Do not draw phantom `approved/rejected/error` ports.

### 5.3 Connection validity (during a drag)

| State | Rendering |
|---|---|
| **pending** (dragging from a handle) | `edge-pending` violet dashed line following cursor; compatible target handles enlarge + glow violet |
| **valid drop** | snaps solid; brief 120ms violet flash on the new edge |
| **invalid** (self-loop, into TRIGGER input, out of TERMINATE, would create a non-LOOP cycle, duplicate) | line turns `edge-invalid` red dashed; target handle shows `x`; drop rejected with inline `aria-live` string "Can't connect — Stop has no next step" (copy varies by rule) |
| **branch-required** | if a CONDITION/SWITCH output is left unlabelled/unconnected, the edge stub shows a dashed `⚠` and surfaces publish issue `MISSING_BRANCH_EDGE` |

### 5.4 Live-run animation

During a run, the **currently-executing** edge (from the last COMPLETED step to the RUNNING step) animates with the shipped `flow` keyframe (`strokeDashoffset -44`, 2.4s linear, `edge-live` violet). Completed edges become solid green briefly then settle to `edge-idle`. A `COMPENSATING` run reverses the dash direction (`undo` semantics). At most one edge animates at a time on a legacy walk (sequential); on PARALLEL fan-out, each active lane's leading edge animates. Reduced-motion (already globally enforced) drops all dashing → edges simply recolor by status, so correctness never depends on animation.

### 5.5 Routing / overlap avoidance

- **Layout:** `dagre` top-down (`rankdir TB`), run **once per load** (perf ceiling: 500 nodes, `onlyRenderVisibleElements`), rank gap 48px, node gap 32px. Manual node `position` from the definition wins after first layout; dagre only seeds new/unpositioned nodes.
- **Branch spread:** a CONDITION/SWITCH's outputs fan to distinct x-offsets so `True`/`False`/case edges never overlap; label pills sit at the path midpoint with 8px collision padding.
- **Long edges** (skip-level, e.g. into a JOIN or LOOP `done`) route with a gentle orthogonal jog around intervening nodes rather than crossing them; crossing edges lower opacity to `0.10` where they pass *behind* a node so the node stays legible.
- **Loop back-edges** (LOOP `body` returning) render as a distinct `cat-logic` slate dashed curve looping to the left of the body, with a `repeat` glyph at the apex — visually separating "go back and iterate" from forward flow.

---

### Handoff notes for Parts 2–3
- All hexes above are additive to `tailwind-preset.cjs`; the `status-*`, `cat-*`, `edge-*`, `elev-*` tokens are the ones to register.
- Reuse shipped keyframes `flow` / `breathe` / `pulseDot` only — do not author new ones.
- The person-card employee node is the single boldness spend; keep Logic/Data/Utility relentlessly quiet so the spend reads.
- Category → visual keys off `NodeCategory` + registry flags, never `switch(NodeType)`; branch labels + output handles come from `NodeDefinitionDto.handles.outputs`.

## Part 2 — Interaction Model + Information Architecture
# Workflow Builder — Design Spine Part 2: Interaction Model + Information Architecture

*Orlixa V-AEP. Dark canvas (`#02030a`), violet accent (`#5E3CE8`). Mental model: **managing employees**, not wiring boxes. Every constraint below is coded against the shipped API, the frozen 19-node registry, and the legacy-walk execution engine — not the aspirational docs.*

---

## 1. Information architecture + navigation

### 1.1 Where the builder lives

Everything stays under the existing `/workflows` route tree and the existing `AppShell`/`Sidebar` (`/workflows` nav row already present). **No new Sidebar entry, no new store slice.**

```
/workflows                      List + entry points (KEEP page.tsx)
  ├─ tri→quad toggle: [ Your workflows | Templates | + New | Generate with AI ]
  │       Templates → TemplateGallery (Modal-based install form)   §15.I.3
  │       Generate  → GenerateWorkflowChat (BUSINESS/ENTERPRISE)   POST /workflows/generate
  ├─ WorkflowList → row click → /workflows/:id
  └─ install/create/generate all resolve to → /workflows/:id  (a DRAFT)

/workflows/:id                  THE BUILDER (REPLACE internal layout only)
  keep: params, AppShell wrapper, accessToken guard, useWorkflow(id)
  cancel AppShell padding locally: -mx-6 sm:-mx-10 -mb-12 h-[calc(100vh-80px)]
  regions: Toolbar (top) · Canvas (center) · Inspector (right dock) ·
           NodeLibrary (left drawer, invoked) · ExecutionTimeline (bottom dock)

/workflows/:id?run=:runId       Same builder, Timeline dock forced open, canvas in
                                READ-ONLY "watch" mode pinned to the run's version graph
/workflows/:id?unresolved=1     GenerateWorkflowChat/Template hand-off → ValidationIssue[] banner
```

**Three modes of the one builder route**, switched by local state (never store):

| Mode | Trigger | Canvas | Docks |
|---|---|---|---|
| **Edit** | default, DRAFT workflow | interactive, `useNodesState`/`useEdgesState` | Inspector on select; Timeline collapsed |
| **Watch** | `?run=` present, or user clicks a run | `readOnly` — pinned to `WorkflowVersion.definition` (fallback `Workflow.definition` when `workflowVersionId` null), live status overlay | Timeline expanded, live |
| **Locked** | workflow `status==='ARCHIVED'`, or a concurrent 409 unresolved | `readOnly`, dimmed, top banner | Inspector read-only |

### 1.2 The three-level shell (list → builder → run)

```
LIST (/workflows)  ──open──▶  BUILDER (/workflows/:id, Edit)  ──Run/watch──▶  WATCH (?run=)
    ▲                              │  Publish                        │
    └──────────────────────────────┴─────────────────────────────────┘
         breadcrumb: Workflows ›  {workflow.name}  ›  Run {short id}
```

Breadcrumb renders in the Toolbar left cluster; each hop is a real back-nav (browser history intact — modes are query-param driven so back button works).

### 1.3 Builder layout regions — desktop wireframe (≥1280px)

```
┌────────────────────────────────────────────────────────────────────────────────────────────┐
│ TOPBAR (AppShell, shared — do NOT edit)     Orlixa �dark▾   company   ⏣ approvals   avatar ▾ │
├────────────────────────────────────────────────────────────────────────────────────────────┤
│ CANVAS TOOLBAR  (h-14, bg #0b0d18, border-b white/[0.07])                                    │
│ ‹ Workflows / Recruitment intake ·  DRAFT●    │  ⌘K Add step   ⌗ Tidy   ⤺ ⤻   │  ▷ Test  ⇧ Publish  ⋯ │
├──────────┬─────────────────────────────────────────────────────────────┬─────────────────────┤
│          │                                                             │                     │
│  NODE    │                     CANVAS  (React Flow)                    │   INSPECTOR         │
│ LIBRARY  │                  role="application"                         │   (right dock)      │
│ (drawer, │   ┌──────────┐        ┌──────────┐       ┌──────────┐        │  ┌───────────────┐  │
│  invoked │   │ ▷ When a │        │  Emma    │       │ ◆ CV      │       │  │ Emma (HR)     │  │
│  by ⌘K   │   │ candidate│──main─▶│  (HR)    │──────▶│ attached? │─true─▶ │  │ ● AI Employee │  │
│  or ‹ )  │   │  emails  │        │ reviews… │       └────┬─────┘        │  │───────────────│  │
│          │   └──────────┘        └──────────┘         false            │  │ Which employee│  │
│  Grouped:│                                              │              │  │ [Emma ▾]      │  │
│  When…   │                                    ┌─────────▼────────┐     │  │ What should   │  │
│  AI Empl.│                                    │ ⛊ Recruiter      │     │  │ Emma do?      │  │
│  Skills  │                                    │   reviews  🔴    │     │  │ [textarea…]   │  │
│  Know/Mem│                                    └──────────────────┘     │  │ Names result: │  │
│  Logic   │                                                             │  │ {{screening}} │  │
│  Data    │                                                             │  │───────────────│  │
│  Human   │                                                             │  │ Saved.        │  │
│  Timing  │           [minimap ◱]              [− 100% + ⤢ fit]         │  └───────────────┘  │
├──────────┴─────────────────────────────────────────────────────────────┴─────────────────────┤
│ EXECUTION TIMELINE / RUN BAR  (bottom dock, collapsed = h-11 · expanded = h-72)              │
│ ▸ Run bar collapsed:   ● No active run   ·   Last run: COMPLETED 2m ago   ·   [History ▾]     │
│ ▸ Expanded (watch):  ◐ RUNNING · live●  seq 41   │ Timeline │ History │ Context │            │
│    ▸ When a candidate emails   ✓ 0.4s                                                         │
│    ▸ Emma (HR) reviews          ◐ running…  ⟳ pulse                                           │
│    ▸ Recruiter reviews          ⏸ waiting on a person → resumes at "Notify"                   │
└──────────────────────────────────────────────────────────────────────────────────────────────┘
```

Region ownership of state (hard rule, §15.0.6-6):

| Region | Component | State home | Data source (exact) |
|---|---|---|---|
| Toolbar | `CanvasToolbar` | props from builder page | `useWorkflow(id)`, `useUpdateWorkflow`, `usePublishWorkflow`, `useRunWorkflow`, `useActivate/Deactivate` |
| Canvas | `WorkflowCanvas` | React Flow `useNodesState`/`useEdgesState` + local `selection`, `readOnly`, undo stack | derived from `workflow.definition` → `{nodes,edges}` |
| Node Library | `NodeLibrary` | local drawer-open | `useNodeDefinitions()` → `GET /workflows/node-types` `{types}` + `labels.ts` |
| Inspector | `Inspector` (generic `SchemaForm`) + `TriggerInspector` (hand-built) | local `selectedNodeId`; RHF form state | node config for selection; `GET /workflow-secrets?workflowId=`, `GET /employees`, `GET /skills`, `GET /workflow-variables` |
| Timeline | `ExecutionTimeline` | local `runId`, `RealtimeStatus` | `useRunTimeline(runId)` = poll `GET /workflows/runs/:runId`; `useWorkflowRuns(id)` for History |

### 1.4 How regions collapse (desktop → tablet → mobile)

| Breakpoint | Canvas | Node Library | Inspector | Timeline | Toolbar |
|---|---|---|---|---|---|
| **Desktop ≥1280** | full | left drawer, invoked (⌘K / ‹) | right dock 360px, opens on select | bottom dock, collapsible | full, inline |
| **Tablet 768–1279** | full | overlay drawer (scrim) | overlay sheet from right (scrim), 88% width | bottom sheet, invoked | condensed: primary actions inline, rest into ⋯ |
| **Mobile <768** | **read-only monitor** | hidden | full-screen sheet, read-only | full-screen list (the primary view on mobile) | Run/Watch/Approve only; "Editing is desktop-only" inline notice |

Mobile is **view + monitor + approve**, never edit (canvas graph authoring is pointer-and-keyboard-heavy; forcing it onto a phone would violate the quality floor rather than serve it). The approvals inbox and the run Timeline are fully mobile-usable so a manager can approve on a phone.

---

## 2. Canvas interaction model

React Flow (`@xyflow/react`), `onlyRenderVisibleElements`, memoized `WorkflowNodeCard`, dagre run **once per load** (top-to-bottom `rankdir:'TB'`). Nodes are absolutely positioned from `node.position` (persisted in the definition payload — the *only* new field in Save, §f.4).

### 2.1 Pan

| Gesture | Behaviour |
|---|---|
| **Space + drag** | pan (cursor → `grabbing`); the primary explicit pan |
| **Middle-mouse drag** | pan |
| **Two-finger trackpad** | pan (React Flow `panOnScroll`) |
| **Mouse wheel** | zoom (see 2.2); with `panOnScrollMode` off so wheel is zoom by default on mouse |
| **Drag on empty canvas** | marquee-select (NOT pan) — pan needs Space or middle-mouse so selection stays the default empty-drag |
| Keyboard | Arrow keys pan the viewport when canvas has focus and **no node selected** (with node selected, arrows nudge — 2.5) |

### 2.2 Zoom

- Wheel / pinch: zoom to cursor. **min 0.25, max 2.0**, `zoomStep` 0.15.
- Named levels the zoom control snaps through: **25% · 50% · 100% · 150% · 200%**.
- Zoom-to-fit (`⤢`, key `⇧1`): fits all nodes, 0.15 padding, clamps to max 1.0 so a 1-node graph doesn't balloon.
- Zoom controls bottom-right: `[ − | 100% | + | ⤢ ]`. The `100%` label is a button → resets to 1.0 centered on selection (or graph centroid).
- `⌘0` / `Ctrl0` = reset to 100%. `⌘=`/`⌘-` zoom in/out (also `+`/`-` bare).

### 2.3 Select

| Action | Keys/pointer |
|---|---|
| Select one | click node |
| Add / toggle | Shift-click (or ⌘/Ctrl-click) |
| Marquee | drag on empty canvas → additive with Shift |
| Select all | ⌘A / Ctrl A |
| Deselect all | Esc, or click empty canvas |
| Tab through nodes | Tab / Shift-Tab walks nodes in **topological then id order** (deterministic, edges `aria-hidden`) |

Selected node: violet 2px ring (`ring-2 ring-violet`) + raised `shadow-dark-card`. Multi-select shows a count chip in the Toolbar (`3 selected`).

### 2.4 Move

- Drag a node (or a multi-selection) to reposition. **8px grid snap** on by default (toggle in ⋯ menu); alignment guides (1px violet-secondary dashed) appear when a node's center/edge aligns with a neighbour within 4px.
- Keyboard: with node(s) selected, **Arrow = nudge 8px**, **Shift+Arrow = nudge 1px** (fine), **⌘/Ctrl+Arrow = nudge 40px** (coarse). This is the required non-drag equivalent for *move*.
- Moves push a single undo entry per drag-end (not per frame).
- Every move marks the canvas dirty → autosave-debounced draft write (2.9).

### 2.5 Connect (registry-driven, no `switch(NodeType)`)

Handles come from `NodeDefinitionDto.handles.outputs` — never hardcoded per type. Concretely:

| Node category | Output handles rendered | Branch string written to edge |
|---|---|---|
| Most nodes | one `main` bottom handle | `branch` omitted |
| `CONDITION` | two handles: **Yes** / **No** | `branch:'true'` / `'false'` |
| `SWITCH` | one handle **per author-named case** + `default` | `branch:'<case label>'` / `'<default label>'` |
| `TERMINATE` | **none** (validator: `TERMINATE_HAS_OUTGOING_EDGE`) | — |
| `PARALLEL` | `main` (lanes/join are config refs `lanes[]`/`joinNodeId`, **not** edges) | — |

**No `error` port is ever rendered** — the engine has no error channel (`nextNode()` routes only on `branch`). APPROVAL reject *fails the run*; it is not an edge.

Drag-connect: pull from a source output handle → valid targets (any input handle except self, except creating a non-LOOP cycle) glow violet; invalid targets dim. Drop on empty canvas → opens Node Library filtered to "what can follow this" and auto-connects on pick (**auto-connect**). Connection validation feedback:

- Valid → violet edge draws with the `flow`-adjacent quick stroke animation (2.7).
- Would create a disallowed cycle (`CYCLE_DETECTED`, DFS ignoring edges *into* a LOOP) → edge snaps back, red inline shake on the target, `aria-live`: *"That would loop back on itself. Only a Loop step can point backwards."*
- Duplicate branch edge (two edges same `branch` from one CONDITION handle) → snaps back: *"Yes already goes somewhere. Re-point the existing one instead."*

**Keyboard connect** (required non-drag equivalent): select source node → `C` (connect) enters *connect mode* → the per-node "⋯" menu's **"Connect to…"** opens a target picker list (topo-ordered, searchable) → Enter wires it. For a branching node the picker first asks which branch (Yes/No or case).

### 2.6 Delete / duplicate / copy-paste

- **Delete** (Del/Backspace, or ⋯ → Remove): if the node has downstream branches, reuse the salvaged `NodeList` `window.confirm` verbatim — *"Removing this also drops the steps that only follow it. Remove anyway?"* Edges into/out of it are pruned. Undoable.
- **Duplicate** (⌘D/Ctrl D): clones selection 24px offset; **new node ids minted** matching `^[A-Za-z0-9_-]{1,64}$` (`<type>_<base36 rand>`), config deep-copied, incoming edges *not* copied, internal edges within the selection *are*.
- **Copy / Cut / Paste** (⌘C/X/V): JSON of `{nodes,edges}` to an internal clipboard (not OS clipboard — avoids leaking config). Paste re-mints ids, offsets, selects the pasted set.

### 2.7 Undo / redo

Client-only bounded stack, **`useUndoRedo` 50-entry `{nodes,edges}` snapshot ring** (per the ground brief). Not in the store — lives in `WorkflowCanvas`. ⌘Z / ⌘⇧Z (Ctrl Z / Ctrl Y also). One entry per *committed* gesture (drag-end, connect, delete, config-field blur). Undo past the last-saved point re-marks dirty. Undo stack **clears on load and on a 409 "reload their version"** (you can't undo into someone else's graph).

### 2.8 Auto-layout / tidy

`⌗ Tidy` (key `⇧T`) runs dagre `TB`, 64px rank-sep, 32px node-sep, animates nodes to new positions over 240ms `ease-out` (framer-motion; reduced-motion → instant). One undo entry. Tidy respects branch order (Yes left, No right for CONDITION; cases left→right by definition order).

### 2.9 Autosave / draft model

Every committed edit debounces (800ms) a **draft write**: `PUT /workflows/:id/draft { definition }` (creates DRAFT on first call, overwrites after). The Toolbar status pill shows `Saving… → Saved · just now`. This is separate from **Publish** (§Toolbar). Structural-invalid draft → 400 → inline, non-blocking (draft still a scratchpad); publish is the hard gate.

> **Concurrency:** the older direct `PATCH /workflows/:id { definition, expectedUpdatedAt, position }` path is still used by explicit "Save" and by position-only writes. On **409** (expectedUpdatedAt mismatch): inline error + **"Reload their version"** action that refetches, replaces canvas + clears undo. Never silently overwrite either direction.

### 2.10 Minimap

Bottom-left, 160×110, `bg-void-section/80 backdrop-blur`, nodes as violet dots, viewport rect draggable. **Explicitly not SR-accessible** (decorative) — `aria-hidden`, `tabindex=-1`; the Outline view (6.2) is the connectivity fallback. Toggle in ⋯.

### 2.11 Large-graph ceilings (honour Phase 12/14)

- **500-node** graph ceiling + **1 MB** definition cap: `onlyRenderVisibleElements`, memoized cards, dagre once. Approaching cap → Toolbar warns *"This workflow is getting large (480/500 steps)."* Publish beyond → `GRAPH_TOO_LARGE`.
- `LOOP` bodies are single nodes on canvas; a 10,000-iteration loop is one node — iteration detail lives in the Timeline, which is **windowed** (2.b below), never 10k rows.

---

## 3. Keyboard shortcuts

Platform: **⌘ on macOS, Ctrl on Windows/Linux** (detect via `navigator.platform`; render the right glyph in the shortcuts-help Modal, opened by `?`). All canvas shortcuts require canvas focus (`role="application"` wrapper); form fields swallow their own keys.

### 3.1 Global builder

| Action | macOS | Win/Linux | Notes |
|---|---|---|---|
| Command palette / Add step | ⌘K | Ctrl K | opens Node Library in search mode |
| Save (explicit) | ⌘S | Ctrl S | forces draft write now; prevents browser save |
| Publish | ⌘⇧P | Ctrl ⇧P | runs publish → 400 surfaces validation |
| Test run (dry-run) | ⌘⏎ | Ctrl ⏎ | opens Run popover pre-set `dryRun:true` |
| Run (live) | ⌘⇧⏎ | Ctrl ⇧⏎ | Run popover, `dryRun:false` |
| Toggle Node Library | ⌘/ | Ctrl / | |
| Toggle Timeline dock | ⌘J | Ctrl J | |
| Open Inspector for selection | ⏎ (node focused) | Enter | |
| Shortcuts help | ? | ? | Modal (focus-trapped) |
| Escape / cancel | Esc | Esc | close popover/menu/inspector → deselect → exit connect mode (in that priority) |

### 3.2 Canvas editing

| Action | macOS | Win/Linux |
|---|---|---|
| Undo / Redo | ⌘Z / ⌘⇧Z | Ctrl Z / Ctrl Y |
| Select all | ⌘A | Ctrl A |
| Duplicate | ⌘D | Ctrl D |
| Copy / Cut / Paste | ⌘C / ⌘X / ⌘V | Ctrl C/X/V |
| Delete node(s) | Delete or Backspace | Delete / Backspace |
| Nudge 8px / 1px / 40px | Arrows / ⇧Arrows / ⌘Arrows | Arrows / ⇧Arrows / Ctrl Arrows |
| Connect from selected | C | C |
| Tidy / auto-layout | ⇧T | ⇧T |
| Rename node inline | F2 | F2 |

### 3.3 Navigation / zoom

| Action | macOS | Win/Linux |
|---|---|---|
| Next / prev node | Tab / ⇧Tab | Tab / ⇧Tab |
| Zoom in / out | ⌘= / ⌘- (or +/-) | Ctrl= / Ctrl- |
| Reset zoom 100% | ⌘0 | Ctrl 0 |
| Zoom to fit | ⇧1 | ⇧1 |
| Pan viewport (no selection) | Arrows | Arrows |
| Open node ⋯ menu | ⇧F10 or ContextMenu key | ⇧F10 / Menu |

**Conflict notes:** ⌘S/⌘D/⌘K/⌘Z are `preventDefault`ed only when canvas or builder chrome has focus, never inside an Inspector text field (so browser find/save still work while typing config). ⌘⏎ vs Enter-opens-inspector disambiguated by focus target (node vs canvas). Backspace-deletes-node is suppressed whenever a form control is focused.

---

## 4. Context menus

All openable by right-click **and** keyboard (⇧F10 / Menu key on the focused target). Rendered as a `role="menu"` popover, arrow-key navigable, Esc closes, focus returns to origin. Items disable (not hide) with a reason tooltip.

### 4.1 Empty canvas

| Item | Enabled when | Action |
|---|---|---|
| Add step here… | always (Edit mode) | opens Node Library at pointer, auto-positions there |
| Paste | clipboard non-empty | paste at pointer |
| Select all | ≥1 node | |
| Tidy layout | ≥2 nodes | dagre |
| Zoom to fit | ≥1 node | |
| Toggle grid snap / minimap | always | |

### 4.2 A node

| Item | Enabled when | Action |
|---|---|---|
| Open (edit config) | always | focus Inspector |
| Rename | always | inline F2 |
| Connect to… | node has an available output handle & ≥1 valid target | keyboard-connect picker |
| Duplicate | not TRIGGER (single-trigger rule) | ⌘D |
| Copy / Cut | always | |
| **Test from here** | Edit mode, node reachable | dry-run starting context at node *(best-effort; documented as preview)* |
| Turn into… | type has display-alias siblings (e.g. TRANSFORM↔Filter) | swaps card framing, keeps config |
| Remove | not the sole TRIGGER when it's the only node | branch-loss confirm |

TRIGGER node: Duplicate + Remove disabled (tooltip: *"A workflow has exactly one start."*). Marketing Employee card stays hidden until G10 — never offer "turn into Marketing employee".

### 4.3 An edge

| Item | Enabled when | Action |
|---|---|---|
| Insert step on this path… | always | splits edge, drops picked node between, rewires |
| Re-point source / target | always | enters re-point mode |
| Change branch (Yes/No/case) | edge originates from CONDITION/SWITCH | pick a different unused branch |
| Remove connection | always | delete edge only |

### 4.4 A multi-selection

| Item | Enabled when |
|---|---|
| Duplicate selection | no TRIGGER in set |
| Copy / Cut | always |
| Align (left/center/right/distribute) | ≥2 nodes |
| Tidy selection | ≥2 |
| Remove selection | always (branch-loss confirm aggregated) |

### 4.5 A port/handle

| Item | Enabled when | Action |
|---|---|---|
| Connect to… | handle unused or multi-out allowed | keyboard-connect picker for *this* branch |
| Rename branch | SWITCH case handle | edits `cases[].branch` label |
| Clear this connection | handle has an edge | remove that edge |

---

## 5. Animation system

Reuse the **already-present, reduced-motion-safe** keyframes only — do not invent (§15.C.12). `prefers-reduced-motion:reduce` already blankets `*{animation:none;transition:none}` globally, so each moment's fallback is "instant, no motion" for free; where a *state* still needs to read without motion, a static style stands in (noted per row).

| Moment | Motion | Duration / easing | Token / source | Reduced-motion fallback |
|---|---|---|---|---|
| **Node add** | scale 0.96→1 + fade in | 160ms `ease-out` | framer-motion `initial/animate` | appears instantly at final position |
| **Connect (edge draw)** | stroke draws source→target | 220ms `ease-out` | dash-offset one-shot | edge present instantly |
| **Selection** | ring fade + 1px lift | 120ms | CSS transition | static violet ring |
| **Live-run active node** | breathing pulse | `breathe` 3.6s loop | `breathe` keyframe | static violet border + `◐` glyph |
| **Live edge (data flowing)** | marching dash | `flow` 2.4s linear ∞ | `flow` keyframe | static violet solid edge |
| **Run "alive" dot** | green ping | `pulseDot` 2.4s | `pulseDot` keyframe | static green dot |
| **Approval-pause (WAITING)** | slow amber breath on the approval node + a soft "⏸ waiting on a person" chip slide-in | `breathe` retinted amber, chip 200ms slide | `breathe` | static amber node + persistent chip (no slide) |
| **Error / invalid connect** | 3px horizontal shake ×2 | 180ms | small `translateX` keyframe (add once, guarded by reduced-motion) | red border + inline text only (no shake) |
| **Panel open (Inspector/Library/Timeline)** | slide + fade from dock edge | 200ms `ease-out` | framer-motion | appears instantly |
| **Run complete** | one-shot green sweep along the completed path + node checks settle | 400ms | `flow` retinted green, single iteration | nodes flip to ✓ instantly + `Completed` inline |
| **Tidy** | nodes tween to dagre positions | 240ms `ease-out` | framer-motion layout | jump to positions |

Discipline: **at most one looping animation class per run state** on screen (the active node's `breathe` + its outgoing `flow` edge + the run dot). Everything else is one-shot. No decorative idle motion in Edit mode.

---

## 6. Global a11y + responsive strategy + shared state patterns

### 6.1 Keyboard-only + screen-reader story (load-bearing, §15.0.6-5)

- Canvas wrapper `role="application"` `aria-label="Workflow canvas. Use Tab to move between steps, Enter to edit, C to connect."`
- Each node `role="group"` `aria-roledescription="workflow step"` `aria-label` = **human label + state**, e.g. *"Emma, HR employee, reviews the application. Running."* / *"Recruiter reviews. Waiting on a person, resumes at Notify."* Labels are the employee/approval names — **never** node ids or `AI_EMPLOYEE_STEP`.
- Every drag gesture has the non-drag equivalent defined in §2 (move=nudge keys, connect=`C`/menu, delete=Del, marquee=Select-all+Tab). **Always-visible per-node "⋯" button** (not hover-only) is the touch/SR affordance for every node action.
- Edges are `aria-hidden` decorative SVG paths; **connectivity is exposed only through the Outline view** (6.2).
- Minimap `aria-hidden`.

### 6.2 The Outline view — the SR/keyboard connectivity fallback (§15.C.11)

A togglable tree (Toolbar `☰ Outline`, or replaces the canvas region on mobile) rendered as a real `role="tree"`:

```
When a candidate emails
└─ Emma (HR) reviews the application
   └─ CV attached?
      ├─ Yes → Store CV (Google Drive)
      └─ No  → Recruiter reviews  ⏸
               └─ Notify recruiter (Gmail)
```

Arrow keys walk it; Enter opens that node's Inspector; it stays in sync with canvas selection. This is the authoritative "what connects to what" for anyone not using pointer + sighted canvas.

### 6.3 Live-region announcements (run progress)

One `aria-live="polite"` region (reuses the same inline strings shown visually — no separate SR copy). Announces on step transition, throttled to ≥1s and coalesced so a busy run doesn't spam:
- *"Emma is reviewing the application."* (RUNNING)
- *"Waiting on Recruiter to approve before it sends."* (WAITING)
- *"Recruiter approved. Continuing."* (resumed)
- *"Run finished. All steps complete."* / *"Run stopped: {failureClass in plain words}."*

`aria-live="assertive"` reserved only for a failed save/publish and the WAITING approach on an approval the current user can decide.

### 6.4 Realtime → polling degradation (build polling first)

`RealtimeStatus = 'connecting'|'live'|'reconnecting'|'polling-fallback'`, shown as a pill in the Timeline header. Correctness never depends on WS:
- **Baseline (ships first):** `useRunTimeline` = `useWorkflowRun` polling `GET /workflows/runs/:runId` at `refetchInterval: isActive ? 1000 : false` (`isActive` = `PENDING|RUNNING|WAITING`).
- **Additive WS** (when the gateway exists): channel `run:{runId}`, subscribe-on-mount/leave-on-unmount. Envelope `RunEventEnvelope {type,runId,companyId,emittedAt,seq,data}` — field is **`seq`** (global BigInt, monotonic across all runs; filter by `runId`, use `seq` only to order/dedupe/detect gaps). A **`seq` gap → full `GET /workflows/runs/:runId` refetch** (self-heal; no client event-sourcing reducer). WS drop → pill flips to `reconnecting` then `polling-fallback` → hands straight back to the 1s poll. At-least-once delivery ⇒ tolerate duplicates.

### 6.5 Responsive strategy (recap, desktop-first)

| Target | Gets |
|---|---|
| **Desktop** | full authoring builder |
| **Tablet** | full authoring, docks become scrimmed overlays; primary actions inline, rest in ⋯ |
| **Mobile** | **monitor + approve only**: Timeline as primary screen, Outline as the graph view, Inspector read-only, approvals inbox fully usable; a quiet inline note *"Editing workflows needs a larger screen."* — not an error |

### 6.6 Shared loading / error / empty / disabled patterns (every component reuses these)

There is **no toast primitive** and none is added. Success/error is **inline text** (`Saved.` green `text-emerald-400` / red `text-red-400`), and the `aria-live` region reuses those exact strings. A **focus-trapped `Modal`** (`role="dialog" aria-modal="true"`, Esc-closes) is added — first consumers: Templates install form + shortcuts-help. Destructive confirms stay `window.confirm`.

**Loading (skeleton, never spinner-only):**
- List → row skeletons (existing pattern).
- Canvas → dim node skeleton cards at dagre-estimated positions + "Loading your workflow…" center; blocks interaction (`aria-busy`).
- Inspector → 3 field-shaped shimmer blocks.
- Timeline → 4 step-row skeletons; the poll's own `isActive` drives the live refresh.
- Node Library → shows cached `['workflow-nodes']` (staleTime 5min) instantly; virtualizes past threshold.

**Error envelope mapping** — consume `NormalizedApiError {status,message,raw}` (bare Nest `{statusCode,message,error}`; `message` may be `string[]` joined). Errors never apologise, never vague:

| Status | Context | User-side copy | UI |
|---|---|---|---|
| **400** | draft save / publish invalid | surface each `ValidationIssue` per node with the exact code mapped to plain words (`SINGLE_TRIGGER_REQUIRED` → *"A workflow can only have one start."*; `UNBOUNDED_LOOP` → *"This loop needs a limit — set how many times it can repeat."*; `INLINE_SECRET_FORBIDDEN` → *"Don't paste a secret here — pick it from your saved connections."*; `UNJOINED_PARALLEL` → *"This Split has to meet back at a Merge."*; `TERMINATE_HAS_OUTGOING_EDGE` → *"Stop is the end — it can't lead anywhere."*) | per-node red ring + issue list in a Publish/validate panel; nodes clickable to focus |
| **403** | RUN-restricted / not eligible approver / plan-gated Generate | *"You're not set up to run this workflow."* / *"You're not the approver for this."* / *"Generating with AI is on Business and Enterprise plans."* | inline, action disabled with reason |
| **404** | archived / cross-tenant / purged | *"This workflow isn't here anymore."* | Locked mode banner |
| **409** | save `expectedUpdatedAt` mismatch | *"Someone else saved changes. Reload their version to keep going."* + **Reload** action (refetch, replace, clear undo) | inline, blocks silent overwrite |
| **409** | delete with in-flight run | *"This is still running — you can archive it once the run finishes."* | inline on Delete |
| **409** | already-decided approval | *"Already {approved/rejected}."* | inline in inbox |
| **410** | purged run opened | retention copy: *"This run's details were cleared after the retention window."* — **not** a generic error | Timeline empty state |
| **422** | template install prereq/binds | the exact plain-language miss: *"Hire a Marketing employee to use this workflow."* / *"Install Gmail first."* / *"Upgrade to Business to install this."* | per-field in the install Modal |
| **429** | throttle / Generate over-quota | *"Give it a moment — too many requests just now."* | inline, retry-after countdown |

**Empty states are invitations (never dead ends):**
- No workflows → *"No workflows yet. Start from a template, or describe what you want and let AI draft it."* + the two CTAs.
- New DRAFT (lone TRIGGER) → canvas centers the trigger with a ghost "+ Add the first step" affordance beneath its `main` handle.
- No runs → *"No runs yet. Hit Test to try it safely, or Run to go live."*
- Approvals inbox empty → *"Nothing's waiting on you."*

**Disabled patterns (always with a reason, never bare):**
- **Publish** disabled while draft unchanged since last publish (*"Nothing new to publish"*) or while a validation panel has blockers.
- **Activate** disabled until ≥1 non-TRIGGER node exists (matches shipped precondition — *not* "has a published version") — tooltip *"Add at least one step first."*
- **Run** disabled in Watch/Locked mode; **Test** always available in Edit.
- **highRisk TOOL_ACTION**: the *inspector approval toggle is absent by design* — instead a **persistent, non-removable "Pauses for approval 🔴" badge** on the node (query `SkillCatalog.getTool(skillKey,tool)?.highRisk`), inspector note *"This step pauses and asks for approval before it publishes — even without an approval step in front of it. That's built in and can't be turned off."* `mkt.social-schedule` / `mkt.social-publish` rely on this as their only in-the-loop signal — never render them as unguarded.
- **Secret field**: a picker over `GET /workflow-secrets?workflowId=` (keys + metadata only) that writes the literal `{{secrets.KEY}}` — the value is **never** fetched or rendered (§15.0.6-2). Disabled with *"No connections saved yet"* when empty.

**The signature-moment discipline that ties it together:** the APPROVAL node always sits visually **between** the AI Employee's draft and the outward TOOL_ACTION, and that adjacency is drawn deliberately (a subtle violet "sign-off" seam). An action keeps its name the whole way through — the node "Approve outreach" → the inbox item "Approve outreach" → the live-region + inline string "Outreach approved." That through-line, not box-wiring, is what makes this read as an AI Employee OS rather than an n8n clone.

---

*Key files this spec reshapes (absolute): `D:/Vertical AI/platform/apps/web/src/app/(app)/workflows/[id]/page.tsx` (replace internal layout), `.../workflows/page.tsx` (add Templates toggle), `.../features/workflows/{hooks.ts,api.ts,labels.ts}` (extend), new `.../features/workflows/components/{WorkflowCanvas,CanvasToolbar,Inspector,NodeLibrary,ExecutionTimeline,Outline,ContextMenu,shortcuts}/`, new `.../components/ui/Modal.tsx`. Do not edit `AppShell.tsx`, the single apiClient/queryClient/session store, or the shipped API contracts.*


---

# 3. COMPONENTS



---

## 3.A — Entry surfaces (Workflow list · Create workflow · Template selection)

# Entry Surfaces — Component Specs (Cluster 1)

Three components: `WorkflowListPage` (route `/workflows`), `CreateWorkflowMenu` + `NewWorkflowNameForm` (create flow), `TemplateGallery` + `TemplateInstallForm` (template selection). All inherit the DESIGN SPINE tokens, status colors, loading/error/empty patterns, and the `Modal` primitive. No React code — spec only.

Shared grounding used throughout:
- Error envelope = `NormalizedApiError { status, message, raw }` (bare Nest `{statusCode, message, error}`; `message` may be a joined `string[]`).
- Query-key factory extended: `workflowKeys.list`, `workflowKeys.runs(id)`, plus new `['workflow-templates']`, `['workflow-template', id]`, `['employees']`, `['skills']`, `['subscription']`.
- Optimistic-write triad (`onMutate → cancel → snapshot → setQueryData → onError restore → onSettled invalidate`) reused verbatim for activate/deactivate/delete/duplicate.
- No toast primitive: success/error is inline text (`Saved.`/red message), mirrored into one `aria-live` region.
- **Honesty flags carried into the UI (do not fake):**
  - `WorkflowDto` has **no** `lastRunAt`/`activeVersionId`/`draftVersionId` and **no** owner-employee field. "Owner AI Employee(s)" is derived client-side from `definition.nodes` where `type==='AI_EMPLOYEE_STEP'`, resolving `config.employeeId` against `GET /employees`; an unresolved `{{param.x}}` employeeId (fresh template install) renders a neutral "Unassigned" chip, never a broken avatar. "Last run" is an **optional lazy enrichment** per visible row via `GET /workflows/:id/runs?limit=1`, not a list column guarantee.
  - Row status pill keys off `WorkflowStatus = DRAFT | ACTIVE | PAUSED | ARCHIVED` only. There is **no** `PUBLISHED` workflow status — publishing is version-level and not exposed on `WorkflowDto`, so the list never claims "Published."
  - List API is `GET /workflows?limit=` → **bare array, no server filters/sort/cursor**. All search/sort/status-filter is **client-side** over the fetched set; pagination is client "Load more" driven by raising `limit`.

---

# 1. `WorkflowListPage` (route `/workflows`)

### (1) Purpose
The company's operational index of every workflow — a manager scans by *who runs it, what state it's in, and what it's waiting on*, then opens/runs/activates/manages one. It is the top of the three-level shell (List → Builder → Watch). It hosts the entry toggle to Create/Templates/Generate (component 2/3 mount here).

**Table vs card grid — decision: a dense table (`role="table"`), not cards.** Justification: workflows are *operational records* scanned along shared axes (status, trigger, last run, updated) where cross-row comparison and sort matter — a table gives aligned columns, one-glance status scanning, and keyboard row-nav. A card grid optimises for *discovery of unlike things* (that is the Template Gallery's job, component 3, which is correctly a grid). Mixing them would blur "browse to pick something new" (grid) vs "manage what I already run" (table). The one place we bend the table toward the AI-Employee-OS thesis: the first cell renders the derived **employee avatar stack** (person-language from the spine) so the roster reading survives even in a table.

### (2) States
- **loading** — skeleton rows (see 10).
- **loaded / populated** — header (title + toggle cluster + search/sort/status controls) over the table.
- **empty (zero workflows)** — invitation (see 11-empty).
- **empty-after-filter** — rows exist but the client filter/search matched none → *"No workflows match "termite". Clear the search to see all 12."* + Clear button (distinct from zero-state; never shows the create-CTA empty screen).
- **error** — list fetch failed (see 11).
- **row-busy** — a per-row mutation (run/activate/deactivate/duplicate/delete) in flight → that row's action control shows inline pending; row `aria-busy`.
- **row-optimistic** — status pill already reflects the optimistic result while `onSettled` reconciles.
- **partial (Load more available)** — fetched count `=== limit` (more may exist) → a footer "Load more" control.

### (3) Interactions
- Row **click / Enter** on the row (outside action controls) → `router.push('/workflows/:id')` (Edit mode).
- **Row actions** via an always-visible per-row `⋯` menu (`role="menu"`, not hover-only — a11y + touch parity with the spine's per-node `⋯`): **Open**, **Run…**, **Activate** / **Deactivate** (mutually exclusive by status), **Duplicate**, **Manage access…**, **Delete…**. Each disables with a reason (see 12).
  - **Run…** opens the same Run popover contract the builder Toolbar uses (`{ trigger?, dryRun? }` form) anchored to the row; on success `router.push('/workflows/:id?run=' + created.id)` (jump straight to Watch).
  - **Activate** → `POST /workflows/:id/activate`; **Deactivate** → `POST /workflows/:id/deactivate` (this is "pause"; there is no `/pause` route).
  - **Duplicate** → there is no clone endpoint, so this is `GET /workflows/:id` (to read `definition`) → `POST /workflows { name: "<name> (copy)", description, definition }`; lands the copy as a new DRAFT row.
  - **Manage access…** → opens `PermissionsPanel` (Modal) over `GET/POST/DELETE /workflows/:id/permissions`.
  - **Delete…** → `window.confirm` (kept, per spine) *"Archive "<name>"? Its run history is kept and you can't run it after."* → `DELETE /workflows/:id` (soft-archive default). A **Delete for good** affordance (OWNER-only) inside the confirm path maps to `?hard=true`.
- **Search** — client-side, over name + description + derived employee names; debounced 200ms; `/` focuses it.
- **Sort** — client menu: Recently updated (default, `updatedAt desc`), Name A–Z, Status. (Server sends only `createdAt desc`; we re-sort locally.)
- **Status filter** — segmented control: All · Draft · Active · Paused · Archived (archived hidden by default; a "Show archived" toggle).
- **Entry toggle** (component 2/3): `[ Your workflows | Templates | + New | Generate with AI ]`.

### (4) Props (typed shape)
```ts
// Page owns no props (route component); internal row + list shapes:
type WorkflowListItem = WorkflowDto; // { id, companyId, name, description, status,
  // definition, triggerType, triggerConfig, webhookToken, activatedAt, createdAt, updatedAt, warnings }

interface WorkflowRowProps {
  workflow: WorkflowDto;
  derivedEmployees: DerivedEmployee[];      // computed from definition + employees cache
  lastRun?: WorkflowRunDto | null | 'loading'; // lazy enrichment; undefined = not fetched
  isOwnerOrAdmin: boolean;                    // gates Activate/Delete-hard/Manage-access
  isBusy: boolean;
  onOpen(id: string): void;
  onRun(id: string): void;
  onActivate(id: string): void;
  onDeactivate(id: string): void;
  onDuplicate(id: string): void;
  onManageAccess(id: string): void;
  onDelete(id: string, hard: boolean): void;
}
interface DerivedEmployee { employeeId: string | null; name: string; role: 'HR'|'MARKETING'|string; unresolved: boolean; }

interface ListControlsState {
  query: string;
  sort: 'updated' | 'name' | 'status';
  statusFilter: 'ALL'|'DRAFT'|'ACTIVE'|'PAUSED'|'ARCHIVED';
  showArchived: boolean;
  limit: number; // starts 50, +50 on Load more
}
```
All list/control state is **local** (component state) — never the Zustand store (hard rule §15.0.6-6).

### (5) Data requirements
- Workflows: `WorkflowDto[]` (the array).
- Employees for avatar/name resolution: `GET /employees` → `{ id, name, role, avatarUrl? }[]`, cached under `['employees']` (staleTime 5min).
- Subscription (for the "Generate with AI" toggle gating): `useSubscription()` → plan; BUSINESS/ENTERPRISE enables Generate.
- Optional per-row last run: newest `WorkflowRunDto` (status + finishedAt) for visible rows only.
- Current user role (`session.store` → `user.role`) to compute `isOwnerOrAdmin`.

### (6) API dependencies (exact method + path)
- `GET /workflows?limit={n}` → `WorkflowDto[]` (list; client filters/sorts).
- `GET /employees` → employee roster (name/role/avatar) for derivation.
- `GET /workflows/:id/runs?limit=1` → `WorkflowRunDto[]` (lazy last-run per visible row).
- `POST /workflows/:id/run` (body `{ trigger?, dryRun? }`) → `WorkflowRunDto` (201).
- `POST /workflows/:id/activate` → `WorkflowDto` (200; 400 if no non-TRIGGER node).
- `POST /workflows/:id/deactivate` → `WorkflowDto` (200).
- `GET /workflows/:id` + `POST /workflows` → duplicate.
- `DELETE /workflows/:id` (and `?hard=true`, OWNER-only) → 204 (409 while a run is PENDING/RUNNING/WAITING).
- `GET /workflows/:id/permissions`, `POST …/permissions`, `DELETE …/permissions/:permissionId` (Manage access).
- (No cursor endpoint, no bulk endpoint, no `/pause` — all confirmed absent.)

### (7) Responsive behaviour
- **Desktop ≥1280** — full table: columns `Workflow (name + employee stack) · Status · Trigger · Last run · Updated · ⋯`. Controls inline in the header.
- **Tablet 768–1279** — drop the `Updated` column (fold into a subtitle under name); `Last run` stays. Sort/status collapse into a single "Filter" popover button.
- **Mobile <768** — table becomes a **stacked card list** (each workflow = one tappable card: name, employee avatars, status pill, trigger label; `⋯` opens the action sheet). Search stays; sort/filter in a bottom sheet. This is a monitor/act surface — Run/Activate/Approve reachable, consistent with the spine's mobile stance. Full-row tap → builder in Watch/read context on mobile.

### (8) Keyboard behaviour
- Table wrapper is a roving-tabindex grid: **↑/↓** move row focus, **Enter** opens, **⌘/Ctrl+Enter** = Run…, **Space** toggles row selection (reserved for future bulk; single-select today).
- **⇧F10 / Menu key** on a focused row opens its `⋯` menu (arrow-navigable, Esc closes, focus returns to the row).
- **/** focuses search; **Esc** in search clears then blurs.
- Header toggle cluster is a standard tablist (`←/→` between tabs, Enter activates).
- All controls reachable in a logical tab order; no keyboard trap.

### (9) Accessibility
- `role="table"` with `role="row"/"columnheader"/"cell"`; each row `aria-label` in employee-OS language: *"Recruitment intake. Active. Runs Emma, HR. When a candidate emails. Last run completed 2 minutes ago."* — names, not ids or `AI_EMPLOYEE_STEP`.
- Status pill is **icon + text + color**, never color alone (reuse spine `status-*` glyphs); pill text is a real word (Draft/Active/Paused/Archived).
- Employee avatars: `alt` = "<name>, <role> employee"; the stack has an `aria-label` summarising count when it overflows ("Emma and 2 others").
- `⋯` menu is a real `role="menu"`; disabled items keep `aria-disabled` + a `title`/tooltip reason.
- One `aria-live="polite"` region reuses the visible inline strings on mutation ("Recruitment intake is now active." / "Archived Recruitment intake."). `assertive` reserved for a failed activate/delete.
- Visible `:focus-visible` ring (spine `focus-ring`) on rows, controls, menu items.

### (10) Loading state
- Initial: **6 skeleton rows** (shimmer blocks sized to the columns — name bar + avatar circles + pill + short bars), header controls rendered but disabled; container `aria-busy="true"`. Never a bare spinner (spine rule).
- Lazy last-run: that cell shows a 1-line shimmer until its `GET …/runs?limit=1` resolves (independent of row interactivity — the row is fully usable while it loads).
- "Load more": the appended fetch shows 3 skeleton rows beneath existing ones.

### (11) Error state
- **List fetch error** → replace the table body with an inline panel (not a toast): copy mapped from `NormalizedApiError` — generic 5xx/network: *"We couldn't load your workflows. Try again."* + **Retry** (refetches). 401 is handled by the apiClient refresh interceptor; a hard 401 → guard redirects to `/login`.
- **Row mutation errors** (inline on the row, `aria-live` assertive, optimistic change rolled back):
  - Activate **400** ("≥1 non-TRIGGER node"): *"Add at least one step before you activate this."* (also disables Activate proactively — see 12).
  - Delete **409** (in-flight run): *"This is still running — you can archive it once the run finishes."*
  - Run **403** (RUN-restricted): *"You're not set up to run this workflow."*
  - Duplicate/create **4xx**: surface joined `message`.
  - **429**: *"Give it a moment — too many requests just now."* with a retry-after countdown if present.
- Empty-after-filter (see 2) is **not** an error — it is a client zero-match with a Clear action.

### (12) Disabled state
- **Activate** disabled when the workflow's `definition.nodes` has no non-TRIGGER node → tooltip *"Add at least one step first."* (mirrors the shipped 400 precondition, so we never let the user hit it). Also disabled when `status==='ACTIVE'`.
- **Deactivate** disabled unless `status==='ACTIVE'`.
- **Run…** disabled when `status==='ARCHIVED'` → tooltip *"This workflow is archived."* (Test/dry-run still allowed inside the builder, not here.)
- **Delete for good (`?hard=true`)** disabled for non-OWNER → tooltip *"Only an owner can delete for good."*
- **Manage access…** disabled for non-owner-non-admin → *"Only the owner or an admin can share this."*
- **Duplicate** disabled while its source fetch/create is in flight.
- **Generate with AI** toggle disabled on non-BUSINESS/ENTERPRISE plans → tooltip *"Generating with AI is on Business and Enterprise plans."*
- Every disabled control keeps `aria-disabled` + a concrete reason; none are bare-greyed.

---

# 2. Create Workflow flow — `CreateWorkflowMenu` + `NewWorkflowNameForm`

Two coupled pieces mounted from the list header toggle: a **choice surface** (Blank / From a template / Describe it) and, for the Blank path, a **name form** that creates a DRAFT and lands in the builder. "From a template" delegates to component 3; "Describe it" opens `GenerateWorkflowChat` (kept/extended). This spec covers the choice surface + the Blank name form.

### (1) Purpose
Turn intent into a DRAFT workflow the fastest honest way: an empty canvas, a template, or an AI draft. It is the single front door so the three creation paths converge on the same outcome — `router.push('/workflows/:id')` with a DRAFT — and never a dead form.

### (2) States
- **menu-closed** — the four toggle tabs sit in the list header; "New" and "Generate with AI" open this flow.
- **choice-open** — three option cards: **Start blank**, **Start from a template**, **Describe it (AI)**.
- **naming (Blank)** — `NewWorkflowNameForm` (name required, description optional).
- **submitting** — create mutation in flight.
- **success** — navigates away to `/workflows/:id` (DRAFT); no lingering surface.
- **error** — create failed; inline under the form.
- **generate-gated** — "Describe it" card shown but disabled/locked on non-BUSINESS/ENTERPRISE with an upgrade affordance.

### (3) Interactions
- **Start blank** → reveals `NewWorkflowNameForm`. On submit → `POST /workflows { name, description? }` (definition omitted → server seeds `STARTER_DEFINITION` = single TRIGGER node) → on success `router.push('/workflows/' + created.id)`. The new builder opens on the lone-TRIGGER empty canvas with the ghost "+ Add the first step" affordance (spine empty state).
- **Start from a template** → opens the Template Gallery (component 3) — does not create anything yet.
- **Describe it (AI)** → opens `GenerateWorkflowChat`; its returned `definition` is handed to `POST /workflows` (same create call, with definition) → lands as DRAFT, optionally with `?unresolved=1` when `unresolvedNodes[]` is non-empty (banner in builder).
- Form: Enter submits, Esc cancels back to choice, then closes.

### (4) Props (typed shape)
```ts
interface CreateWorkflowMenuProps {
  canGenerate: boolean;          // plan BUSINESS/ENTERPRISE
  onOpenTemplates(): void;       // → component 3
  onOpenGenerate(): void;        // → GenerateWorkflowChat
}
interface NewWorkflowFormValues { name: string; description?: string; } // zod: name 1..160, description ≤2000
interface NewWorkflowNameFormProps {
  onCancel(): void;
  onCreated(workflow: WorkflowDto): void;
}
```
`react-hook-form` + `zodResolver` over `NewWorkflowFormValues` (schema re-exported from `@vaep/types` via `features/workflows/schemas.ts`, mirroring `CreateWorkflowDto` bounds).

### (5) Data requirements
- Plan (`useSubscription`) to compute `canGenerate`.
- No other reads for the Blank path. The created `WorkflowDto` (with server-seeded `definition`) is written into the `workflowKeys.list` cache optimistically/onSettled.

### (6) API dependencies
- `POST /workflows` (body `CreateWorkflowDto { name, description?, definition? }`) → `WorkflowDto` (201). Blank omits `definition`; AI path sends the generated `definition`.
- `POST /workflows/generate` (BUSINESS/ENTERPRISE, 10/min, 201, discriminated `question|draft`) — driven by `GenerateWorkflowChat`, not this form directly.
- Template path uses component 3's install endpoints.

### (7) Responsive behaviour
- **Desktop/Tablet** — choice surface as a centered `Modal` (three option cards in a row on desktop, stacked on tablet). Name form is a compact card within the same modal.
- **Mobile** — full-screen sheet; option cards stacked; the name form fields are full-width, single column; primary CTA pinned to the bottom of the sheet. (Creating is allowed on mobile — it is not graph authoring; it just lands a DRAFT you then edit on desktop, so a quiet note appears after create: *"Draft created. Editing the steps works best on a larger screen."*)

### (8) Keyboard behaviour
- Choice modal is focus-trapped (`Modal` primitive): Tab cycles the three cards + Close; Enter activates a card; Esc closes.
- Name form: Tab name→description→[Cancel][Create]; Enter in a field submits; Esc → back to choice.
- Focus moves to the Name field on entering the Blank path; on close, focus returns to the "New" toggle.

### (9) Accessibility
- `Modal` = `role="dialog" aria-modal="true"` with an `aria-labelledby` on its title ("Create a workflow").
- Option cards are `role="button"` (or real buttons) with descriptive labels: *"Start blank — an empty workflow you build step by step."*, *"Start from a template — 22 ready HR and Marketing workflows."*, *"Describe it — tell the AI what you want and it drafts the steps (Business and Enterprise)."*
- Form errors render as `text-red-400` `<p>` tied to the field via `aria-describedby`; the field gets `aria-invalid`.
- Disabled Generate card has `aria-disabled` + reason.
- Success navigation announced via the shared `aria-live`: *"Draft created."*

### (10) Loading state
- Create submit: the **Create** button shows an inline pending label ("Creating…") and disables; the form stays visible (no skeleton — it is a fast single write). No spinner-only screen.

### (11) Error state
- `POST /workflows` **400** (validation) → inline under the offending field (name too long/empty) using joined `message`.
- **429** → *"Give it a moment — too many requests just now."* inline above the buttons; Create re-enabled after the countdown.
- Generate path **403** → the card flips to an inline upgrade line: *"Generating with AI is on Business and Enterprise plans."* (never a raw error).
- Network/5xx → *"We couldn't create that workflow. Try again."* + the form stays filled so nothing is lost.

### (12) Disabled state
- **Create** disabled while `name` is empty/invalid or a submit is in flight → tooltip on hover of the disabled button: *"Name your workflow first."*
- **Describe it (AI)** card disabled when `!canGenerate` (reason as above).
- **Start from a template** never disabled (browsing is free; prerequisite gating happens at install, component 3).

---

# 3. Template Selection — `TemplateGallery` + `TemplateInstallForm`

A card grid of first-party (22 HR+MK) + tenant templates, a detail/params view, and the install flow that produces a DRAFT. Mounted from the list "Templates" toggle (no new Sidebar entry). This is the deliberate **grid** counterpart to the list's table.

### (1) Purpose
Let a manager browse ready-made workflows *by the employee/role that runs them*, understand what each does and needs, fill its bindings (which employee, which channel, which connection), and install it as a DRAFT — with prerequisite gaps surfaced as actionable steps, never raw errors.

### (2) States
**Gallery:** loading (skeleton cards) · loaded · empty (no templates visible) · error.
**Card:** default · hover/focus · installing (this card busy).
**Detail/Install form:** loading params · ready · submitting · install-success (→ navigate to DRAFT) · **prereq-blocked (422)** · error (404/409/other).

### (3) Interactions
- Grid grouped by **category/role** (HR, Marketing, then any tenant `CUSTOM`/others), with a role/category filter chip row and a client search over name+description. Grouping headers name the employee framing: "HR employee workflows", "Marketing employee workflows".
- **Card click / Enter** → opens `TemplateInstallForm` (Modal) → fires `GET /workflow-templates/:id/parameters` to load `parameters[]` + `requires`.
- Install form renders **one field per `TemplateParameter`**, using a resource picker per `binds`:
  - `binds:'employee'` → "Which employee?" — picker over `GET /employees` **filtered to the template's `requires.employeeRoles`** (HR or MARKETING); never offers a CUSTOM employee.
  - `binds:'channel'` → "Which channel?" — Slack channels from the installed `slack` skill config.
  - `binds:'skill'` → "Which connection?" — picker over `GET /skills` (installed).
  - `binds:'knowledgeCategory'` → "Which knowledge?" — knowledge scope picker.
  - non-bound params render as typed fields (string/number/boolean per `TemplateParameter.type`), `required` enforced.
  - Optional **Name** field (defaults to the template name) → `InstallWorkflowTemplateDto.name`.
- **Install** → `POST /workflow-templates/:id/install` with an **`Idempotency-Key`** header (a client-generated UUID minted once per form open, so a double-click/retry dedups to the original DRAFT) + body `{ name?, parameters }` → on 201 `router.push('/workflows/' + created.id)` (the installed DRAFT; if the template left unresolved bindings, append `?unresolved=1`).
- **Prereqs** shown up front: from `requires` (skills, employeeRoles, minPlan) rendered as a checklist above the form ("Needs: a Marketing employee · Gmail connected · Business plan"), each item green-checked when satisfiable, amber with a fix-link when not.

### (4) Props (typed shape)
```ts
interface TemplateGalleryProps { onInstalled(workflow: WorkflowDto): void; }

interface TemplateInstallFormProps {
  templateId: string;
  onCancel(): void;
  onInstalled(workflow: WorkflowDto): void;
}
// Fetched:
type TemplateSummary = WorkflowTemplateSummaryDto; // { id, companyId, key, version, name, description,
  // category, parameters: TemplateParameter[], requires: WorkflowTemplateRequires, status, createdAt }
interface InstallFormValues {
  name?: string;
  parameters: Record<string, unknown>; // keyed by TemplateParameter.key
}
```
Form via react-hook-form; each `binds` picker writes the selected resource id (or literal) into `parameters[key]`.

### (5) Data requirements
- Template list: `WorkflowTemplateSummaryDto[]` (first-party `companyId=null` PUBLISHED + this tenant's own), ordered category→name.
- Template params/requires: the single-template summary from `GET /workflow-templates/:id/parameters`.
- Binding sources: `GET /employees` (role-filtered), `GET /skills` (installed), Slack channel list (from slack skill config), knowledge categories.
- Plan (`useSubscription`) to pre-flag `requires.minPlan`.

### (6) API dependencies
- `GET /workflow-templates` → `WorkflowTemplateSummaryDto[]` (grid).
- `GET /workflow-templates/:id/parameters` → `WorkflowTemplateSummaryDto` (form source; `definition` deliberately omitted).
- `POST /workflow-templates/:id/install` (+ `Idempotency-Key` header, body `InstallWorkflowTemplateDto { name?, parameters? }`) → `WorkflowDto` (201; deep-copies to DRAFT + v1, never auto-activated).
- `GET /employees`, `GET /skills` for pickers.
- (Reconciliation locked: install path is `/:id/install` with `Idempotency-Key`, **not** `/:id/instantiate`; there is no `DELETE /workflow-templates/:id`.)

### (7) Responsive behaviour
- **Desktop ≥1280** — 3-column card grid; install form as a right-ish centered Modal (single column of fields).
- **Tablet** — 2-column grid; install Modal full-height sheet.
- **Mobile** — 1-column card list; install form full-screen sheet, fields stacked, CTA pinned bottom. Installing on mobile is allowed (it lands a DRAFT); a note after success mirrors the create flow's "editing works best on a larger screen."

### (8) Keyboard behaviour
- Grid is a roving-tabindex list of cards: **←/→/↑/↓** move focus, **Enter** opens the install form. Filter chips are a toggle group (arrow-nav). **/** focuses search.
- Install Modal focus-trapped: Tab through fields → [Cancel][Install]; Enter submits from a field; Esc cancels; focus returns to the originating card on close.
- Resource pickers are `combobox`-pattern (type-to-filter, ↑/↓ options, Enter select, Esc close).

### (9) Accessibility
- Grid `role="list"`, cards `role="listitem"`/button with `aria-label`: *"Candidate screening. HR employee. Needs Gmail and Google Drive. Business plan."*
- Group headers are real headings (`h2`) tying cards to the employee-OS framing.
- `Modal` = `role="dialog" aria-modal="true"`, `aria-labelledby` the template name.
- Each param field labelled by the `TemplateParameter.label` (employee-side wording, e.g. "Which employee?"), `help` text via `aria-describedby`.
- Prereq checklist is a `role="list"` with each item's satisfied/unsatisfied state announced as text, not color alone (check/warn glyph + word).
- Install result announced in the shared `aria-live`: *"Installed Candidate screening. Opening the draft."*

### (10) Loading state
- Gallery: **6–9 skeleton cards** (title bar + role chip + 2 skill glyphs + short desc), `aria-busy`.
- Install form: **3 field-shaped shimmer blocks** while `GET …/parameters` loads (mirrors the Inspector loading pattern).
- Install submit: **Install** button → inline "Installing…" + disabled; the form stays put.

### (11) Error state
- **Gallery fetch error** → inline panel *"We couldn't load templates. Try again."* + Retry.
- **Install 422 (the load-bearing one — prereqs/binds)** → do **not** show a raw error. Parse the joined `; `-separated message into the prereq checklist and mark the failing items, with an action per item:
  - Missing MARKETING role (G10): *"Hire a Marketing employee to use this workflow."* + link to hire/employees.
  - Missing skill: *"Install Gmail first."* + link to the skills/connections screen.
  - Plan below `minPlan`: *"Upgrade to Business to install this."* + upgrade link.
  - Missing/type-mismatched param or a `binds` id that no longer resolves → per-field inline error on that specific field.
  The **Install** button stays disabled until the offending items are resolved (re-pick / go install the skill and return).
- **404** (template not visible) → *"This template isn't available anymore."* close the form.
- **409** (template not PUBLISHED) → *"This template isn't published yet."*
- **429** → *"Give it a moment — too many requests just now."*
- Idempotency: a retried install with the same `Idempotency-Key` returns the **original** DRAFT (201) — the UI treats a "duplicate" quietly as success and navigates, never surfacing a conflict.

### (12) Disabled state
- **Install** disabled while any `required` param is empty, any prereq item is unmet, or a submit is in flight → tooltip names the first blocker: *"Pick which employee runs this."* / *"Hire a Marketing employee first."* / *"Connect Gmail first."*
- Employee picker disabled/empty-state when no employee of the required role exists → inline *"No HR employee hired yet."* + hire link (this is the client-side pre-empt of the 422).
- Skill/channel pickers disabled with *"No connections yet — connect one to continue."* when their source list is empty.
- Cards for templates whose `requires.minPlan` exceeds the plan are **not** disabled for browsing (you can still read what they do) — the gate lives at Install, so discovery is never blocked.

---

Key files these three specs reshape (absolute): `D:/Vertical AI/platform/apps/web/src/app/(app)/workflows/page.tsx` (list + toggle host), new `.../features/workflows/components/{WorkflowListTable,CreateWorkflowMenu,NewWorkflowNameForm,Templates/{TemplateGallery,TemplateInstallForm,PrereqChecklist},PermissionsPanel}/`, extend `.../features/workflows/{api.ts,hooks.ts,labels.ts,schemas.ts}`, new `.../components/ui/Modal.tsx`. Reused unchanged: `useWorkflows/useCreateWorkflow/useDeleteWorkflow/useActivateWorkflow/useDeactivateWorkflow/useRunWorkflow`, the single `apiClient`/`queryClient`/session store, `Button`, `.field-modern`.


---

## 3.B — Canvas system (infinite canvas · connection validation · edges · interactions)

# CANVAS SYSTEM — Component Specifications

Orlixa V-AEP Workflow Builder. All tokens, status colors, node visual language, keyboard/context-menu system, and loading/error/empty patterns are inherited from the DESIGN SPINE (Parts 1–2) and are referenced — not re-derived. Every component below defines all 12 attributes. No React code. All endpoints verified against the shipped API surface (Ground Constraint C).

Component roster:

| # | Component | Cluster |
|---|---|---|
| 1.1 | `WorkflowCanvasSurface` | Infinite Canvas |
| 1.2 | `CanvasEmptyState` | Infinite Canvas |
| — | Rendering + performance guidance (prose) | Infinite Canvas |
| 2.1 | `ConnectionDragLayer` | Connection / Validation |
| 2.2 | `ConnectionValidityFeedback` | Connection / Validation |
| 2.3 | `ValidationIssuePanel` (pre-publish check) | Connection / Validation |
| 3.1 | `ZoomControl` | Canvas Interactions |
| 3.2 | `Minimap` | Canvas Interactions |
| 3.3 | `MarqueeSelectionBox` | Canvas Interactions |
| 3.4 | `AlignmentGuides` | Canvas Interactions |
| 3.5 | `WorkflowEdge` | Canvas Interactions |

---

# CLUSTER 1 — INFINITE CANVAS

## 1.1 `WorkflowCanvasSurface`

The pannable/zoomable React Flow surface that hosts every node and edge. It is the `role="application"` region named in Spine Part 2 §6.1. It owns the viewport, the world↔screen coordinate mapping, and the background. It does **not** own node/edge data (that is React Flow `useNodesState`/`useEdgesState` in the parent `WorkflowCanvas`) — this component is the wrapper that configures the surface.

**(1) Purpose.** Provide the infinite, dark, dot-gridded world on which the workflow "sentence" reads top-to-bottom; convert pointer/keyboard gestures into pan/zoom/select per Spine §2; enforce the 500-node / 1 MB render ceiling; expose the surface to assistive tech as one focusable application with the Outline view as the connectivity fallback.

**(2) States.**
- `mode`: `edit` | `watch` | `locked` (Spine Part 2 §1.1). `watch`/`locked` set React Flow `nodesDraggable=false`, `nodesConnectable=false`, `elementsSelectable` stays true (inspection allowed).
- `viewport`: `{ x, y, zoom }` — persisted only in local component state, never the store.
- `interaction`: `idle` | `panning` | `marquee` | `connecting` | `node-dragging`.
- `snap`: grid-snap on/off (default on; 8px — Spine §2.4).
- `busy`: `true` while `useWorkflow(id)` is loading → `aria-busy=true`, pointer events blocked.
- `overCap`: `true` when node count ≥ 480 (warn) or definition byte size approaches 1 MB.
- `empty`: `true` when the graph is a lone TRIGGER or has zero nodes → renders `CanvasEmptyState` (1.2) overlay.

**(3) Interactions.** Pan (Space+drag, middle-mouse, two-finger trackpad); zoom (wheel/pinch to cursor, min 0.25 max 2.0, step 0.15); marquee (drag on empty canvas); select/deselect; node drag with grid snap + alignment guides (3.4); connection start handed to `ConnectionDragLayer` (2.1). All gestures and their non-drag keyboard equivalents are defined in Spine §2–3 and are **not** re-specified here; this component wires React Flow props (`panOnScroll`, `panOnScrollMode:'free'` off so wheel=zoom on mouse, `selectionOnDrag`, `panActivationKeyCode:'Space'`, `zoomOnScroll`, `minZoom:0.25`, `maxZoom:2.0`, `snapToGrid`, `snapGrid:[8,8]`, `onlyRenderVisibleElements:true`, `nodesDraggable` per mode). Double-click empty canvas → opens Node Library at pointer (Spine §4.1 "Add step here…"). Right-click / ⇧F10 → `ContextMenu` (Spine §4).

**(4) Props (typed shape).**
```ts
interface WorkflowCanvasSurfaceProps {
  mode: 'edit' | 'watch' | 'locked';
  nodes: RFNode<WorkflowNodeData>[];        // from useNodesState in parent
  edges: RFEdge<WorkflowEdgeData>[];        // from useEdgesState in parent
  snapToGrid: boolean;
  onViewportChange?: (v: { x: number; y: number; zoom: number }) => void;
  onSelectionChange: (sel: { nodeIds: string[]; edgeIds: string[] }) => void;
  onPaneContextMenu: (worldPos: { x: number; y: number }, screenPos: { x: number; y: number }) => void;
  onPaneDoubleClick: (worldPos: { x: number; y: number }) => void;
  isLoading: boolean;                        // drives busy skeleton
  nodeCount: number;                         // for overCap banner
  definitionBytes: number;                   // for 1MB cap warn
  ariaLiveRef: React.RefObject<HTMLDivElement>; // shared polite region (Spine §6.3)
}
interface WorkflowNodeData { nodeId: string; type: NodeType; category: NodeCategory; name?: string; config: Record<string, unknown>; runStatus?: StepRunStatus; validationCodes?: string[]; }
interface WorkflowEdgeData { branch?: string; live?: boolean; runColor?: StatusToken; invalid?: boolean; }
```

**(5) Data requirements.** `nodes`/`edges` derived by the parent from `WorkflowDto.definition` (`{ nodes, edges }`, 2-key shape — Ground B(c)); each node's `position` read from `node.config`-adjacent persisted `position` if present, else seeded by dagre once. `NodeCategory` + registry flags come from `useNodeDefinitions()` (`GET /workflows/node-types` → `{ types }`, then joined to `labels.ts` for category/icon/tone). Run overlay status (`runStatus` per node, edge `live`) comes from the Timeline's `useRunTimeline(runId)` in watch mode. No secret values ever enter node data (Spine f.2 / §6.6).

**(6) API dependencies.** Read-only surface — no direct calls. Data arrives via parent hooks: `useWorkflow(id)` → `GET /workflows/:id`; `useNodeDefinitions()` → `GET /workflows/node-types`; in watch mode `useRunTimeline(runId)` → `GET /workflows/runs/:runId` (poll, `refetchInterval` 1000ms while `PENDING|RUNNING|WAITING`). Position/graph writes are the parent's concern (`PUT /workflows/:id/draft` debounced; `PATCH /workflows/:id { definition, expectedUpdatedAt }` for explicit save) — this surface only emits `onViewportChange`/`onSelectionChange`.

**(7) Responsive.** Desktop ≥1280: full interactive surface. Tablet 768–1279: full authoring; docks become scrim overlays so the surface keeps full width when they close. Mobile <768: **read-only monitor** — surface renders `nodesDraggable=false nodesConnectable=false zoomOnDoubleClick=false`, pinch-zoom + one-finger pan only, and a quiet inline note *"Editing workflows needs a larger screen."*; the Outline view (Spine §6.2) replaces the canvas as the primary graph view when the viewport is narrower than 640px.

**(8) Keyboard.** Wrapper is `tabIndex=0`. With focus and **no** node selected: Arrow keys pan the viewport; Tab/Shift-Tab walk nodes in topological-then-id order; ⌘/Ctrl+0 reset 100%, ⇧1 zoom-to-fit, ⌘/Ctrl +/- zoom. Full map in Spine §3. Esc priority: close popover → deselect → exit connect mode. Canvas shortcuts are `preventDefault`ed only when the surface (not an Inspector field) has focus.

**(9) Accessibility.** `role="application"` `aria-label="Workflow canvas. Use Tab to move between steps, Enter to edit, C to connect."` `aria-roledescription="workflow canvas"`. Edges are `aria-hidden` decorative SVG; connectivity is exposed only through the Outline view. Minimap `aria-hidden` `tabindex=-1`. A single shared `aria-live="polite"` region (passed via `ariaLiveRef`) announces run transitions and connection-validity strings, reusing the exact visible copy. `aria-busy=true` during load. Each node card supplies its own `role="group"` + human `aria-label` (spec'd in the node-card cluster, not here).

**(10) Loading.** Skeleton, never spinner-only (Spine §6.6): dim node-shaped placeholder cards at dagre-estimated positions + centered *"Loading your workflow…"*; surface is `aria-busy`, pointer events disabled, background grid rendered immediately so the frame doesn't flash.

**(11) Error.** Consumes `NormalizedApiError` from the parent's `useWorkflow`. 404 → Locked mode banner *"This workflow isn't here anymore."* (no canvas). 409 on a concurrent save is handled by the Toolbar, not here, but the surface re-seeds nodes/edges when the parent replaces them and **clears the undo stack** (Spine §2.7). Render-level failure (e.g. malformed definition) → inline non-blocking strip above the canvas *"We couldn't draw part of this workflow. Your data is safe — reload to try again."* with a Reload action; never a blank white pane.

**(12) Disabled.** In `watch`/`locked` mode the whole surface is non-editable: nodes not draggable/connectable, add/paste/delete suppressed, cursor `default` (not `grab`), context menu limited to read items (Open, Zoom to fit, Copy). A top banner states the reason (*"Watching a run — editing is paused."* / *"This workflow is archived."*). Over the 500-node ceiling, adding is disabled with *"This workflow is at the 500-step limit."*; approaching it (≥480) shows the non-blocking warn from `overCap` but stays editable.

---

## 1.2 `CanvasEmptyState`

The blank-workflow invitation. Not a dead end — an invitation to add the first Trigger (Spine §6.6 empty-state discipline).

**(1) Purpose.** Turn a brand-new DRAFT (a lone TRIGGER node, or genuinely zero nodes) into an obvious next action: place/see the start and add the first step beneath it. Also the entry point copy for the two authoring on-ramps (template, AI draft) when the workflow is completely empty.

**(2) States.**
- `lone-trigger`: the common new-DRAFT case (server seeds `STARTER_DEFINITION` = single TRIGGER — Ground C(a)). Canvas centers the real TRIGGER node; a ghost *"+ Add the first step"* affordance sits beneath its `main` handle.
- `truly-empty`: zero nodes (rare — e.g. a wiped definition). Shows the centered invitation card with two CTAs.
- `edit` vs `watch/locked`: in watch/locked, the affordance is hidden and replaced by read copy *"This workflow has just a start step and no actions yet."*

**(3) Interactions.** Click/Enter the ghost *"+ Add the first step"* → opens Node Library filtered to "what can follow a Trigger" and auto-connects the pick to the TRIGGER `main` output (Spine §2.5 auto-connect). In `truly-empty`, two CTAs: *"Start from a template"* → opens `TemplateGallery` modal; *"Describe it and let AI draft"* → opens `GenerateWorkflowChat` (disabled with reason on non-Business/Enterprise plans, see Error/Disabled).

**(4) Props (typed shape).**
```ts
interface CanvasEmptyStateProps {
  variant: 'lone-trigger' | 'truly-empty';
  mode: 'edit' | 'watch' | 'locked';
  triggerNodeId?: string;                 // present in lone-trigger
  triggerScreenPos?: { x: number; y: number }; // to anchor the ghost affordance
  canGenerate: boolean;                   // plan gate for the AI CTA
  onAddFirstStep: () => void;
  onOpenTemplates: () => void;
  onOpenGenerate: () => void;
}
```

**(5) Data requirements.** `variant` derived from node count/types by the parent. `canGenerate` from `useSubscription()` (BUSINESS/ENTERPRISE — mirrors the list page gate). No other data.

**(6) API dependencies.** None directly. Downstream actions call existing flows: template install `POST /workflow-templates/:id/install`; AI draft `POST /workflows/generate` (Business/Enterprise, 10/min throttle); add-step uses `useNodeDefinitions()` (`GET /workflows/node-types`).

**(7) Responsive.** Desktop/tablet: ghost affordance anchored under the trigger in world space; the `truly-empty` card centered, max-width 420px. Mobile: no add affordance (read-only monitor) — instead a static line *"This workflow is still empty. Open it on a larger screen to start building."*

**(8) Keyboard.** The ghost *"+ Add the first step"* is a real `<button>` in tab order immediately after the TRIGGER node; Enter/Space activates. In `truly-empty`, the two CTAs are focusable buttons; Tab order: Add-first-step / Templates / Generate.

**(9) Accessibility.** Invitation copy in a `role="note"` region so SR users hear it; the affordance is `aria-label="Add the first step after the start"`. When the AI CTA is disabled, its `aria-describedby` points at the reason text. Announced once via the polite live region when the canvas resolves to empty: *"This workflow is empty. Add the first step, or start from a template."*

**(10) Loading.** Never shown during load — the surface skeleton (1.1 §10) covers loading; `CanvasEmptyState` renders only after data resolves and the graph is confirmed empty/lone-trigger.

**(11) Error.** No fetch of its own. If the downstream Generate CTA is plan-gated, the button is disabled (not hidden) with inline reason *"Generating with AI is on Business and Enterprise plans."* (matches Spine 403 copy).

**(12) Disabled.** In watch/locked, all CTAs and the ghost affordance are absent, replaced by the read-only descriptive line. The Generate CTA is disabled-with-reason when `canGenerate=false`. Templates CTA is always enabled in edit mode.

---

## Rendering approach + performance guidance (prose — not a 12-attr component)

**Rendering technology.** Use **React Flow (`@xyflow/react`) with DOM nodes and SVG edges** — do not hand-roll a `<canvas>`/WebGL renderer. Rationale tied to this product:
- **Nodes are DOM** because the signature spend is the person-card employee node (portrait avatar, role badge, live status dot, always-visible `⋯` menu) plus rich insp600ectors-on-select and full keyboard focus/ARIA per node (`role="group"`). Those a11y and typography requirements (Space Grotesk names, focus rings, SR labels) are load-bearing and effectively free with DOM, expensive/again-reimplemented on a raster canvas. The quality floor (visible focus, per-node keyboard, `⋯` button) is a hard constraint (Ground A(f).7).
- **Edges are SVG** (React Flow default) because branch label pills, the `flow`/`breathe`/`pulseDot` keyframes, dashed invalid states, and reverse-`flow` compensation all express cleanly in SVG + CSS and inherit the global reduced-motion kill for free.
- **Background** is React Flow `<Background variant="dots">` at 12px pitch, dot color `canvas-grid #0B0E18`, on `canvas #02030A`.

**World/screen coords.** React Flow's transform owns world↔screen; node `position` is world-space and persisted in the definition (the only new Save field — Ground A(f).4). Never store viewport in the definition or the store.

**Performance (honour the Phase 12/14 ceilings — Ground A(e), B(d.V12)):**
- `onlyRenderVisibleElements: true` so offscreen nodes/edges are virtualised out of the DOM.
- Memoize the node card component (`React.memo` keyed on id + status + validation) so a run's status ticks don't re-render the whole graph.
- Run **dagre once per load** (`rankdir:'TB'`, rank 48 / node 32), then respect persisted positions; never re-layout on every change.
- Hard ceilings: **500 nodes**, **1 MB** definition. Warn the author at 480/500 (*"This workflow is getting large (480/500 steps)."*); publish beyond → `GRAPH_TOO_LARGE`.
- A `LOOP` body is **one** node on canvas regardless of iteration count; 10,000 iterations never become 10,000 cards — iteration detail lives in the windowed Timeline, not the graph.
- Node Library virtualises its list past a threshold; the canvas itself relies on visible-element rendering, not windowed lists.

---

# CLUSTER 2 — CONNECTION / CONNECTION VALIDATION

## 2.1 `ConnectionDragLayer`

The live connect interaction: drag from a source output handle → hover candidate targets → drop. Owns the in-flight edge preview and target highlighting. Registry-driven — handle topology comes from `NodeDefinitionDto.handles.outputs`, never `switch(NodeType)` (Ground A(f).6).

**(1) Purpose.** Let an author wire "what happens next" by dragging from a bottom output handle to a top input handle (or by the keyboard `C` equivalent), previewing the pending edge, highlighting valid targets, and rejecting illegal drops with an inline explanation — while never letting an invalid connection persist.

**(2) States.**
- `idle`: no drag.
- `pending`: dragging from a handle — `edge-pending` violet dashed line follows the cursor; compatible target handles enlarge + glow `violet`; incompatible ones dim.
- `valid-hover`: pointer over a legal target handle — target handle solid violet, preview snaps to it.
- `invalid-hover`: pointer over an illegal target — preview turns `edge-invalid` red dashed, target handle shows an `x`.
- `dropped-valid`: edge committed, 120ms violet flash on the new edge.
- `dropped-invalid`: preview snaps back; red shake ×2 on the offending handle (reduced-motion → static red + inline text only); `aria-live` explanation fired.
- `drop-on-empty`: opens Node Library filtered to "what can follow this," auto-connects on pick.
- `keyboard-connect`: `C` from a selected node → branch picker (if branching) → topo-ordered target list.

**(3) Interactions.** Drag-connect (source handle → target); drop-on-empty → filtered Library + auto-connect; keyboard connect via `C` / node `⋯` → *"Connect to…"* / edge/handle context-menu *"Connect to…"* (Spine §4.2, §4.5). Branch nodes first ask which branch. Live validity is computed continuously during `pending`/`*-hover` by `ConnectionValidityFeedback` (2.2) and rendered here.

**(4) Props (typed shape).**
```ts
interface ConnectionDragLayerProps {
  nodes: RFNode<WorkflowNodeData>[];
  edges: RFEdge<WorkflowEdgeData>[];
  nodeDefs: Record<NodeType, NodeDefinitionDto>;   // handle topology + flags
  onConnect: (edge: { from: string; to: string; branch?: string }) => void;
  onConnectToEmpty: (source: { nodeId: string; branch?: string }, worldPos: { x: number; y: number }) => void;
  validate: (candidate: PendingConnection) => ConnectionVerdict;  // from 2.2
  ariaLiveRef: React.RefObject<HTMLDivElement>;
  disabled: boolean;                                // watch/locked
}
interface PendingConnection { from: string; to: string; branch?: string; }
interface ConnectionVerdict { ok: boolean; code?: ConnectionRejectCode; message?: string; }
type ConnectionRejectCode =
  | 'SELF_LOOP' | 'INTO_TRIGGER' | 'OUT_OF_TERMINATE'
  | 'WOULD_CYCLE' | 'DUPLICATE_BRANCH' | 'DUPLICATE_EDGE' | 'INTO_OCCUPIED_INPUT';
interface NodeDefinitionDto { type: NodeType; category: NodeCategory; handles: { inputs: HandleDef[]; outputs: HandleDef[] }; highRisk?: boolean; pausesRun?: boolean; default?: Record<string, unknown>; }
interface HandleDef { id: string; label?: string; }
```

**(5) Data requirements.** Output handle set per node from `NodeDefinitionDto.handles.outputs` (most nodes: one `main`; CONDITION: `Yes`/`No`; SWITCH: one per author-named case + `default`; TERMINATE: none; PARALLEL: `main` only — lanes/join are config refs, not edges — Ground B(b)). Existing edges (to detect duplicate/occupied). The current graph adjacency (to run the cycle check ignoring edges into LOOP).

**(6) API dependencies.** None at drag time — connection legality is a **client-side** structural check mirroring the server validator, so the author gets instant feedback. The authoritative recheck happens server-side on draft save (`PUT /workflows/:id/draft`) and publish (`POST /workflows/:id/publish`, 400 on invalid). Handle topology source: `useNodeDefinitions()` → `GET /workflows/node-types`.

**(7) Responsive.** Desktop/tablet (pointer): full drag-connect + hover highlighting. Touch tablet: drag-connect works but the keyboard/`⋯` "Connect to…" picker is the reliable path and is always offered. Mobile: connecting is disabled entirely (read-only monitor); the drag layer is inert.

**(8) Keyboard.** `C` on a selected node enters connect mode → for a branching node, a branch chooser (Yes/No or case) first → then a searchable, topo-ordered target list; Enter wires, Esc cancels (exits connect mode per Esc priority, Spine §3.1). Fully covers the drag gesture's non-drag equivalent (Ground A(f).7).

**(9) Accessibility.** Every rejection speaks through the shared `aria-live="polite"` region with the exact visible string (see 2.2 copy table). The connect-mode target picker is a `role="listbox"` with `aria-activedescendant`; the branch chooser is a `role="menu"`. Handles are not individually focusable (they're small pointer targets); the keyboard path uses the picker instead, which is the accessible equivalent. Reduced-motion: no shake — red border + inline text carry the rejection.

**(10) Loading.** N/A — connecting is only available once the graph has loaded (surface `aria-busy` blocks interaction during load). Node Library's own cached list (`['workflow-nodes']`, staleTime 5min) makes drop-on-empty instant.

**(11) Error.** Client rejections are **inline, non-blocking** (snap-back + `aria-live` string) — never a modal. If a committed connection is somehow rejected server-side on the next draft save (400), the offending edge gets the invalid treatment and the issue surfaces in `ValidationIssuePanel` (2.3); the drag layer itself does not block.

**(12) Disabled.** Fully inert in watch/locked mode (`disabled=true`): handles render but are non-interactive, no pending preview, no keyboard connect. Individual output handles are disabled when already saturated — a single-output `main` that already has an edge shows the handle but rejects a second drag with `DUPLICATE_EDGE`; a CONDITION `Yes` handle already wired rejects with `DUPLICATE_BRANCH` (*"Yes already goes somewhere. Re-point the existing one instead."*). TERMINATE renders **no** output handle at all (nothing to disable).

---

## 2.2 `ConnectionValidityFeedback`

The live validation engine + its visual/aria surfacing, both **while** connecting and as a standing per-node/per-edge validity marker. Encodes the ground brief's V1..V13 rules as client-side structural checks (Ground B(d)). This is a logic-plus-presentation unit consumed by 2.1 (during drag) and by the node/edge cards (standing markers).

**(1) Purpose.** Compute whether a pending or existing connection/graph fragment is legal, translate each engine validation code into plain user-side copy, and render it three ways: (a) instant during-drag verdict, (b) a standing `⚠` marker on an invalid node/edge, (c) feed the pre-publish `ValidationIssuePanel`. It exists so validation copy and rules live in exactly one place, not scattered.

**(2) States.** Per checked target: `valid` | `invalid(code)`. Standing per-node: `clean` | `has-issues(codes[])`. The surfacing states mirror Spine node states: `invalid` node = 1.5px `edge-invalid` dashed border + `⚠` badge + red underline on the offending field; `invalid` edge = red dashed with an `x` at the target.

**(3) Interactions.** Passive/computational during drag (called by 2.1's `validate`). As standing markers: hovering a `⚠` node badge shows a tooltip with the plain-language issue; clicking an issue in the panel focuses+selects the node (2.3). Re-validates on every committed gesture (drag-end, connect, delete, config-field blur — same cadence as the undo stack, Spine §2.7).

**(4) Props (typed shape).**
```ts
interface ConnectionValidityFeedbackProps {
  nodes: RFNode<WorkflowNodeData>[];
  edges: RFEdge<WorkflowEdgeData>[];
  nodeDefs: Record<NodeType, NodeDefinitionDto>;
}
interface ValidationIssue { nodeId?: string; edgeId?: string; code: ValidationCode; message: string; severity: 'blocker' | 'warning'; }
type ValidationCode =
  | 'SINGLE_TRIGGER_REQUIRED' | 'TRIGGER_NOT_ENTRY' | 'DUPLICATE_NODE_ID'
  | 'UNKNOWN_EDGE_SOURCE' | 'UNKNOWN_EDGE_TARGET' | 'UNKNOWN_NODE_TYPE'
  | 'UNJOINED_PARALLEL' | 'PARALLEL_NO_LANES' | 'UNKNOWN_LANE_START' | 'NESTED_PARALLEL'
  | 'CYCLE_DETECTED' | 'UNBOUNDED_LOOP' | 'INVALID_CONFIG'
  | 'INCOMPATIBLE_PLACEMENT' | 'TERMINATE_HAS_OUTGOING_EDGE'
  | 'SWITCH_NO_CASES' | 'MISSING_BRANCH_EDGE' | 'READ_ONLY_SCOPE'
  | 'INLINE_SECRET_FORBIDDEN' | 'GRAPH_TOO_LARGE';
// exports for 2.1:
type ConnectionRejectCode = 'SELF_LOOP'|'INTO_TRIGGER'|'OUT_OF_TERMINATE'|'WOULD_CYCLE'|'DUPLICATE_BRANCH'|'DUPLICATE_EDGE'|'INTO_OCCUPIED_INPUT';
```

**(5) Data requirements.** The full `{ nodes, edges }` graph + `nodeDefs`. Cycle detection uses DFS **ignoring edges into a LOOP node** (mirrors `CYCLE_DETECTED`). Secret scan is camelCase-aware over config values (mirrors `INLINE_SECRET_FORBIDDEN`). All checks are structural — it does **not** verify V9 (employee exists) or V10 (skill installed), which the server enforces at run time / template install, not publish (Ground B(d)).

**(6) API dependencies.** None for during-drag/standing markers (client mirror). Authoritative validation is server-side: draft save (`PUT /workflows/:id/draft` → 400) and publish (`POST /workflows/:id/publish` → 400 with the concatenated issues). The panel (2.3) reconciles the client mirror with the server's returned codes. Never advertise V3 reachability, V9/V10, or error-port completeness as client guarantees.

**During-drag reject copy (exact strings, fired to `aria-live` + shown inline):**

| Reject code | Rule (spine §5.3 / Ground B) | Copy |
|---|---|---|
| `INTO_TRIGGER` | Trigger has no input | *"The start step can't have anything before it."* |
| `OUT_OF_TERMINATE` | TERMINATE has no output (`TERMINATE_HAS_OUTGOING_EDGE`) | *"Stop is the end — it can't lead anywhere."* |
| `SELF_LOOP` | node → itself | *"A step can't connect to itself."* |
| `WOULD_CYCLE` | non-LOOP cycle (`CYCLE_DETECTED`) | *"That would loop back on itself. Only a Loop step can point backwards."* |
| `DUPLICATE_BRANCH` | 2nd edge on same CONDITION/SWITCH branch | *"Yes already goes somewhere. Re-point the existing one instead."* |
| `DUPLICATE_EDGE` | identical from→to→branch | *"These two steps are already connected."* |
| `INTO_OCCUPIED_INPUT` | (advisory) | *"This step already has an incoming connection."* |

**Standing publish-blocker copy (used by 2.3 tooltips + panel):**

| Code | Copy |
|---|---|
| `SINGLE_TRIGGER_REQUIRED` | *"A workflow can only have one start."* |
| `TRIGGER_NOT_ENTRY` | *"The start step can't have anything leading into it."* |
| `UNBOUNDED_LOOP` | *"This loop needs a limit — set how many times it can repeat."* |
| `INLINE_SECRET_FORBIDDEN` | *"Don't paste a secret here — pick it from your saved connections."* |
| `UNJOINED_PARALLEL` | *"This Split has to meet back at a Merge."* |
| `NESTED_PARALLEL` | *"A Split can't contain another Split."* |
| `INCOMPATIBLE_PLACEMENT` | *"An approval can't sit inside a loop."* |
| `SWITCH_NO_CASES` | *"This Switch needs at least one case to route to."* |
| `MISSING_BRANCH_EDGE` | *"One of these branches doesn't lead anywhere yet."* |
| `GRAPH_TOO_LARGE` | *"This workflow is over the 500-step limit."* |
| `INVALID_CONFIG` | *"This step is missing something it needs — open it to finish."* |

**(7) Responsive.** Standing `⚠` markers scale with the node at all breakpoints. On mobile (read-only), the panel/markers are read-only surfaces only.

**(8) Keyboard.** `⚠` node markers are reachable via the node's own focus; the panel rows (2.3) are keyboard-navigable and Enter focuses the node. No separate keyboard target here.

**(9) Accessibility.** Every during-drag verdict speaks through the shared polite live region with the exact string above. Standing invalid nodes add the code's plain message to their `aria-label` suffix (e.g. *"…This loop needs a limit."*) so SR users hear the problem, not just see a red ring. Never color-only: `⚠` glyph + red underline + text always accompany the color.

**(10) Loading.** N/A — validation runs against in-memory graph state after load.

**(11) Error.** If the server returns a 400 code the client mirror didn't predict, 2.3 shows it verbatim-mapped; if the code is unknown to the map, it falls back to *"This step has a problem — open it to fix."* plus the raw code in a `mono-xs` detail line (never a bare stack).

**(12) Disabled.** In watch/locked, validation still computes and markers still render (so an archived/invalid graph reads honestly) but nothing is fixable inline; the panel's "focus node" still works for inspection.

---

## 2.3 `ValidationIssuePanel` (pre-publish check)

The surface where a node/edge exposes its own validation errors before publish — the hard gate. Opens from the Toolbar's Publish/validate action and from a persistent issue count.

**(1) Purpose.** Present all publish-blocking issues as a clickable list mapped to plain user-side copy, each row focusing the offending node/edge on the canvas, so the author can clear blockers before `POST /workflows/:id/publish`. It is the honest "why can't I publish yet" panel — distinct from the non-blocking draft-save experience.

**(2) States.** `hidden` | `clean` (no blockers → *"Ready to publish."* green) | `has-blockers(n)` | `checking` (server round-trip in flight) | `server-rejected` (publish returned 400 with codes) | `warnings-only` (server `warnings[]` present, publishable). Each row: `unresolved` | `resolved` (dims + strikes when the underlying issue clears live).

**(3) Interactions.** Opens on Toolbar `⇧Publish` attempt or on clicking the issue-count chip. Clicking a row selects + centers the node/edge and opens its Inspector (or the specific offending field, red-underlined). Live re-check on every committed edit removes resolved rows. A *"Publish"* button at the panel foot is enabled only when zero blockers remain (Spine disabled discipline). Esc closes.

**(4) Props (typed shape).**
```ts
interface ValidationIssuePanelProps {
  open: boolean;
  issues: ValidationIssue[];              // client mirror, live
  serverIssues?: ValidationIssue[];       // from last 400 publish/draft
  warnings: string[];                     // WorkflowDto.warnings (non-blocking)
  onClose: () => void;
  onFocusTarget: (t: { nodeId?: string; edgeId?: string }) => void;
  onPublish: () => void;
  publishing: boolean;
  mode: 'edit' | 'watch' | 'locked';
}
```

**(5) Data requirements.** Live client `issues` from 2.2; `serverIssues` parsed from the 400 `message` (Nest array joined by `normalizeError`, then split back to per-node codes where possible); `warnings` from `WorkflowDto.warnings` (server-computed "step X has no incoming edge" strings). Node/edge labels come from `labels.ts` + employee/approval names so rows read *"Emma (HR) reviews — this step is missing something it needs,"* never *"node ai_emp_x9: INVALID_CONFIG."*

**(6) API dependencies.** `POST /workflows/:id/publish` (→ 200 `{ version, unchanged }`, or **400** with concatenated validation issues — note publish-invalid is **400, not 422**; 422 is template-install only). Draft autosave `PUT /workflows/:id/draft` may also 400 on structural-invalid, but that path is non-blocking and only tints the panel. `warnings[]` arrives on every `GET /workflows/:id`.

**(7) Responsive.** Desktop: right-docked panel (shares the Inspector dock region, 360px). Tablet: scrimmed overlay sheet from the right. Mobile: read-only — issues listed but not fixable; the *"Publish"* action is hidden with *"Publishing needs a larger screen."*

**(8) Keyboard.** Panel is a focus-managed region; ↑/↓ move between issue rows, Enter focuses the target on canvas (and moves focus there), Esc closes and returns focus to the Toolbar Publish button. The foot *"Publish"* button is in tab order last.

**(9) Accessibility.** `role="region" aria-label="Publish checks"`. The blocker count is announced **assertively** on a failed publish attempt (Spine §6.3 reserves assertive for failed save/publish): *"Can't publish yet — 3 things need fixing."* Each row is a `<button>` with `aria-describedby` the plain message; resolved rows get `aria-disabled` + visually struck. Warnings render in a separate `role="note"` group so they don't read as blockers.

**(10) Loading.** During a publish round-trip: the *"Publish"* button shows an inline *"Publishing…"* label (button-level, not a full skeleton); rows stay interactive. Initial open with no cached issues → 3 issue-row shimmer blocks (matches Inspector skeleton pattern).

**(11) Error.** 400 → populate `serverIssues`, tint panel `server-rejected`, focus the first row, assertive announce. 403 (not permitted to publish / plan) → inline *"You're not set up to publish this workflow."* with the button disabled. 409 (archived) → *"This workflow is archived — reopen it to publish."* 429 → *"Give it a moment — too many requests just now."* with a retry-after countdown. Errors never apologize, never vague (Spine §6.6 table).

**(12) Disabled.** *"Publish"* disabled when: any blocker remains (*"Fix the checks above first"*), the draft is unchanged since last publish (*"Nothing new to publish"* — mirrors server idempotent `{ unchanged:true }`), or mode is watch/locked. In `clean` state with unchanged draft, the panel still shows *"Ready to publish."* but the button explains why it's inert.

---

# CLUSTER 3 — CANVAS INTERACTIONS (as components)

Shared gesture semantics (pan/zoom/select/marquee/move/duplicate/delete/undo/redo/auto-layout keys) are defined in Spine §2–3 and **deferred to the spine**; each component below specs only its own surface.

## 3.1 `ZoomControl`

Bottom-right cluster `[ − | 100% | + | ⤢ ]`.

**(1) Purpose.** Give a visible, pointer- and keyboard-operable control over zoom and fit, with the current zoom shown as a live, clickable percentage that snaps through named levels.

**(2) States.** `zoom` value (0.25–2.0); button states for `−` (disabled at min 0.25), `+` (disabled at max 2.0), `100%` (label reflects current %, acts as reset-to-1.0), `⤢` zoom-to-fit (disabled when zero nodes). Hover/focus/active per button. `watch/locked` does not disable zoom (inspection needs it).

**(3) Interactions.** `−`/`+` step by 0.15 toward the nearest named snap (25/50/100/150/200%); the `%` label click resets to 100% centered on selection or graph centroid; `⤢` fits all nodes (0.15 padding, clamped to max 1.0 so a 1-node graph doesn't balloon). Mirrors keys ⌘/Ctrl +/-, ⌘/Ctrl 0, ⇧1 (Spine §3.3).

**(4) Props (typed shape).**
```ts
interface ZoomControlProps {
  zoom: number;
  minZoom: number; maxZoom: number;        // 0.25 / 2.0
  hasNodes: boolean;
  onZoomIn: () => void; onZoomOut: () => void;
  onResetTo100: () => void; onZoomToFit: () => void;
}
```

**(5) Data requirements.** Current `zoom` from the surface viewport; `hasNodes` from node count. No server data.

**(6) API dependencies.** None.

**(7) Responsive.** Desktop/tablet: full 4-button cluster, bottom-right, `surface-raised` bg, `border-hairline`, `radius-btn`. Mobile: collapses to `[ ⤢ ]` fit-only (pinch handles zoom); the numeric buttons are hidden to preserve thumb space.

**(8) Keyboard.** Each control is a `<button>` in tab order; Enter/Space activates. The `%` label button announces the reset action. Global zoom keys live on the canvas (Spine §3.3); the control mirrors them.

**(9) Accessibility.** `role="group" aria-label="Zoom"`. Buttons: `aria-label="Zoom out"`, `aria-label="Reset zoom to 100 percent"` (label text also reads live current %, `aria-live="off"` on the label to avoid chatter — changes are announced only on explicit reset), `aria-label="Zoom in"`, `aria-label="Fit workflow to screen"`. Disabled buttons carry `aria-disabled` + reason tooltip.

**(10) Loading.** Hidden while the surface is `aria-busy` (nothing to zoom yet); appears with the resolved canvas.

**(11) Error.** None (no fetch). If viewport math ever produces NaN, the `%` label falls back to *"100%"* and reset recenters — never shows a broken value.

**(12) Disabled.** `−` disabled at 0.25 (*"Already at the smallest size"*), `+` at 2.0 (*"Already at the largest size"*), `⤢` when zero nodes (*"Nothing to fit yet"*). All three via `aria-disabled` + tooltip, never removed.

---

## 3.2 `Minimap`

Bottom-left overview, 160×110.

**(1) Purpose.** Give a spatial overview of a large graph and a fast way to jump the viewport; explicitly a decorative pointer convenience, with the Outline view as the accessible connectivity fallback.

**(2) States.** `visible` | `hidden` (toggle in canvas `⋯` menu, Spine §4.1). Viewport rectangle: `idle` | `dragging`. Nodes rendered as violet dots; selected nodes brighter. In `watch` mode, running node dots pulse subtly (reuse `pulseDot`, single instance).

**(3) Interactions.** Click a point → pan viewport to center there; drag the viewport rectangle → pan continuously. No zoom from the minimap. Not focusable (decorative).

**(4) Props (typed shape).**
```ts
interface MinimapProps {
  visible: boolean;
  nodes: RFNode<WorkflowNodeData>[];
  viewport: { x: number; y: number; zoom: number };
  onNavigate: (worldCenter: { x: number; y: number }) => void;
}
```

**(5) Data requirements.** Node positions + selection/run status for dot coloring; current viewport rect. No server data.

**(6) API dependencies.** None.

**(7) Responsive.** Desktop: shown by default. Tablet: shown, but auto-hides when an overlay dock is open to avoid occlusion. Mobile: **hidden** (Outline is the graph view).

**(8) Keyboard.** None — `tabindex=-1`. The keyboard/SR equivalent for "where am I / navigate" is Tab-through-nodes + the Outline tree (Spine §6.2).

**(9) Accessibility.** `aria-hidden="true"`, `tabindex=-1` — explicitly not SR-accessible by design (Spine §2.10, §6.1). It contributes nothing to the a11y tree; connectivity and navigation for AT come solely from the Outline view.

**(10) Loading.** Hidden during surface load; renders with resolved nodes. No skeleton (decorative).

**(11) Error.** None. If node positions are missing, dots simply don't render for those nodes; the map degrades quietly.

**(12) Disabled.** When toggled off (`visible=false`) it is unmounted. In watch/locked it stays a read-only overview (navigation still allowed for inspection).

---

## 3.3 `MarqueeSelectionBox`

The drag-on-empty-canvas rubber-band selector.

**(1) Purpose.** Let an author select multiple nodes by dragging a box on empty canvas (additive with Shift), feeding the multi-selection that powers align/duplicate/tidy/remove.

**(2) States.** `inactive` | `dragging` (box growing) | `committed` (selection applied). Additive vs replace depending on Shift. Only nodes are marquee-selectable (edges are selected individually). Inert in watch/locked for editing, but selection-for-inspection may still be allowed (elements selectable).

**(3) Interactions.** Drag on empty canvas draws a `violet` 1px border + `violet-wash` fill box; nodes intersecting on drop become selected; Shift makes it additive to the existing selection. Esc during drag cancels. This is the default empty-drag (pan requires Space/middle-mouse, Spine §2.1) so selection stays the primary empty-canvas gesture.

**(4) Props (typed shape).**
```ts
interface MarqueeSelectionBoxProps {
  active: boolean;
  rect: { x: number; y: number; w: number; h: number } | null; // screen space
  additive: boolean;
  onSelect: (nodeIds: string[], additive: boolean) => void;
}
```

**(5) Data requirements.** Node screen-space bounds (from React Flow) to hit-test against the box. No server data.

**(6) API dependencies.** None.

**(7) Responsive.** Desktop/tablet pointer: full marquee. Touch: marquee is not the default (one-finger drag pans on touch surfaces); multi-select on touch uses long-press → `⋯` → "Select" additive taps. Mobile: disabled (read-only).

**(8) Keyboard.** No direct keyboard marquee; the equivalent multi-select is ⌘/Ctrl+A (select all) then Shift-Tab/Tab to walk, plus Shift-activate to toggle (Spine §2.3). The spine designates Select-all + Tab as the marquee's non-drag equivalent.

**(9) Accessibility.** The box itself is `aria-hidden` (transient visual). The **result** — the new multi-selection — is announced via the polite live region: *"3 steps selected."* (matches the Toolbar count chip). Selection changes move nothing out of the node focus order.

**(10) Loading.** N/A — only active after load.

**(11) Error.** None.

**(12) Disabled.** Inactive in watch/locked edit terms; if elements-selectable is on for inspection, the box still selects for read-only viewing but no bulk-edit actions are offered on the resulting selection.

---

## 3.4 `AlignmentGuides`

The transient snap/alignment guide lines shown while moving nodes.

**(1) Purpose.** Help an author place nodes tidily by showing 1px guide lines when a dragged node's center or edge aligns with a neighbour, reinforcing the top-down "sentence" reading without a heavy grid.

**(2) States.** `hidden` | `showing(guides[])` during a node drag. Each guide is horizontal or vertical, `violet-secondary` 1px dashed, appearing when alignment is within 4px; snaps the node to exact alignment on release. Coexists with the 8px grid snap (Spine §2.4).

**(3) Interactions.** Appear only during `node-dragging`; disappear on drop. Non-interactive (pure feedback). Respect grid-snap toggle — when grid snap is off, guides still assist alignment to neighbours.

**(4) Props (typed shape).**
```ts
interface AlignmentGuidesProps {
  dragging: boolean;
  guides: { axis: 'x' | 'y'; position: number }[]; // world coords
}
```

**(5) Data requirements.** The dragged node's live bounds + neighbour node bounds to compute alignment. No server data.

**(6) API dependencies.** None.

**(7) Responsive.** Desktop/tablet only (pointer drag). Mobile: N/A (no node dragging).

**(8) Keyboard.** Not shown during keyboard nudge by default (nudge is discrete 8/1/40px, Spine §2.4); optionally a guide flashes when a nudge lands a node into alignment, but this is non-essential and skipped under reduced-motion.

**(9) Accessibility.** Purely visual, `aria-hidden`. No SR announcement (alignment is a cosmetic nicety, not semantic). Node positions are not load-bearing for meaning — connectivity/order come from the Outline, not spatial layout.

**(10) Loading.** N/A.

**(11) Error.** None.

**(12) Disabled.** Absent in watch/locked (no dragging). Can be toggled off with grid snap via the canvas `⋯` menu if the author prefers free placement.

---

## 3.5 `WorkflowEdge`

The edge component: rendering, branch labels, hover, select, delete, reconnect, and live-run animation. Registry-driven — branch semantics come from the source node's handles, never hardcoded (Ground A(f).6, B(c)).

**(1) Purpose.** Draw the top-down connection between two steps as a vertical bezier that reads as "then this happens," carry the meaning-bearing branch label (True/False, case name), and become the live channel during a run — while never inventing ports or branches the engine doesn't have (no `error` port; APPROVAL reject is not an edge).

**(2) States.**
- `idle`: `edge-idle rgba(255,255,255,0.16)`, 1.5px, small target-end chevron.
- `hovered` / `endpoint-selected`: `edge-hover #7659F0`, 2px.
- `selected`: `edge-hover` + thicker hit area, delete/reconnect affordances active.
- `invalid`: `edge-invalid` red dashed + `x` at target (a persisted illegal edge, e.g. flagged by 2.2 after an edit).
- `pending`: (owned by 2.1 during drag) `edge-pending` violet dashed.
- Run overlay (watch mode): `live` (`edge-live` violet `anim-flow`, the currently-executing edge only), `completed` (solid green briefly → settle to idle), `failed` (solid red), `waiting` (solid gold upstream of an approval), `compensating` (reverse `flow`, `status-compensate` purple), `skipped/cancelled` (dimmed dashed).
- Branch edges carry a `mono-xs` label pill (True = `violet-secondary` pill; False = slate; SWITCH case = author label; `default` pill).

**(3) Interactions.** Hover highlights; click selects; Delete/Backspace or context-menu *"Remove connection"* deletes only the edge (Spine §4.3); *"Insert step on this path…"* splits the edge and drops a picked node between (rewires); *"Re-point source / target"* enters reconnect mode (drag an endpoint to a new handle, re-validated by 2.1/2.2); *"Change branch (Yes/No/case)"* for CONDITION/SWITCH edges picks a different unused branch. Reconnect and branch-change run the same validity checks as a fresh connect.

**(4) Props (typed shape).**
```ts
interface WorkflowEdgeProps {
  id: string;
  source: string; target: string;
  branch?: string;                          // 'true' | 'false' | '<case>' | '<default label>' | undefined
  data: {
    labelPillTone?: 'true' | 'false' | 'case' | 'default';
    runState?: 'live' | 'completed' | 'failed' | 'waiting' | 'compensating' | 'skipped' | 'cancelled';
    invalid?: boolean;
  };
  selected: boolean;
  mode: 'edit' | 'watch' | 'locked';
  onSelect: (id: string) => void;
  onDelete: (id: string) => void;
  onReconnect: (id: string, end: 'source' | 'target') => void;
  onChangeBranch: (id: string) => void;
  onInsertStep: (id: string) => void;
}
```

**(5) Data requirements.** `branch` free string from `WorkflowEdge.branch` (persisted shape `{ from, to, branch? }` — **not** `fromPort`/`toPort`). Label pill text is authoritative and must match the engine's routing selector exactly (`'true'`/`'false'` for CONDITION; the case's `branch` label for SWITCH). Run overlay state from `useRunTimeline(runId)` step statuses (derive the "currently-executing" edge as last-COMPLETED → RUNNING). APPROVAL nodes draw a **single forward edge** only; there is deliberately no rejected/error edge (reject fails the run — Spine §5.2).

**(6) API dependencies.** No direct calls — edges are part of the definition. Persistence via the parent's draft/save (`PUT /workflows/:id/draft`, `PATCH /workflows/:id`). Run animation data via `GET /workflows/runs/:runId` (poll; additive WS `run:{runId}` later, `seq`-ordered, gap → full refetch).

**(7) Responsive.** Desktop/tablet: full hover/select/reconnect; label pills at path midpoint with 8px collision padding. Mobile: edges render (read-only) with branch pills visible for comprehension; no hover/select/reconnect. Because edges are `aria-hidden`, the Outline view is where branch structure is actually navigated on any device.

**(8) Keyboard.** Edges are not in the node Tab order (they're `aria-hidden`). Edge actions are reached via: selecting the edge with pointer, or — the accessible path — the Outline view / the source node's context-menu handle items (*"Clear this connection"*, *"Connect to…"*, Spine §4.5). When an edge is pointer-selected, Delete removes it and ⇧F10 opens its context menu.

**(9) Accessibility.** The SVG path is `aria-hidden="true"` (decorative). All edge meaning is exposed through the Outline tree (Spine §6.2), which renders branches as labelled child rows (`├─ Yes → …`, `└─ No → …`). Branch **label pills are also `aria-hidden`** since the Outline restates them; this avoids double-reading. Live-run edge state is not announced per-edge — run progress is announced at the step/node level via the polite region.

**(10) Loading.** Edges appear with the resolved graph (no independent skeleton); during surface load they're covered by the node-skeleton canvas state.

**(11) Error.** A persisted edge that fails validation (e.g. references a deleted node → `UNKNOWN_EDGE_TARGET`) renders in the `invalid` red-dashed state and surfaces in `ValidationIssuePanel` (2.3) — the edge is not silently dropped. A run overlay that references an edge no longer in the pinned version (rare version mismatch in watch mode) simply renders idle, never crashes the path.

**(12) Disabled.** In watch/locked, edges are non-selectable/non-editable — no delete, reconnect, branch-change, or insert; only run-overlay coloring applies. In edit mode, an edge from a saturated single-output handle can't be duplicated (2.1 `DUPLICATE_EDGE`); the *"Change branch"* item is disabled (not shown) on non-branching edges with reason tooltip *"Only Condition and Switch steps have branches."*

---

## Cross-cluster notes for implementers
- All three clusters key visuals off `NodeCategory` + registry flags and read handle topology/branch labels from `NodeDefinitionDto.handles.outputs` — no `switch(NodeType)` anywhere (Ground A(f).6).
- The only animated things on a static Edit canvas are transient (connect flash, marquee, guides); all looping motion (`flow`/`breathe`/`pulseDot`) is reserved for a live run and inherits the global reduced-motion kill (Spine §2.9, Ground A(c)).
- Client validation (2.2) is a **mirror for instant feedback only**; the server's 400 on draft/publish is authoritative, and the panel (2.3) reconciles the two. Never advertise V3/V9/V10 or error-ports as client guarantees.
- Canvas UI state (viewport, selection, marquee, undo stack, panel-open) stays in `WorkflowCanvas` local state / React Flow hooks — never the Zustand store (Ground A(f).1, §15.0.6-6).


---

## 3.C — Node library · search · add-node

# NODE LIBRARY + SEARCH + ADD-NODE — Component Cluster Spec

Orlixa V-AEP Workflow Builder. Inherits DESIGN SPINE Parts 1–2 verbatim (tokens, node visual language, status colors, keyboard/context-menu system, loading/error/empty patterns). This cluster is the **"who and what you can add to the roster"** surface — it must read as *hiring/delegating*, never as a function-box picker.

---

## 0. SHARED FOUNDATION — the `PaletteItem` catalogue (read before the three components)

All three components consume **one derived, client-assembled catalogue**. There is no single backend endpoint that returns it; it is merged in a shared hook `useNodePalette()` from three live sources plus the static label registry. Both the Library and the Command Palette render `PaletteItem[]`; the Add-node flow instantiates one.

### 0.1 Data assembly (the load-bearing detail)

`GET /workflows/node-types` ships **only** `{ types: NodeType[] }` (19 enum strings) — **not** `NodeDefinitionDto` with `handles`/config schema (that DTO is doc-15-aspirational and not in `@vaep/types` yet, Ground A §f.8 / Ground C drift #2). Therefore the catalogue is built client-side:

| Source | Endpoint (exact) | Contributes |
|---|---|---|
| Node type set | `GET /workflows/node-types` → `{ types: NodeType[] }` | which of the 19 engine types are installable; gates card visibility |
| Static registry | `features/workflows/labels.ts` (`NODE_LABELS`/`NODE_HINTS`/`NODE_ICONS`/`NODE_TONES`, already keyed for all 19) + new `NODE_CATEGORY`/`nodeIcon()`/`nodeTone()` fallbacks | user-side label, one-liner, lucide icon, `NodeCategory`, tone accent, `defaultConfig(type)` seed |
| Hired employees | `GET /employees` | fans `AI_EMPLOYEE_STEP` → one card **per hired employee**, role-scoped (HR / Marketing) |
| Installed skills | `GET /skills` (installed only) | fans `TOOL_ACTION` → one card **per skill+tool**; reads `highRisk` from the tool descriptor |

New query keys (extend the existing factory, Ground A §a): `['workflow-nodes']` (staleTime `5·60_000`), `['employees']`, `['skills']`. All gated `enabled: Boolean(accessToken)`. `useNodePalette()` composes the three `useQuery`s + labels into memoized `PaletteItem[]`; it is the single source both panels read (never duplicated).

### 0.2 The card fan-out (why the palette shows > 19 items)

Per Ground B §e / Ground E:

- **`TRIGGER`** → **4 cards**: "When something happens" (`EVENT`) · "On a schedule" (`SCHEDULE`) · "When a form is submitted" (`WEBHOOK`) · "When someone starts it" (`MANUAL`). Discriminated by the workflow-level `triggerType` the card seeds, not node config.
- **`AI_EMPLOYEE_STEP`** → **one card per hired employee** under "AI Employees", titled by name + role badge ("Emma · HR", "Marcus · Marketing"). If none hired, one **ghost** card "Hire an AI Employee" (deep-links to `/employees`). Marketing employees appear only once role `MARKETING` exists (G10); until then Marketing-role employees simply aren't in `GET /employees`, so no special-casing.
- **`AI_STEP`** (legacy) → **never surfaced** (Ground B §e).
- **`TOOL_ACTION`** → **one card per installed skill+tool** under "Skills", titled by the skill verb ("Send email · Gmail", "Store a file · Google Drive", "Schedule a post · Postiz"). A `highRisk` tool card carries the persistent **"Pauses for approval 🔴"** badge inline in the palette (not only on-canvas).
- **`TRANSFORM`** → **2 cards**: "Transform" and "Filter" (the Filter card seeds `operations:[{op:'filter'}]`).
- **`PARALLEL`/`JOIN`** → titled by alias "Split" / "Merge".
- **`NOOP` / `NOTIFY`** → **hidden** (Ground B §e; NOTIFY sends nothing — steer to a Skill card).

### 0.3 Section order (AI-Employee-OS framing, top → bottom)

`AI Employees` · `Triggers` · `Skills` · `Knowledge` · `Memory` · `Logic` · `Approvals` · `Data` · `Timing`. Warmest/most human at top; plumbing (Data, Timing) at the bottom, matching the Spine's saturation-encodes-care rule.

### 0.4 `PaletteItem` typed shape (the unit all three consume)

```
type PaletteItem = {
  itemId: string;              // stable synthetic id, e.g. "trigger.event" | "employee.emp_9f3" | "tool.gmail.send_email" | "transform.filter"
  section: PaletteSection;     // 'AI_EMPLOYEE'|'TRIGGER'|'SKILL'|'KNOWLEDGE'|'MEMORY'|'LOGIC'|'APPROVAL'|'DATA'|'TIMING'
  category: NodeCategory;      // drives the Spine node visual language (rail + tone-badge)
  nodeType: NodeType;          // the engine type this instantiates (one of the 19)
  title: string;              // user-side, e.g. "Send email · Gmail", "Emma · HR", "When a candidate emails"
  blurb: string;              // one line: what it does, e.g. "Emma reads and decides, then hands off."
  icon: LucideIconName;        // verified ≤1.24 (Ground A)
  toneToken: string;          // cat-* accent token
  seed: {                      // what Add-node writes
    config: Record<string, unknown>;      // defaultConfig(nodeType) + card-specific (e.g. {skillKey,tool}, {employeeId})
    triggerType?: TriggerType;             // TRIGGER cards only → workflow-level, not node config
    name?: string;                          // node.name preset (employee/tool cards)
  };
  requires?: RequireHint;      // { kind:'employee'|'skill'|'plan'; label:string; met:boolean; ctaHref?:string }
  highRisk?: boolean;          // TOOL_ACTION highRisk → "Pauses for approval 🔴"
  disabledReason?: string;     // set when the card can't currently be added (see per-component disabled)
  keywords: string[];          // for fuzzy search: title + synonyms ("email","gmail","send","message")
  recencyKey: string;          // === itemId, used by recents store
};
```

`NodeCategory`/section mapping and the `requires` truth come only from live data — never a hardcoded "met" flag.

---

# 1. NODE LIBRARY / PALETTE — `NodeLibrary`

### (1) Purpose
The catalogue of everything addable to the workflow, organised for the AI-Employee-OS framing, reflecting the **tenant's real hired employees + installed skills** (data-driven, not static). It is the browse/scan surface (the Command Palette §2 is the type-to-find surface). Primary jobs: discover a step, understand what it needs ("requires an HR employee / the Slack skill") before adding, and add it by **drag-to-canvas** or **click-to-add-at-cursor**.

### (2) States
- **Closed** (default on desktop): a thin `‹` rail affordance at the canvas left edge + reachable by `⌘K`/`Ctrl K` (opens in search mode) or `⌘/`/`Ctrl /` (opens browse mode).
- **Open — browse**: sections expanded, all items visible, category filter chips.
- **Open — filtered**: an inline search box narrows items (subset of Command Palette fuzzy match, scoped to addable items only; actions excluded).
- **Open — "what can follow this"**: opened from a dangling port / edge-drop (§3), pre-filtered to items valid as the next step and auto-connect armed; header reads *"Add the next step after Emma"*.
- **Section collapsed / expanded**: per-section disclosure, persisted in local component state (not the store).
- **Loading**, **Error (partial)**, **Empty (per source)**, **Disabled items** — see (10)(11) and below.
- **Dragging**: an item is being dragged to canvas (ghost preview follows cursor).

### (3) Interactions
- **Click a card** → adds the node at canvas center (or at the armed cursor/edge position in the port/edge-drop mode), auto-selects it, opens the Inspector (§3 Add-node flow). Panel stays open (browse) so multiples can be added quickly; a subtle inline *"Added Emma"* confirmation appears on the card for `dur-base`.
- **Drag a card onto canvas** → HTML5/pointer drag; a translucent node-preview (the real node card at 0.9 opacity) tracks the cursor; valid drop zones on empty canvas highlight; drop places the node there. Dropping onto an **edge** inserts between (delegates to §3). Dropping onto a **port** auto-connects.
- **Hover a card** → `surface-card-hover`, reveals a 1-line `requires` hint if present; a tooltip after 400ms gives the full blurb + requirement.
- **Search box** (top of panel) → live filter as-you-type; Esc clears then closes.
- **Category chips** (AI Employees / Triggers / Skills / Knowledge / Memory / Logic / Approvals / Data / Timing) → toggle single-section focus.
- **Collapse/expand section** via header chevron or Enter/Space when focused.
- **"Hire an AI Employee" / "Install a skill" ghost cards** → navigate to `/employees` or `/skills` (real back-nav, preserves builder in history).
- **Pin/recent**: the 3 most-recently-added items surface in a "Recent" strip at top (browse mode only), sourced from a client-only recents ring (localStorage, cap 8).

### (4) Props (typed shape)
```
type NodeLibraryProps = {
  open: boolean;
  mode: 'browse' | 'filter' | 'next-step';
  workflowId: string;
  readOnly: boolean;                       // Watch/Locked → panel hidden or add disabled
  addContext?: AddContext;                 // set in 'next-step' mode: source node/port/edge + drop position
  onAdd: (item: PaletteItem, at?: XYPosition) => void;   // click-to-add
  onDragStart: (item: PaletteItem) => void;
  onRequestClose: () => void;
  onNavigate: (href: string) => void;      // ghost-card CTAs
};
type AddContext =
  | { via: 'edge'; edgeId: string; position: XYPosition }
  | { via: 'port'; sourceNodeId: string; branch?: string; position: XYPosition }
  | { via: 'cursor'; position: XYPosition };
```
No node/edge state lives here (hard rule, Ground A §f.1) — the panel emits `onAdd`/`onDragStart`; `WorkflowCanvas` owns mutation.

### (5) Data requirements
- Installable node types: `{ types: NodeType[] }`.
- Hired employees: `{ id, name, role, avatarUrl?, status }[]` filtered to roles usable in `AI_EMPLOYEE_STEP` (HR, MARKETING); each becomes an employee card.
- Installed skills + their tools: `{ skillKey, name, tools: { tool, label, highRisk }[], status: 'CONNECTED'|'DEGRADED'|'DISCONNECTED' }[]`; each tool becomes a `TOOL_ACTION` card.
- Static: `labels.ts` label/hint/icon/tone/category/defaultConfig.
- `requires` computed client-side: an employee card is always `met` (it *is* the resource); a Skill card is `met` when skill `status==='CONNECTED'`; the Marketing-employee section shows the "Hire a Marketing employee" ghost when no MARKETING employee exists.

### (6) API dependencies (exact method + path)
- `GET /workflows/node-types` → `{ types: NodeType[] }` (query key `['workflow-nodes']`, staleTime 5min).
- `GET /employees` → hired employees (filter HR/MARKETING client-side).
- `GET /skills` → installed skills + tools (+ `highRisk` per tool).
- No write endpoints — the panel never persists; adds flow through the canvas → autosave `PUT /workflows/:id/draft`.

### (7) Responsive behaviour
- **Desktop ≥1280**: left **docked drawer**, 300px, `surface-section`, invoked (not permanently pinned) via `‹`/`⌘/`; canvas resizes. Drag-to-canvas primary.
- **Tablet 768–1279**: **overlay drawer** with scrim (`z-panel`), 320px, slides from left; tap-to-add primary (drag still works but click is promoted); scrim tap closes.
- **Mobile <768**: **hidden** — the builder is monitor/approve only (Ground A §1.4). Any "Add step" affordance is replaced by the quiet inline note *"Editing workflows needs a larger screen."*

### (8) Keyboard behaviour
- `⌘/` / `Ctrl /` toggles the panel (browse). `⌘K` opens in filter/search mode (hands typing straight into the search box).
- When open: `↓`/`↑` move item focus across sections (roving tabindex), `←`/`→` collapse/expand the focused section, `Enter`/`Space` = click-to-add, `Esc` clears search then closes (priority order per Spine §3.1).
- `Tab` moves between the search box, category chips, and the item grid; focus never leaves the panel while open except via Esc (not a focus trap — it's a drawer, not a modal).
- Drag has the required non-drag equivalent: Enter-to-add + the Add-node flow's placement (§3) fully covers pointerless add.

### (9) Accessibility
- Panel: `role="complementary"` `aria-label="Add a step"`; search box `role="searchbox"` `aria-label="Search steps to add"`.
- Sections: `role="group"` with an `<h3>` header carrying `aria-expanded`; item grid `role="listbox"`/items `role="option"` (single active-descendant model so screen readers announce "Send email, Gmail. Sends an email through the company's Gmail connection. Adds a step.").
- Each card's `aria-label` = user-side title + blurb + requirement/highRisk state, e.g. *"Schedule a post, Postiz. Pauses for approval before it publishes. Adds a step."* — never node ids or `TOOL_ACTION`.
- `requires`-unmet cards use `aria-disabled="true"` + the reason in the accessible name, never color-only.
- SR-add announcement reuses the same inline string shown visually ("Added Emma") via the shared `aria-live="polite"` region (Spine §6.3) — no separate SR copy.

### (10) Loading state
- Reuse the Spine skeleton pattern (never spinner-only): while `['workflow-nodes']`/employees/skills resolve, show **section headers + 3 shimmer item-rows per section** (`aria-busy="true"`). The node-types query has staleTime 5min so it typically paints instantly from cache; employees/skills may lag → those two sections shimmer independently while the static sections (Logic/Data/Timing/Knowledge/Memory/Triggers) render immediately from `labels.ts`.
- Past a threshold (installed-skill tools > 40, or a large tenant), the item grid **virtualizes** (Ground A §e) — skeletons only for the visible window.

### (11) Error state
Consume `NormalizedApiError`; errors are inline, never a dead panel, never apologetic (Spine §6.6):
- Employees fetch fails → the AI Employees section shows *"Couldn't load your employees. Retry."* with a Retry button; the rest of the palette still works.
- Skills fetch fails → Skills section shows *"Couldn't load your connections. Retry."*
- `node-types` fails (rare, cached) → falls back to the static 19-from-`labels.ts` with a quiet top strip *"Showing the standard steps — couldn't confirm your setup."*
- **429** on any → *"Give it a moment — too many requests just now."* with a retry-after countdown; no full-panel error.

### (12) Disabled state
- **Whole panel disabled** in Watch/Locked mode: not rendered (canvas is read-only) — the `‹` affordance is absent; if reached programmatically, add is a no-op.
- **Per-card disabled** with a reason (never bare):
  - Skill tool whose connector is `DISCONNECTED` → disabled, tooltip *"Reconnect Gmail to use this."* (deep-link to `/skills`). `DEGRADED` → **enabled** but a small amber dot + tooltip *"Gmail is having issues right now."* (the run-time handler quarantines; authoring is allowed).
  - Employee-role section with no hires → the type card is replaced by the enabled ghost CTA card, not a disabled real card.
  - `TRIGGER` cards: if the workflow already has a TRIGGER (single-trigger rule), all four Trigger cards disable with tooltip *"A workflow has exactly one start. Change it in the trigger settings."* (routes to `TriggerInspector`).
  - highRisk Skill cards are **never** disabled for being highRisk — they add with the permanent "Pauses for approval 🔴" badge; disabling them would hide the safety story.

---

# 2. NODE SEARCH / COMMAND PALETTE — `CommandPalette`

### (1) Purpose
A `⌘K`-style fuzzy finder over **addable nodes + builder actions**, keyboard-first, that drops a step **at the cursor / current insertion context** without leaving the keyboard. It is the fast path; the Library (§1) is the browse path. They share the same `PaletteItem` catalogue and recents ring, so a step found here and a step dragged there are identical.

### (2) States
- **Closed** (default).
- **Open — empty query**: shows **Recent** (last-added items), then **Suggested next** (context-aware: if a node is selected or an edge/port armed, the items valid to follow it float to the top), then actions.
- **Open — typing**: fuzzy results grouped by section, best match highlighted (active descendant), match spans highlighted in `violet-secondary`.
- **Open — no results**: empty invitation (see 11/empty).
- **Loading** (first open before catalogue cached), **Error**, **Disabled result rows**.
- **Executing**: an item/action chosen → palette closes, add/placement runs.

### (3) Interactions
- Open with `⌘K` / `Ctrl K` (also the Library's search entry and the Toolbar `⌘K Add step` button both open **this**).
- Type → debounced (60ms) fuzzy match across `title + keywords + section` (client-side; e.g. `matchSorter`/local scorer over the memoized catalogue — no network per keystroke).
- `↓`/`↑` move the active row across groups; `Enter` = add-at-cursor (or run action); `⌘Enter` = add **and keep palette open** (rapid multi-add); `Esc` closes.
- **Two-step for branching context**: if the armed context is a CONDITION/SWITCH port, after choosing a node the palette asks *"On which path?"* (Yes / No / case list) before wiring — inline second step, no modal.
- **Result rows** carry the same requirement/highRisk affordances as Library cards; an unmet-requirement row is selectable but, on Enter, expands an inline note *"Hire a Marketing employee first — open Employees"* instead of adding.
- Actions (not just nodes) are searchable: **Tidy layout**, **Zoom to fit**, **Publish**, **Test run**, **Open Outline**, **Templates…**, **Generate with AI…** — each a row with its shortcut glyph on the right.

### (4) Props (typed shape)
```
type CommandPaletteProps = {
  open: boolean;
  workflowId: string;
  items: PaletteItem[];                    // the shared catalogue from useNodePalette()
  actions: CommandAction[];                // builder actions (tidy/publish/test/outline/templates/generate)
  addContext: AddContext;                  // always present — defaults to { via:'cursor', position: viewportCenter }
  recents: string[];                       // itemIds, from the recents ring
  onAdd: (item: PaletteItem, at: XYPosition, branch?: string) => void;
  onRunAction: (action: CommandAction) => void;
  onClose: () => void;
};
type CommandAction = { actionId: string; label: string; icon: LucideIconName; shortcut?: string; disabledReason?: string };
```

### (5) Data requirements
Same three live sources as §1 (shared `useNodePalette()` — no second fetch), plus the client-only recents ring and the static `actions` list. Fuzzy index is derived in-memory from `items` (memoized on `items` identity).

### (6) API dependencies (exact method + path)
None of its own — it reuses `GET /workflows/node-types`, `GET /employees`, `GET /skills` via the shared hook. Actions dispatch to existing mutations already owned by the Toolbar (`usePublishWorkflow`, `useRunWorkflow`, tidy is canvas-local). Search is entirely client-side.

### (7) Responsive behaviour
- **Desktop/Tablet**: centered overlay panel, 560px wide, top-anchored (~18vh from top), `surface-raised`, `elev-panel`, `z-modal` (it is a focus-trapped dialog). Backdrop scrim dims the canvas.
- **Mobile <768**: not offered (no editing on mobile). `⌘K` has no touch equivalent surfaced.

### (8) Keyboard behaviour
- `⌘K`/`Ctrl K` open/close toggle; opening focuses the input immediately.
- `↓`/`↑` navigate rows (wrap at ends); `Home`/`End` jump to first/last; `PageDn`/`PageUp` jump a group.
- `Enter` add-at-cursor & close; `⌘Enter` add & keep open; `Tab`/`Shift+Tab` do **not** leave the palette (trapped); `Esc` closes and returns focus to the previously focused canvas element.
- In the branch second-step, `↑/↓`+`Enter` pick the path; `Esc` steps back to the result list (not straight closed).
- Typing is never swallowed by canvas shortcuts (the palette is a dialog; canvas keymap is suspended while open).

### (9) Accessibility
- `role="dialog"` `aria-modal="true"` `aria-label="Add a step or run a command"`; focus-trapped (reuses the new `components/ui/Modal.tsx` trap primitive, Ground A §d).
- The input is a `combobox` (`aria-expanded`, `aria-controls` → the results `listbox`, `aria-activedescendant` → active row id). Results `role="listbox"`; rows `role="option"` with the same human `aria-label` as Library cards + shortcut read out for actions.
- Group headers use `aria-label`ed `role="group"`; match-highlight spans are purely visual (the accessible name is the full plain title).
- On add, the shared `aria-live="polite"` region announces *"Added Send email after Emma."* (reusing the visible inline string). No-results announces *"No steps match 'xyz'."*

### (10) Loading state
- If opened before the catalogue is cached: input is live immediately; the results area shows 4 shimmer rows (`aria-busy`) until `items` resolve, then populates. Because `['workflow-nodes']` has 5-min staleTime and employees/skills are usually warm from the Library, this is rarely seen; the static node + action rows render instantly regardless.

### (11) Error state
- If the catalogue partially failed (e.g. skills fetch errored), the palette still searches what loaded and shows a dim footer strip *"Some connections didn't load — results may be incomplete. Retry."* (Retry re-runs the failed query).
- Choosing an unmet-requirement row surfaces the exact plain-language miss inline (Spine §6.6 mapping): *"Hire a Marketing employee to use this."* / *"Install Gmail first."* — never a raw error.
- **No results** empty (an invitation, not a dead end): *"Nothing matches '{q}'. Try 'email', 'approval', or describe it and let AI draft it →"* where the arrow runs the **Generate with AI** action (plan-gated; if not BUSINESS/ENTERPRISE the row is disabled with *"Generating with AI is on Business and Enterprise plans."*).

### (12) Disabled state
- Whole palette unavailable in Watch/Locked/Mobile (add is meaningless) — `⌘K` is a no-op there, and the Toolbar `⌘K Add step` button is disabled with tooltip *"This workflow is read-only right now."*
- Individual rows disable with a reason exactly as Library cards (disconnected skill, single-trigger already present, unmet employee requirement). Action rows disable with their own reason (e.g. **Publish** disabled → *"Nothing new to publish"*; **Test run** always enabled in Edit).

---

# 3. ADD-NODE FLOW — `useAddNode` (interaction contract across four entry points)

Not a visible panel of its own; the shared placement + selection + inspector-open behaviour every add funnels through. Owned by `WorkflowCanvas` (holds node/edge state + undo). The Library and Command Palette emit intent; this flow commits it.

### (1) Purpose
Turn a chosen `PaletteItem` into a real node in the definition, place it sensibly, wire it if the context implies a connection, auto-select it, and open its Inspector — identically regardless of whether the add came from a **Library drag**, a **Library/Command click**, an **edge "+" insert-between**, or a **dangling-port drop**. It guarantees the Spine's "an action keeps its name through the flow" (card title → node title → inspector title).

### (2) States
- **idle**: no add in progress.
- **placing** (drag): a node preview tracks the cursor; valid drop targets (empty canvas / edge / port) highlight per Spine §5.3.
- **inserting-on-edge**: an edge shows a violet "+" affordance; drop/pick splits it.
- **connecting-from-port**: a dangling output handle is armed; the next add auto-connects (branch chosen first for CONDITION/SWITCH).
- **awaiting-branch**: (branching source only) the "On which path?" micro-step.
- **committing**: writing the node/edge into React Flow state (single undo entry), minting id, seeding config.
- **committed**: node auto-selected, Inspector open, inline *"Added {title}"* announced, autosave debounced.
- **rejected**: an invalid add (e.g. second TRIGGER, cycle) → snap-back + red inline reason.

### (3) Interactions (the four entry points)
- **Library drag → canvas**: drop position = cursor world-coords; node lands there; no auto-connect unless dropped on an edge/port.
- **Click-to-add (Library or Command)**: with no armed context, node lands at **viewport center offset to avoid overlap** (8px grid-snapped, nudged if it would cover an existing node); with armed context, uses that context's position.
- **Edge "+" insert-between**: hovering an edge reveals a `+` at its midpoint (also reachable via edge context-menu *"Insert step on this path…"*, Spine §4.3). Choosing a node **splits the edge**: original `A→B` becomes `A→new` + `new→B`, preserving any `branch` on the first hop; the new node is positioned at the old edge midpoint and neighbors are nudged to make room.
- **Dangling-port drop**: dragging from an output handle to empty canvas opens the Library in **next-step** mode filtered to valid followers and **auto-connects** on pick (Spine §2.5). For a CONDITION/SWITCH source, the branch is asked first (Yes/No/case), written as `edge.branch`.
- After any commit: node auto-selects (violet ring), Inspector opens focused on the first meaningful field (e.g. employee card → the instruction field), canvas pans minimally if the node is off-view.

### (4) Props (typed shape)
```
type UseAddNode = (args: {
  addItem: (item: PaletteItem, ctx?: AddContext, branch?: string) => AddResult;
}) => void;

type AddResult =
  | { ok: true; nodeId: string }
  | { ok: false; reason: string; code: 'SINGLE_TRIGGER' | 'CYCLE' | 'DUP_BRANCH' | 'READ_ONLY' };

type NewNode = {                     // what gets written into the definition
  id: string;                         // minted `${type_lower}_${base36rand}`, matches ^[A-Za-z0-9_-]{1,64}$
  type: NodeType;
  name?: string;                      // from item.seed.name (employee/tool) or label default
  config: Record<string, unknown>;    // item.seed.config (defaultConfig + card specifics)
  position: XYPosition;               // computed landing spot
};
```
TRIGGER cards additionally set workflow-level `triggerType`/`triggerConfig` via `useUpdateWorkflow` (not node config) — the flow branches to `TriggerInspector` rather than the generic Inspector.

### (5) Data requirements
- The chosen `PaletteItem` (carries `seed.config`, `nodeType`, `name`, `triggerType`).
- Current `{ nodes, edges }` (to compute placement, detect single-trigger, run the cycle check).
- For port/edge context: the source node id, the target branch, the world position.
- `defaultConfig(nodeType)` (or, for future `NodeDefinitionDto.default`, the registry default) to seed config; skill/employee cards additionally seed `{ skillKey, tool }` / `{ employeeId }`.

### (6) API dependencies (exact method + path)
- No dedicated add endpoint. The commit mutates local React Flow state, pushes one undo entry, and marks dirty → the existing **autosave**: `PUT /workflows/:id/draft { definition }` (debounced 800ms, Ground A §2.9).
- TRIGGER-type adds also call `PATCH /workflows/:id { triggerType, triggerConfig, expectedUpdatedAt }` (position-carrying save path) — with the 409 "Reload their version" handling.
- Validity (single-trigger, cycle, dup-branch) is enforced **client-side** at add time using the same rule set the server validator uses (`SINGLE_TRIGGER_REQUIRED`, `CYCLE_DETECTED` DFS ignoring edges into LOOP, duplicate-branch) so the user gets instant feedback; the server re-checks at publish (`POST /workflows/:id/publish` → 400 with `ValidationIssue[]`).

### (7) Responsive behaviour
- **Desktop**: full drag + click + edge-insert + port-drop.
- **Tablet**: click-to-add and edge-insert (`+` tap) are promoted; drag still works; the Inspector opens as a right overlay sheet after commit.
- **Mobile**: not available (no editing).

### (8) Keyboard behaviour
- Pointerless add is the required equivalent: choose in Library/Command with `Enter` → node lands at cursor/context.
- **Insert-between via keyboard**: focus an edge (Tab reaches edges only through the edge context-menu path — edges are otherwise `aria-hidden`; the `⋯`/`⇧F10` menu on the *source node* exposes "Insert step after…" as the keyboard route), pick target → split.
- **Connect-from-port via keyboard**: select source node → `C` enters connect mode → the target picker (topo-ordered) → `Enter` wires; branching sources ask branch first (Spine §2.5).
- After commit, focus moves into the Inspector's first field; `Esc` returns focus to the new node on the canvas.

### (9) Accessibility
- Every add path has a non-drag equivalent (load-bearing, Ground A §f.7).
- On commit, `aria-live="polite"` announces the human sentence: *"Added Emma, HR employee, after When a candidate emails."* / *"Added Send email on the No path."* — reusing the visible inline string.
- A rejected add announces via `aria-live="assertive"` (reserved for blocked actions, Spine §6.3): *"Can't add a second start — a workflow has exactly one start."* / *"That would loop back on itself. Only a Loop step can point backwards."*
- The new node receives focus (`role="group"`, `aria-roledescription="workflow step"`, human `aria-label`) so keyboard/SR users land on it immediately.

### (10) Loading state
- Add is optimistic and synchronous (local state) — no spinner. The autosave that follows shows the Toolbar pill `Saving… → Saved · just now` (Spine); the node is fully usable before the draft write resolves.
- If the catalogue item is still resolving its `requires` (e.g. skill status mid-fetch), the card was already gated in the panel — the flow never receives an unresolved item.

### (11) Error state
- **Invalid add** (single-trigger / cycle / dup-branch / read-only): snap-back, node not committed, red inline reason on the offending node/edge + `aria-live` string; no partial state.
- **Autosave 400** (structurally invalid draft after the add): non-blocking inline *"This step needs a bit more setup before it can be saved as a draft."* — the node stays on canvas (draft is a scratchpad; publish is the hard gate). The specific field error surfaces in the Inspector.
- **Autosave 409** (concurrent edit): inline *"Someone else saved changes. Reload their version to keep going."* + **Reload** action (refetch, replace canvas, **clear undo** — the add is lost and must be redone on their version); never silently overwrite.
- **TRIGGER add 403/plan/etc.** is not applicable (trigger change is owner/admin-gated at the route; a non-authorised user sees the Trigger cards disabled in the palette, §1/(12)).

### (12) Disabled state
- The flow is inert in Watch/Locked/Mobile (`addItem` returns `{ ok:false, code:'READ_ONLY' }` with reason *"This workflow is read-only right now."`).
- **Second TRIGGER** blocked (`SINGLE_TRIGGER`) with the single-start reason.
- **Insert-between disabled** on an edge out of a `TERMINATE` source (Stop has no next step) → the edge shows no `+`; keyboard route reports *"Stop is the end — it can't lead anywhere."*
- **Auto-connect disabled** into a TRIGGER's (nonexistent) input, into `TERMINATE`'s (nonexistent) output, or where it would duplicate a branch edge — the target dims during drag (Spine §5.3) and the keyboard picker omits it with a reason row.

---

## Cross-cutting notes for implementation
- **One source of truth**: `useNodePalette()` (composes `['workflow-nodes']` + `['employees']` + `['skills']` + `labels.ts`) feeds both `NodeLibrary` and `CommandPalette`; the recents ring is shared client-only state. Do not fetch twice.
- **Registry-driven, no `switch(NodeType)`** (Ground A §f.6): card visuals key off `PaletteItem.category`/`toneToken`; the fan-out map (Trigger×4, Employee×N, Tool×N, Transform×2, hide NOOP/NOTIFY/AI_STEP) is data + `labels.ts`, not a per-type switch.
- **Endpoint reconciliation the implementer must honour** (Ground C): palette source is `GET /workflows/node-types` → `{types}` (NOT `/workflow-nodes` + `NodeDefinitionDto`); it returns enum strings only, so config schema/handles come from `labels.ts`/`defaultConfig` until `@vaep/types` ships `NodeDefinitionDto`.
- **Signature discipline** (Spine): employee cards carry the portrait + role badge (the one boldness spend); every other palette item is a quiet tone-badge chip. highRisk Skill cards always show "Pauses for approval 🔴" in the palette itself, so the human-in-the-loop story is visible before the node is even added.


---

## 3.D — Node cards (every node type)

# ORLIXA V-AEP WORKFLOW BUILDER — NODE CARD SPECS

On-canvas visual representation for every node type. All cards are rendered by ONE registry-driven component (`WorkflowNodeCard`) that keys visuals off `NodeCategory` + registry flags (`handles.outputs`, `highRisk`, `pausesRun`) — never `switch(NodeType)` (ADR-003). This spec gives the per-category delta on top of a **Shared Card Contract** (defined once below, then referenced by section number). Every node section still declares all 12 attributes explicitly.

---

## 0. SHARED CARD CONTRACT (inherited by every node section — deltas only are restated per node)

**Shared props shape** (the registry hands this to `WorkflowNodeCard`; React Flow wraps it as `NodeProps<WorkflowNodeData>`):

```ts
type WorkflowNodeData = {
  nodeId: string;                       // ^[A-Za-z0-9_-]{1,64}$
  type: NodeType;                       // one of the 19
  category: NodeCategory;               // drives rail + badge + shape
  name?: string;                        // author-set node name (F2 rename)
  config: Record<string, unknown>;      // raw, unresolved
  def: NodeDefinitionDto;               // registry entry: label, icon, handles.outputs, flags
  // presentation-derived (computed by selectors, never in store):
  title: string;                        // human title (employee name / tool label / "Condition")
  subtitle: string;                     // one-line summary from config
  badges: NodeBadge[];                  // e.g. {kind:'pausesApproval'}, {kind:'testRun'}
  validity: { ok: boolean; issues: ValidationIssue[] };  // per-node publish issues
  runState?: StepRunView;               // present only in Watch mode; {status, error, attempt, startedAt, finishedAt}
  readOnly: boolean;                    // Watch/Locked mode
  disabled: boolean;                    // node explicitly disabled
};
type NodeBadge =
  | { kind: 'pausesApproval' }          // highRisk tool / APPROVAL
  | { kind: 'testRun' }                 // dry-run
  | { kind: 'invalid'; count: number }
  | { kind: 'version'; label: string };
```

**Shared card handlers (props):** `onSelect(nodeId, additive)`, `onOpenInspector(nodeId)`, `onContextMenu(nodeId, anchor)`, `onRename(nodeId, name)`, `onConnectStart(nodeId, handleId)`, `onNudge(nodeId, dx, dy)`, `onMenuAction(nodeId, action)`.

**(2) Shared states** — every card renders the 10 states from Spine §3.3 verbatim: `idle · hovered · selected · invalid · running · waiting-approval · succeeded · failed · disabled · dry-run`. Border/fill/shadow/extra-signal per that table; status is always **icon + color**, never color alone (Spine §4). Only `running` / `waiting` / `retrying` animate (`breathe`+`pulseDot`; `flow` on the incoming edge). Deltas per node are called out in each section.

**(3) Shared interactions** — click = select; Shift/⌘-click = additive; double-click or Enter = open Inspector; drag = move (8px grid snap, alignment guides); right-click **or** ⇧F10/Menu key = context menu (Spine Part 2 §4.2); F2 = inline rename; `C` = keyboard-connect mode; always-visible `⋯` button (top-right) opens the same menu as right-click; hover raises shadow + shows `grab` cursor. Drag a handle → compatible targets glow violet, invalid dim.

**(6) Shared API dependencies** — cards render from `workflow.definition` already in cache (`workflowKeys.detail(id)`); registry metadata from `GET /workflows/node-types` → `{types}` (`['workflow-nodes']`, staleTime 5min); Watch-mode run state from `GET /workflows/runs/:runId` (poll 1s while `isActive`), plus optional WS `run:{runId}`. No card fetches on its own beyond these. Node-specific reference data (employees/skills/secrets) is fetched **in the Inspector**, not the card — see per-node deltas.

**(7) Shared responsive** — Desktop: full card, interactive. Tablet: full card, interactive; `⋯` always visible (no hover reliance). Mobile: **read-only monitor** — card renders in the Outline/Timeline surrogate, not an editable canvas; tap = open read-only Inspector sheet; no drag/connect/resize.

**(8) Shared keyboard** — card is a focusable `role="group"` in Tab order (topological then id); Enter opens Inspector; ⇧F10/Menu opens `⋯`; Arrows nudge 8px, ⇧Arrows 1px, ⌘/Ctrl+Arrows 40px; Del/Backspace removes (branch-loss confirm); `C` connect; F2 rename. TRIGGER excludes Del/Duplicate (see §3).

**(9) Shared accessibility** — `role="group"`, `aria-roledescription="workflow step"`, `aria-label` = **human title + state** (never node id / never `AI_EMPLOYEE_STEP`), e.g. *"Emma, HR employee, reviews the application. Running."* Handles are `aria-hidden` (connectivity lives in the Outline `role="tree"`, Spine Part 2 §6.2). `⋯` is a real `<button aria-haspopup="menu">`. Selection reflected as `aria-selected`. Invalid nodes set `aria-invalid="true"` and reference the issue via `aria-describedby`. Run transitions announced through the single `aria-live="polite"` region (reuses the visible inline string).

**(10) Shared loading** — during canvas load, the card renders as a **dim skeleton** at its dagre-estimated position (no spinner): 32px badge shimmer + 2 text-line shimmers, `aria-busy="true"`, non-interactive. Registry not yet resolved → badge/icon fall back to the category tone + `nodeTone()`/category label until `['workflow-nodes']` settles.

**(11) Shared error** — two error surfaces: (a) **authoring/validation** → `invalid` state, red dashed ring + `⚠ {count}` badge, offending field underlined in Inspector, issue text from the `ValidationIssue` code map (Spine Part 2 §6.6). (b) **run failure** (Watch) → `failed` state, red `x-circle` status dot + one-shot 120ms shake + first line of `step.error` in the subtitle slot ("preview / not sent" suppressed). `outcomeUnknown` attempt → `status-timeout` color + `help-circle` + *"outcome unknown — a person should check,"* never a plain failure.

**(12) Shared disabled** — 45% opacity, `border-hairline`, no active handles, `not-allowed` cursor, removed from Tab order, `aria-disabled="true"`; `⋯` still reachable but destructive/connect items disabled with reason tooltips.

**Shared ports/handles** — 10px dots, top-center = input, bottom-center = output(s); `edge-idle` ring at rest → `violet` when connectable/hovered; 14px hit-target. **No `error` port on any node — the engine has none.** Output handles come from `def.handles.outputs`; branch handles carry a `mono-xs` label pill.

---

## 1. AI EMPLOYEE NODE — `AI_EMPLOYEE_STEP` (THE SIGNATURE CARD)

The one node rendered as a **person**, not an instrument. This is the boldness spend; everything else stays quiet so this reads.

**(1) Purpose** — Delegate a unit of thinking work to a hired AI Employee: *"Assign this to Emma."* The card must read as a colleague doing a task, not "call an LLM." It shows who, what they're doing, what they can reach for, and whether a hand-off inside will pause for a human.

**At-a-glance info shown:**
- **40px circular portrait avatar** (employee photo, else initials on a role-tinted disc) — top-left, the anchor.
- **Title = employee name** in Space Grotesk `node-title`: e.g. `Emma`.
- **Role badge pill** next to the name: `HR` (violet-secondary) or `Marketing` (see §2).
- **Subtitle = instruction preview**, one line, truncated: *"Score the CV against the role criteria and recommend…"* (from `config.instruction`, first ~64 chars).
- **Skills/tool-budget hint chip** (`caption`, muted): `up to 3 actions` (from `config.maxToolCalls`, default 3, cap 10) — framed as "how many things Emma can do," not "maxToolCalls."
- **`outputKey` chip** (mono, if set): `→ {{screening}}` — "names the result."
- **`Pauses for approval 🔴` badge** — shown when the registry/inspector determines a downstream tool the employee may call is highRisk, OR when this node itself can pause at the G25 gate. Copy on hover: *"A step inside can pause and ask you to approve before it acts."*

**(2) States** — Shared §0(2), with signature deltas: the card is a **person-card** (`radius-lg` 16, width 240px, taller header, faint violet top-glow `rgba(139,110,242,0.06)`, `cat-employee` 3px left rail). `running` → avatar ring pulses `breathe` violet + status dot `loader`; live-region: *"Emma is reviewing the application."* `waiting-approval` (its own tool hit the gate) → gold ring on the card + `shield-alert` dot + chip *"Waiting on <approver>"* (steady, not animated). `failed` → red top-wash, avatar desaturates. `dry-run` → `Test run` badge; instruction preview unchanged (no side effect to preview here).

**(3) Interactions** — Shared §0(3). Rename (F2) edits the node `name` overlay but the **displayed title stays the employee's real name** (name override shows as a subtitle eyebrow only). `⋯` → Open, Rename, Connect to…, Duplicate, Copy/Cut, Test from here, Remove. No "Turn into…" to a bare `AI_STEP` (legacy, never offered as a target).

**(4) Props** — Shared `WorkflowNodeData` with `type:'AI_EMPLOYEE_STEP'`, `category:'AI_EMPLOYEE'`, and a derived `employeeView`:
```ts
employeeView?: {                        // resolved by an Inspector-side selector, cached
  employeeId: string; name: string; role: 'HR' | 'MARKETING';
  avatarUrl?: string; initials: string;
  instructionPreview: string; maxToolCalls: number; outputKey?: string;
  willPauseForApproval: boolean;        // any bound/likely tool highRisk OR gate-eligible
  employeeMissing?: boolean;            // employeeId no longer resolves → invalid
};
```

**(5) Data requirements** — `config { employeeId (template), instruction (template), maxToolCalls? }`. The card needs the employee's display identity (name/role/avatar). The card reads these from a lightweight `employeeView` populated once from the employee list; it does **not** itself fetch per-render.

**(6) API dependencies** — Shared §0(6). Employee identity resolution: `GET /employees` (list, cached under `['employees']`), filtered to the node role (see §2). Registry flags from `GET /workflows/node-types`. highRisk determination is Inspector-side (`SkillCatalog.getTool(skillKey,tool)?.highRisk`) but the resulting `willPauseForApproval` is passed to the card as a badge.

**(7) Responsive** — Desktop/tablet: full 240px person-card. Mobile monitor: avatar + name + role + status only; instruction/skills hint collapse to a "Details" disclosure in the read-only sheet.

**(8) Keyboard** — Shared §0(8). Enter opens the Inspector focused on the "What should Emma do?" instruction field.

**(9) Accessibility** — `aria-label` = *"{name}, {role} employee, {instructionPreview}. {stateSentence}."* Avatar `img` has `alt=""` (decorative; name is in the label). Role badge text is real text, not color-only. `willPauseForApproval` badge announced in the label: *"Pauses for your approval before it acts."*

**(10) Loading** — Skeleton uses a **circular** avatar shimmer (distinct from instrument cards' square badge) so the person-card silhouette is recognizable even while loading.

**(11) Error** — `employeeMissing` (bound employee unhired/deleted) → `invalid`, avatar becomes a dashed `user-round` placeholder, subtitle: *"This employee isn't hired anymore — pick another."* (`INVALID_CONFIG` employeeId). Run failure → Shared §0(11).

**(12) Disabled** — Shared §0(12); avatar and role badge desaturate to greyscale so a disabled colleague reads as "off duty."

**Ports:** 1 input (top), 1 output `main` (bottom). No branches. Can pause the run (resume-at-self) when a tool call hits the approval gate.

---

### 1b. LEGACY `AI_STEP` — the simpler "AI drafting" card

**(1) Purpose** — A bare LLM completion (no tools, no colleague identity): "draft this text." Legacy; **not offered as a new palette card** (Ground E §b) — it only appears when an old workflow already contains it.

**At-a-glance:** category `AI_EMPLOYEE` rail but **no portrait** — a `sparkles`/`pen-line` tone-badge instead (32px, violet-secondary). Title = node `name` or *"AI drafting"*. Subtitle = `config.prompt` preview. Chips: `→ {{outputKey}}`; a small muted `Legacy` pill.

**(2) States / (3) Interactions / (8)/(9)/(10)/(11)/(12)** — Shared §0. Distinct from `AI_EMPLOYEE_STEP`: no avatar, no role badge, no highRisk pause badge (bare completion never calls a tool), enforces the employee's monthly `budgetLimit` at run time (surfaced only on `BUDGET_EXCEEDED` failure copy: *"This drafting step hit the monthly budget."*).

**(4) Props** — Shared; `type:'AI_STEP'`; config `{ prompt (template), employeeId?, outputKey }`. No `employeeView`.
**(5)/(6) Data/API** — reads config only; no employee-identity fetch required (employeeId optional, used for budget). `⋯` offers **"Turn into an AI Employee step…"** (upgrade path) when an employee of a matching role exists.
**(7) Responsive** — as Shared. **Ports:** 1 in, 1 out `main`; no pause, no branch.

---

## 2. ROLE ADAPTATION — HR vs MARKETING (same node type, different colleague)

`AI_EMPLOYEE_STEP` is one engine type; the card adapts entirely off the **bound employee's `role`**. Nothing about the shape changes — only identity, badge color, and copy vernacular.

**Shared rule:** the employee picker in the Inspector is **filtered by role** (an HR node offers only `role:'HR'` employees; a Marketing node only `role:'MARKETING'`) and **never offers a `CUSTOM` employee** (would mis-scope knowledge retrieval — Ground E §b). Marketing Employee card stays **hidden in the palette until G10** (`EmployeeRole.MARKETING` ships); until then the role badge/avatar only ever renders `HR`. Do not fall back to `CUSTOM`.

**HR employee card:**
- Role badge `HR`, `cat-employee` violet-secondary.
- Avatar example: *Emma*.
- Verbs in subtitle/aria: *"reviews the application," "scores the candidate (and shows her reasons)," "drafts the review — she never scores a person."*
- Example instruction preview: *"Score the CV against the role criteria… never consider age, gender, nationality or photo. Recommend only."*
- Tone: careful, protective. Empty/first-run copy nearby: *"No candidates yet. Emma will pick up the next application that lands in careers@."*

**Marketing employee card:**
- Role badge `Marketing`, same `cat-employee` accent but badge copy `Marketing`.
- Avatar example: *Marcus*.
- Verbs: *"drafts the campaign plan," "writes the posts (in your brand voice, only claims from your knowledge base)," "watches performance and flags anything odd — he never changes spend."*
- Example instruction preview: *"Draft 3 posts in our brand voice; only use claims from the knowledge base."*
- Tone: brand-proud, blast-radius aware. Marketing nodes are the most common carriers of the highRisk downstream tool, so the `Pauses for approval 🔴` badge appears here most often (see §5, §6).

**Never render anywhere on either card:** "LLM step," "agent," "model," "prompt," `approverRuleType`, `highRisk`, `postiz schedule_post`, `recipient_count`. The card speaks in colleague terms only.

---

## 3. TRIGGER NODE — `TRIGGER` (the single entry, 4 firing modes)

One engine type; the firing mode lives on `Workflow.triggerType`/`triggerConfig` (NOT node config — node config is `{}`). The card is the **only capsule** on the canvas and the **only node with no input port**.

**(1) Purpose** — Show where and when the workflow starts, in the real-world moment ("When a candidate emails"), and let the author pick the firing mode + its scope.

**At-a-glance info shown** (by `triggerType`):
- **Shape:** pill / lozenge (`radius-pill`), 200px, cyan `cat-trigger` rail, **no top port**, one `main` bottom out.
- **Eyebrow:** `caption` uppercase `WHEN…`.
- **Title + icon per mode:**
  - `EVENT` → `mouse-pointer-click` / `webhook`(inbound) → *"When a candidate emails"* / *"When a lead comes in"* / *"When content is approved"*.
  - `SCHEDULE` → `calendar` → *"On a schedule"* + a readable cadence chip: `Every day 9:00`, `Every Monday`, `Hourly`.
  - `WEBHOOK` → `webhook` → *"When a form is submitted"* + a masked token chip `…/webhooks/••••` (never the full token on canvas).
  - `MANUAL` → `mouse-pointer-click` → *"When someone starts it."*
- **Connector-scope chip (EVENT only):** `via Gmail (careers@)` from `triggerConfig.connectorId` — "which connection's events fire this." Absent = *"any connection"* with a subtle warn dot if a second Gmail-EVENT workflow is active on the same connector (Ground E §f).
- **Event-condition hint (EVENT):** a `mono-xs` one-liner of the match, e.g. `event.type == "email.received"` — surfaced as *"Fires on: new email"*, with the raw DSL shown in the TriggerInspector, not spelled out on the card.

**(2) States** — Shared §0(2) minus `running` looping distinction: at run start the trigger flips straight to `succeeded` (`check-circle`) since it only seeds `context.trigger`. `invalid` covers `TRIGGER_NOT_ENTRY` (has an inbound edge) and `SINGLE_TRIGGER_REQUIRED` (a second trigger) → red ring + *"A workflow has exactly one start."*

**(3) Interactions** — Shared §0(3) **except**: **Duplicate and Remove are disabled** (tooltip *"A workflow has exactly one start."*); Del suppressed. `⋯` → Open (edits trigger mode in `TriggerInspector`), Rename, Connect to…, Tidy-relevant items. Clicking opens the **hand-built `TriggerInspector`** (the one Inspector exception), editing workflow-level `triggerType`/`triggerConfig`, not node `config`.

**(4) Props** — Shared; `type:'TRIGGER'`, `category:'TRIGGER'`; plus a derived `triggerView`:
```ts
triggerView: {
  triggerType: 'MANUAL'|'SCHEDULE'|'WEBHOOK'|'EVENT';
  cadenceLabel?: string;        // SCHEDULE
  eventLabel?: string;          // EVENT ("new email")
  connectorLabel?: string;      // EVENT connectorId → "Gmail (careers@)"
  webhookTokenMasked?: string;  // WEBHOOK
  activated: boolean;           // Workflow.activatedAt != null
};
```

**(5) Data requirements** — `Workflow.triggerType`, `triggerConfig`, `webhookToken` (masked), `activatedAt` from the cached `WorkflowDto`. Connector label resolves from `GET /skills` (installed connectors).

**(6) API dependencies** — Shared §0(6); `WorkflowDto` already in `workflowKeys.detail(id)`. Activate/Deactivate happen from the **Toolbar** (`POST /workflows/:id/activate` / `/deactivate`), not the card — but the card reflects `activated` with a small green/grey dot. Connector list: `GET /skills`.

**(7) Responsive** — Desktop/tablet full; mobile monitor shows mode + cadence/connector read-only. **(8) Keyboard** — Shared; Del disabled; Enter opens `TriggerInspector`. **(9) Accessibility** — `aria-roledescription="workflow start"`; `aria-label` = *"Starts {when}. {activated ? 'Active' : 'Not active'}."* No input handle → Outline shows it as the tree root.

**(10) Loading** — capsule skeleton with a single line (mode unknown → generic *"When this starts"* until `WorkflowDto` resolves). **(11) Error** — invalid entry/duplicate as above; SCHEDULE/EVENT bad config → `invalid` + *"This schedule isn't set up yet"* / *"Pick what event starts this."* (mapped from the 400 on activate). **(12) Disabled** — a paused workflow greys the activated dot but the trigger card stays legible (not opacity-45 unless the whole canvas is Locked).

**Ports:** 0 input, 1 output `main`. No branch, no pause, no loop.

---

## 4. LOGIC / CONTROL-FLOW NODES

The quiet machinery. All `cat-logic` slate (Data uses `cat-data` muted slate) — deliberately under-designed so the employee cards carry the eye. Branch handles + labels come from `def.handles.outputs`; **no error port**.

### 4a. `CONDITION` — "Condition / If"
- **(1) Purpose:** split the path on a yes/no test. **Shape:** 45°-rotated diamond (`rotate-45 rounded-xl`, content counter-rotated upright), slate rail, `git-branch` badge.
- **At-a-glance:** title *"Condition"*; subtitle = the test in plain terms: `{{screening.score}} greater than 7` (from `config {left,op,right}`, op ∈ `eq|neq|contains|gt|lt` rendered as `is / is not / contains / greater than / less than`).
- **Ports:** 1 input (top), **2 outputs**: `Yes` (violet-secondary label pill, `branch:'true'`) and `No` (slate pill, `branch:'false'`), fanned to distinct x-offsets.
- **(2) States:** Shared; `invalid` if a branch edge is missing (`MISSING_BRANCH_EDGE`) → dashed `⚠` stub on the empty handle + *"Say what happens on Yes and on No."* Duplicate branch edge → snap-back copy *"Yes already goes somewhere. Re-point the existing one instead."* `running` briefly, then the taken edge highlights.
- **(3)–(12):** Shared §0. Inspector: op `SelectField`; `gt`/`lt` note *"Both sides must be numbers"* (engine throws on non-numeric). **(4) Props:** config `{left,op,right}`. **(9) a11y:** `aria-label` = *"Condition: {left} {op} {right}. Two paths: Yes and No."*; Outline shows the two labelled children.

### 4b. `SWITCH` — "Switch"
- **Purpose:** route to one of several named paths. **Shape:** wider diamond variant, `split` badge, slate.
- **At-a-glance:** subtitle = `on {{plan}}`; a chip list of case labels `enterprise · smb · default`.
- **Ports:** 1 input, **N outputs** — one pill per author-named case (`branch:'<case label>'`) + a `default` pill, labels straight from `def.handles.outputs`, never hardcoded.
- **States:** `invalid` on `SWITCH_NO_CASES` → *"Add at least one case to match on."* Case handle context menu → **Rename branch** (edits `cases[].branch`). **Props:** config `{on, cases:[{value,branch}], default?}`. a11y label enumerates cases: *"Switch on {on}. Paths: enterprise, smb, default."*

### 4c. `PARALLEL` — "Split" (display alias)
- **Purpose:** run several lanes (sequentially under the hood — no wall-clock speedup, don't imply parallelism in copy). **Shape:** compact `radius-node` (168px), slate, `split` badge.
- **At-a-glance:** subtitle *"Splits into {n} lanes → meets at {joinName}"*. Lanes/join are **config refs** (`lanes[]`, `joinNodeId`), **not edges** — the card shows them as chips, and draws only the `main` outgoing edge.
- **Ports:** 1 input, 1 `main` output. Lanes and join are NOT ports.
- **States:** `invalid` on `UNJOINED_PARALLEL`/`PARALLEL_NO_LANES`/`UNKNOWN_LANE_START`/`NESTED_PARALLEL` → e.g. *"This Split has to meet back at a Merge."* Watch: `WorkflowJoinState` "3 of 3 branches arrived" surfaced on the paired JOIN, not here.

### 4d. `JOIN` — "Merge" (display alias)
- **Purpose:** the convergence point where lanes meet. **Shape:** compact, `git-merge` badge, slate.
- **At-a-glance:** subtitle *"Waits for all lanes, then continues"*; `mode` chip `all` / `any`. `laneOutputKey` chip `→ {{__lanes}}` if set.
- **Ports:** N inputs (converged), 1 `main` output. Watch: shows arrived/expected count from `WorkflowJoinState.{arrived,expected}` — *"2 of 3 arrived."*

### 4e. `LOOP` — "Loop / For each"
- **Purpose:** repeat a body over a list, bounded. **Shape:** compact, `repeat` badge, slate.
- **At-a-glance:** subtitle *"For each {item} in {{candidates}} — up to {maxIterations}×"*. A **back-edge** to the body renders as a distinct slate **dashed** curve looping to the left with a `repeat` glyph at the apex (Spine §5.5), visually separating "go back and iterate" from forward flow.
- **Ports:** 1 input, outputs `body` (into the loop) + `done` (after). Iterations are ONE node on canvas even for 10k iterations (detail lives in the windowed Timeline).
- **States:** `invalid` on `UNBOUNDED_LOOP` → *"This loop needs a limit — set how many times it can repeat."*; `INVALID_CONFIG` if `body`/`over` missing. **Placement:** an APPROVAL inside a LOOP body is `INCOMPATIBLE_PLACEMENT` — surfaced on the APPROVAL node, and the LOOP shows a companion warn.
- **Props:** config `{over (bare path), itemVar, maxIterations, body, done?}`.

### 4f. `TERMINATE` — "Stop"
- **Purpose:** end the run here. **Shape:** compact, `octagon-x` badge, slate.
- **At-a-glance:** subtitle *"Ends the run — {status}"* (`COMPLETED`/`FAILED`) + optional `reason`.
- **Ports:** 1 input, **NO output handle at all** (the only node with none). Any outgoing edge = `invalid` (`TERMINATE_HAS_OUTGOING_EDGE`) → *"Stop is the end — it can't lead anywhere."*
- **(9) a11y:** *"Stop. Ends the run as {status}."*; Outline renders it as a leaf.

### 4g. `NOOP` — internal only
- **Purpose:** placeholder / merge target. **Not surfaced in the palette** (Ground E §g) — appears only if present in an imported/generated graph. **Shape:** smallest compact chip, dim slate `circle` badge, subtitle *"Does nothing (placeholder)."* Ports: 1 in, 1 out. Fully quiet.

### 4h. `SET_VARIABLE` — "Set value" (Data, `cat-data`)
- **Purpose:** name a value for later steps. **Shape:** **compact chip** (`radius-btn`, 44px tall — the smallest, quietest card), muted-slate rail, `variable` badge, mono inline.
- **At-a-glance:** `set {name} = {value}` in mono; a scope chip if not RUNTIME (`workflow` / `output`). Reads as plumbing you skim past.
- **Ports:** 1 in, 1 out. **States:** `invalid` on `INVALID_CONFIG` (missing name) or `READ_ONLY_SCOPE` (SECRET/ENVIRONMENT/INPUT/GLOBAL) → *"That kind of value can't be set here."* Props: `{name, value, type?, scope?}`.

### 4i. `TRANSFORM` — "Transform / Filter" (Data, `cat-data`)
- **Purpose:** reshape a value with a closed op set (no eval, ever). **Shape:** compact chip, `filter` badge (when `operations[0].op==='filter'` the palette calls it **Filter**), else `variable`.
- **At-a-glance:** `{{leads}} → filter → map` — a mono chain of the op names.
- **Ports:** 1 in, 1 out. Props: `{input (bare path keeps arrays), operations:[{op,...}]}` with `op ∈ jsonPath|map|filter|join|split|toNumber|toString|default`. **Turn into…** toggles the Filter/Transform framing without touching config.

**Shared for all Logic/Data (2)(3)(5)(6)(7)(8)(9)(10)(11)(12):** Shared §0. All are `readOnly`-safe in Watch; all announce via Outline with their branch children named; none carry a portrait; none show a highRisk badge. Loading skeleton = single mono line. Keyboard/context identical to Shared.

---

## 5. SKILL / TOOL NODE — `TOOL_ACTION` ("use <skill> to <tool>")

Where an action leaves the system — the employee's "hands." Teal `cat-tool` rail, standard 216px `radius-node`.

**(1) Purpose** — Do one real-world action through one installed skill tool: *"Send email (Gmail),"* *"Send a message (Slack),"* *"Schedule a post (Postiz)."* One palette card per installed `skillKey`+`tool`.

**At-a-glance info shown:**
- **Tone-badge = the skill glyph** (`mail` Gmail, `message-square` Slack, `calendar` Calendar, etc.), teal-tinted.
- **Title = the tool in plain terms:** *"Send email"* / *"Send a message"* / *"Schedule a post."*
- **Subtitle = skill + key arg preview:** `Gmail · to {{candidate.email}}` — a redacted, one-line args summary (never a secret value; secret args show `{{secrets.KEY}}` literally).
- **`Pauses for approval 🔴` badge** — **persistent and non-removable** when `SkillCatalog.getTool(skillKey,tool)?.highRisk` is true (`postiz.schedule_post`, `postiz.publish_now`). Copy: *"This step pauses and asks for approval before it publishes — even without an approval step in front of it. That's built in and can't be turned off."* For `mkt.social-schedule` / `mkt.social-publish` this badge is the **only** in-the-loop signal — never render these as unguarded.
- **`→ {{outputKey}}` chip** if set.
- **Employee attribution chip** (`config.employeeId`, optional): `as Marcus` — "acting as."

**(2) States** — Shared §0(2). `waiting-approval` is the signature moment for highRisk tools: gold ring + `shield-alert` + *"Waiting on {approver} to approve before it sends."* (steady). `dry-run` → `Test run` badge + subtitle suffix *"preview / not sent"* (no real provider call, no `SkillExecution`, G25 gate skipped). Connector DEGRADED/DISCONNECTED at run time → `failed` + *"{Skill} isn't connected right now."*

**(3) Interactions** — Shared §0(3). The highRisk badge is **not** a toggle — the Inspector has no approval switch for it by design; it shows the note above. Args edited in the Inspector `SchemaForm`; secret args use the **secret picker** over `GET /workflow-secrets?workflowId=` (writes `{{secrets.KEY}}`, value never fetched/rendered).

**(4) Props** — Shared; `type:'TOOL_ACTION'`, `category:'TOOL'`; plus:
```ts
toolView: {
  skillKey: string; tool: string;
  skillLabel: string; toolLabel: string; icon: string;
  argsPreview: string;            // redacted one-liner
  highRisk: boolean;              // → persistent pause badge
  outputKey?: string; actingEmployeeName?: string;
  connectorStatus?: 'CONNECTED'|'DEGRADED'|'DISCONNECTED';
};
```

**(5) Data requirements** — `config { skillKey, tool, args (each template), outputKey, employeeId? }`; the tool's `highRisk` flag and label/icon from the skill catalog; secret keys (not values) for secret args.

**(6) API dependencies** — Shared §0(6); installed skills/tools + highRisk + labels from `GET /skills` (catalog, cached `['skills']`); secret keys from `GET /workflow-secrets?workflowId=`. Actual executions (Watch) audited as `SkillExecution` rows joined by `runId` (surfaced in Timeline, not on the card beyond status).

**(7) Responsive** — full desktop/tablet; mobile monitor shows title + skill + status + pause badge, args collapsed. **(8) Keyboard** — Shared; Enter → Inspector on the args form. **(9) Accessibility** — `aria-label` = *"{toolLabel} with {skillLabel}. {highRisk ? 'Pauses for your approval before it acts.' : ''} {stateSentence}."* Pause badge is real text, not icon-only.

**(10) Loading** — square teal badge shimmer + 2 lines; highRisk unknown until `GET /skills` resolves → badge withheld rather than wrongly shown. **(11) Error** — invalid: missing `skillKey`/`tool`/`outputKey`, or `INLINE_SECRET_FORBIDDEN` if a raw secret is pasted into args → *"Don't paste a secret here — pick it from your saved connections."* Run failure → Shared §0(11); DEGRADED connector quarantine copy above. **(12) Disabled** — Shared; if the underlying skill is uninstalled, card shows `invalid` (*"Install {skill} first"*) rather than silently disabled.

**Ports:** 1 input, 1 output `main`. Pauses the whole run **before dispatch** when highRisk (engine loop, G25) — never move the gate into the handler.

---

## 6. APPROVAL NODE — `APPROVAL` (the human gate, signature safety seam)

Gold is used **nowhere else** except WAITING — gold means a human decides here. This node always sits **between** the employee's draft and the outward TOOL_ACTION; that adjacency is drawn deliberately (a subtle violet "sign-off" seam).

**(1) Purpose** — A named human signs off before the run continues: *"Recruiter reviews before the candidate hears anything."* Single-forward gate.

**At-a-glance info shown:**
- **Shape:** `radius-node` with a **top notch** (shield silhouette), **gold** `cat-approval` 2px rail (brighter than others), `shield-check` gold tone-badge.
- **Title = the gate's human name** (kept end-to-end): *"Recruiter reviews," "Manager approves," "Approve outreach," "Approve the post."*
- **Persistent caption:** *"Signed off by {approver}"* derived from routing:
  - `USER` → the person's name; `ROLE` → *"anyone with the {Role} role"*; `DEPARTMENT`/`TEAM` → the group name; `EMPLOYEE_MANAGER` → *"the employee's manager"*; `ANY_ADMIN` (or unrouted) → *"any admin."*
- **Multi-level hint:** if `routing.levels.length > 1` → chip *"{n} sign-offs"* (real sequence numbers, e.g. `Level 1 → 2`).
- **SLA / escalation hint:** if `slaMinutes` set → `caption` *"Due in {sla}"*; if an `escalationChain` exists → `arrow-up-circle` chip *"escalates if late."*
- **Reject reality, shown explicitly:** a small persistent line *"If rejected, the run stops."* — because **rejection is NOT an edge** (the engine fails the run). Do **not** draw approved/rejected/error ports.
- **Auto-gate note (if `autoApprove:true`):** chip *"Auto-approves (still logged)"* — the gate resolves immediately.

**(2) States** — Shared §0(2). `waiting-approval` is this node's defining live state: **gold ring, steady (not animated)**, `shield-alert` status dot, chip *"Waiting on {approver}"*, upstream edge solid gold. Watch side-panel sourced from the `ApprovalRequest`: who can decide (`assigneeUserId` / `approverRuleType`+`approverRuleValue`), `dueAt`, `escalationTier`, `description`, and **where it resumes** (`resumeNodeId` → *"resumes at {nextNodeName}"*). On decide: approved → `succeeded` (*"Recruiter approved. Continuing."*); rejected → the whole run flips `failed` and this node shows *"Rejected — run stopped."* `ESCALATED`/`EXPIRED`/`autoDecided` surfaced read-only per Spine §4 status table (`arrow-up-circle` / `clock-x`).

**(3) Interactions** — Shared §0(3). Inspector edits `config.message` (the exact reviewer prompt shown to the approver, verbatim) and the routing rule in **who-approves language** (never `approverRuleType`). The action name is the same string on node → inbox item → live-region toast ("Approve outreach" → "Outreach approved").

**(4) Props** — Shared; `type:'APPROVAL'`, `category:'APPROVAL'`; plus:
```ts
approvalView: {
  gateName: string;               // the through-line name
  message?: string;               // reviewer prompt, verbatim
  autoApprove: boolean;
  approverLabel: string;          // "Recruiter" / "any admin" / person name
  levelCount: number;             // multi-level
  slaMinutes?: number; hasEscalation: boolean;
  resumeNodeName?: string;        // where it continues
  // Watch-only, from ApprovalRequest:
  liveRequest?: {
    status: ApprovalStatus; dueAt?: string; escalationTier: number;
    autoDecided: boolean; escalatedToId?: string; canCurrentUserDecide: boolean;
  };
};
```

**(5) Data requirements** — `config { message?, autoApprove?, routing? }` (routing = `ApprovalRoutingConfig` with `levels[]`, `maxEscalations?`, `defaultOnTimeout?`). Watch state from the linked `ApprovalRequest` (routing/SLA/tier/decider).

**(6) API dependencies** — Shared §0(6). Routing target pickers in the Inspector: `GET /employees` (users), role/department/team sources as available. Watch/decide via the **approvals API** (there is no runs-resume route): list `GET /approvals?assignedToMe=true`, get `GET /approvals/:id`, history `GET /approvals/:id/history`, decide `POST /approvals/:id/{approve,reject,modify}`. The card reflects, it does not decide (decisions happen in the inbox/side-panel).

**(7) Responsive** — full desktop/tablet; **mobile is fully usable for approving** — a manager can see the WAITING approval and act from the approvals inbox (the one authoring-adjacent flow that stays mobile-usable). **(8) Keyboard** — Shared; when the current user can decide a WAITING approval, the `aria-live` escalates to `assertive`. **(9) Accessibility** — `aria-label` = *"{gateName}. Signed off by {approver}. {waiting ? 'Waiting on a person, resumes at {resumeNodeName}.' : ''}"*; the notch/shield is decorative, the "who approves" text is real. `INCOMPATIBLE_PLACEMENT` (inside a LOOP body) announced as invalid.

**(10) Loading** — gold-badge skeleton + 2 lines + a placeholder "Signed off by…" line until routing resolves. **(11) Error** — invalid on `INCOMPATIBLE_PLACEMENT` (APPROVAL inside LOOP) → *"An approval can't sit inside a loop."*; run reject → `failed` copy above; already-decided race (409) surfaced in inbox, not on card. **(12) Disabled** — Shared; `autoApprove:true` is not "disabled," it's the auto-chip state.

**Ports:** 1 input, **1 output (forward only = approved→continue)**. Reject is not an edge. Pauses the run (WAITING) unless `autoApprove`.

---

## 7. KNOWLEDGE NODE — `RETRIEVE` ("look it up in the knowledge base")

**(1) Purpose** — Ground the employee's work by searching the company knowledge base: *"Look up the role criteria."* Indigo `cat-knowledge` rail, standard `radius-node`, `search` badge.

**At-a-glance info shown:**
- Title *"Knowledge search."*
- Subtitle = the query in mono: `"role criteria for {{job.title}}"`.
- Chips: `top {k}` (default 5, max 50) — "how many results"; `→ {{criteria}}` outputKey.
- **Scope note:** *"Searches all company knowledge"* — because `RETRIEVE` is intentionally **NOT role-scoped** (unlike chat retrieval). This is a deliberate, load-bearing distinction the card must state so authors don't assume HR-only scoping.

**(2) States** — Shared §0(2); `running` → *"Looking it up."* No side effect, no pause, no branch, no dry-run divergence.

**(3) Interactions** — Shared §0(3); Inspector: query `textField` (template), `k` number, `outputKey`. **(4) Props** — Shared; `type:'RETRIEVE'`, `category:'KNOWLEDGE'`; config `{query (template), k?, outputKey}`. **(5)/(6) Data/API** — reads config only; no knowledge fetch on the card (results are a run-time output). Registry from `GET /workflows/node-types`.

**(7) Responsive** — Shared. **(8) Keyboard** — Shared; Enter → Inspector query field. **(9) Accessibility** — `aria-label` = *"Knowledge search: {query}. Returns up to {k} results across all company knowledge."* **(10) Loading** — indigo badge + mono-line shimmer. **(11) Error** — invalid if query empty → *"Say what to look up."* Run failure → Shared. **(12) Disabled** — Shared.

**Ports:** 1 input, 1 output `main`. No branch/pause/loop.

---

## 8. MEMORY NODES — `MEMORY_READ` ("Recall") / `MEMORY_WRITE` ("Remember")

Paired soft-violet `cat-memory` cards; standard `radius-node`. Both are per-employee and tenancy-checked.

### 8a. `MEMORY_READ` — "Recall"
- **(1) Purpose:** bring back what an employee remembers: *"Recall what Emma knows about this candidate."* `brain` badge.
- **At-a-glance:** title *"Recall for {employeeName}"*; subtitle = kind + limit: `facts · up to {limit}` (kind `FACT`/`SUMMARY`, default limit 10 max 50); `→ {{memory}}` chip. No side effect, no pause, no branch.
- **(4) Props:** config `{employeeId (template), kind?, limit?, outputKey?}`.

### 8b. `MEMORY_WRITE` — "Remember"
- **(1) Purpose:** save something for an employee to remember later: *"Remember this outcome for Marcus."* `bookmark-plus` badge.
- **At-a-glance:** title *"Remember for {employeeName}"*; subtitle = content preview + kind chip `fact`. This is a **side-effect** (`source:'RUN'`); `dry-run` shows `Test run` + *"preview / not saved."*
- **(4) Props:** config `{employeeId (template), content (template), kind?}`.

**Shared for both memory nodes (2)(3)(5)(6)(7)(8)(9)(10)(11)(12):**
- **(2) States:** Shared §0(2); WRITE gets the dry-run "not saved" delta; READ has none.
- **(3) Interactions:** Shared; Inspector employee picker is filtered/tenancy-scoped like §2 but **not** role-restricted (memory is per-employee, any role).
- **(5)/(6) Data/API:** config only on the card; employee display name from `GET /employees`; registry from `GET /workflows/node-types`.
- **(9) a11y:** READ → *"Recall {kind} for {employeeName}, up to {limit}."*; WRITE → *"Remember for {employeeName}: {contentPreview}. Saves a memory."*
- **(11) Error:** invalid on missing `employeeId` (both) or missing `content` (WRITE) → `INVALID_CONFIG`: *"Pick an employee"* / *"Say what to remember."*
- Ports (both): 1 input, 1 output `main`. No branch/pause/loop.

---

## Cross-cutting reminders honored by every card above

- **Registry-driven, never `switch(NodeType)`:** all shape/rail/badge/handle decisions key off `category` + `def.handles.outputs` + flags (`highRisk`, `pausesRun`).
- **No `error` port anywhere** — the engine routes only on `branch`; APPROVAL reject fails the run.
- **Only running/live states animate** (`breathe`/`pulseDot`/`flow`); selection, hover, validity are instant. `prefers-reduced-motion` already blanks these globally — each state still reads via icon + static color.
- **The signature spend is the person-card;** Logic/Data/Utility stay relentlessly quiet (compact chips, slate, mono) so the spend reads.
- **Copy stays user-side and keeps its name end-to-end** (node → inbox → live-region), sentence case, active voice; never `AI_EMPLOYEE_STEP`, `approverRuleType`, `highRisk`, `postiz.schedule_post`, `maxToolCalls`, or "prompt/LLM/agent/model" on any surface.


---

## 3.E — Inspector (config forms · param binding · approval routing · permissions)

# INSPECTOR CLUSTER — Component Specification
**Orlixa V-AEP Workflow Builder · right-dock panel that configures the selected node / edge / workflow**

This spec inherits the Design Spine verbatim: tokens (`surface-section` panel body, `space-5`/20px panel padding, `radius-xl`/24px panel, `elev-panel`), typography (`display-lg` titles Space Grotesk, `body`/`body-strong` Inter, `mono-sm` for literals/`{{templates}}`), the status-color + `cat-*` category system, motion (`dur-slow` 240ms `ease-out` slide-in only; nothing else animates in Edit mode), the shared loading = skeleton / error = inline text / empty = invitation patterns (§6.6), the `Modal` primitive, `window.confirm` for destructive confirms, and the single `aria-live="polite"` region reusing on-screen strings. **No new store slice** — the Inspector holds only local `selectedNodeId` + react-hook-form state and reports changes up via callbacks; the write path (draft autosave, `expectedUpdatedAt` concurrency) is owned by `WorkflowCanvas`, never by the Inspector.

Load-bearing ground truths this spec is coded against (not the aspirational docs):
- The palette route `GET /workflows/node-types` returns only `{ types: NodeType[] }` — **no server-side config schema / `NodeDefinitionDto` exists yet.** Therefore every node's field set is a **client-side field-spec registry** (`nodeFieldSpecs.ts`), not fetched. This is honest about the Wave-0 gap.
- Edges carry `{ from, to, branch? }` — a free `branch` string, **no ports, no `error` channel**. The EdgeInspector edits `branch`, never a port id.
- The definition is the 2-key `{ nodes, edges }` shape; node = `{ id, type, name?, config }`.
- Secret values are **never fetched or rendered** — the secret field writes the literal `{{secrets.KEY}}`.
- Approval routing lives in the APPROVAL node's `config.routing` (`ApprovalRoutingConfig`) and is persisted through the ordinary draft save — there is no routing endpoint.
- highRisk tools auto-pause with no toggle; the Inspector shows a fixed notice, never an on/off control.

---

## 0. Shared Inspector conventions (referenced by every component below)

**Dirty-state + save model (applies to §1–§11).** The Inspector is a *controlled reporter*. Every field commit calls one of two upward callbacks:
- `onConfigPatch(nodeId, partialConfig)` — node config edits (SchemaForm, pickers, routing).
- `onWorkflowPatch(partialWorkflow)` — workflow-level edits (name/description/trigger).
- `onEdgePatch(edgeId, { branch })` — edge label.

These mutate React Flow state / workflow draft in `WorkflowCanvas`, which:
1. marks the canvas dirty, pushing one undo entry per *committed* gesture (field blur, select change, toggle — not per keystroke),
2. debounces 800 ms → `PUT /workflows/:id/draft { definition }` (autosave; creates DRAFT first call). The Toolbar pill shows `Saving… → Saved · just now`. Structural-invalid draft → 400 → the Inspector surfaces per-field issues inline but does **not** block (a draft is a scratchpad).
3. Explicit `⌘S` / Toolbar **Save** uses `PATCH /workflows/:id { definition, expectedUpdatedAt, position }`; on **409** the canvas shows `"Someone else saved changes. Reload their version to keep going."` + Reload — the Inspector goes read-only until reload.

**Commit granularity.** Text/textarea fields commit `onBlur` and on `⌘Enter`; selects/toggles/pickers commit `onChange`. This keeps typing out of the undo stack and the autosave debounce.

**Validation, two layers.** (1) *Immediate* client zod per field (from `nodeFieldSpecs.ts`) → inline `text-red-400` message under the field, `aria-invalid`, red left-underline. (2) *Publish-time* server issues (`collectDefinitionIssues` codes) arrive as `ValidationIssue[]` keyed by `nodeId`; the Inspector renders them in a **"Fix before publishing"** summary strip at the top of the panel with the exact plain-language mapping from Design Spine §6.6 (e.g. `UNBOUNDED_LOOP` → *"This loop needs a limit — set how many times it can repeat."*). Client zod never invents codes the server doesn't enforce.

**Shared field renderers** (the SchemaForm renderer library, reused across node forms, routing, permissions): `TextField`, `TextAreaField` (with `ValueInserter`), `NumberField` (min/max/step), `SelectField`, `MultiSelectField`, `ToggleField`, `EmployeePicker`, `ConnectionPicker`, `ChannelPicker`, `KnowledgeCategoryPicker`, `SecretPicker`, `KeyValueArgsField`, `RuleBuilderField` (CONDITION), `CasesField` (SWITCH), `OperationsField` (TRANSFORM), `OutputKeyField`. Each uses the global `.field-modern` input class, `body-strong` labels, `subtitle` helper text.

**Panel geometry.** Desktop right-dock 360 px, `surface-section` body, `border-hairline` left border, `elev-panel`, header 56 px sticky (`display-lg` title + `⋯` + close `✕`). Scroll region below is `overflow-y-auto` with `space-5` padding and `space-4` field gaps.

---

## 1. `Inspector` — the contextual shell

1. **Purpose.** The single right-dock container that routes to the correct editor by selection: nothing selected → `WorkflowSettingsPanel`; one node → `NodeConfigForm` (or `TriggerInspector` for the TRIGGER node); one edge → `EdgeInspector`; ≥2 selected → `MultiSelectInspector`. Owns panel chrome, the publish-issue strip, the dirty/saved status line, and focus management.

2. **States.** `empty-workflow-settings` · `node` · `trigger-node` · `edge` · `multi` · `loading` (selection resolved but its config/deps still fetching) · `readonly` (Watch mode `?run=`, ARCHIVED/Locked, or 409-unresolved) · `error` (dependency fetch failed) · `dirty` (unsaved field since last autosave) · `saved`. Right-dock is present in Edit + Watch; hidden entirely on mobile in favour of the full-screen read-only sheet.

3. **Interactions.** Selection changes in canvas/Outline swap the body with a `dur-slow` 240 ms `ease-out` slide (reduced-motion → instant). Header `✕` or `Esc` deselects (→ `WorkflowSettingsPanel`). Header `⋯` mirrors the node context menu (Rename, Duplicate, Test from here, Remove). A "Fix before publishing" issue chip is clickable → focuses the offending field. Collapsible sections (`display-md` header + chevron) remember open/closed per session.

4. **Props (typed).**
```ts
interface InspectorProps {
  mode: 'edit' | 'watch' | 'locked';
  workflow: WorkflowDto;
  selection:
    | { kind: 'none' }
    | { kind: 'node'; nodeId: string }
    | { kind: 'edge'; edgeId: string }
    | { kind: 'multi'; nodeIds: string[]; edgeIds: string[] };
  nodes: WorkflowNode[]; edges: WorkflowEdge[];
  issuesByNode: Record<string, ValidationIssue[]>;   // from last publish/draft-validate
  saveState: 'idle' | 'saving' | 'saved' | 'error';
  lastSavedAt: string | null;
  onConfigPatch: (nodeId: string, patch: Record<string, unknown>) => void;
  onWorkflowPatch: (patch: Partial<Pick<WorkflowDto,'name'|'description'|'triggerType'|'triggerConfig'>>) => void;
  onEdgePatch: (edgeId: string, patch: { branch?: string }) => void;
  onNodeAction: (nodeId: string, action: 'rename'|'duplicate'|'testFrom'|'remove') => void;
  onClose: () => void;
}
interface ValidationIssue { nodeId: string; code: string; message: string }
```

5. **Data requirements.** The selected node/edge from props; per-selection deps are fetched by child components (employees, skills, secrets, variables, node output names). Nothing global here.

6. **API dependencies.** None directly. Children call: `GET /employees`, `GET /skills`, `GET /workflow-secrets?workflowId=:id`, `GET /workflow-variables?workflowId=:id`, `GET /workflows/:id/permissions`. Draft persistence is the canvas's `PUT /workflows/:id/draft`.

7. **Responsive.** Desktop ≥1280: fixed 360 px dock, opens on select. Tablet 768–1279: overlay sheet from right, 88 % width, scrim, dismiss on scrim tap/Esc. Mobile <768: full-screen sheet, **read-only** — fields render as labelled read values with a quiet note *"Editing workflows needs a larger screen."*; only the approvals action and value viewing remain.

8. **Keyboard.** Opens on `Enter` when a node is focused in canvas. `Esc` priority: close open popover/picker → close Inspector-to-deselect. `Tab` cycles header → issue strip → fields → footer in DOM order. Section headers are `button`s toggled by `Enter`/`Space`.

9. **Accessibility.** Panel `role="region"` `aria-label="Step settings"` (label swaps to *"Workflow settings"* / *"Connection settings"* / *"3 steps selected"*). On selection change, move focus to the panel heading and announce via the shared live region: *"Editing Emma (HR)."* / *"Editing the connection from CV attached? to Store CV."* Issue strip is `role="alert"` when it appears. Read-only mode sets `aria-readonly="true"` and every control `disabled` with the reason.

10. **Loading.** Header renders immediately with the selection's known name; body shows 3 field-shaped shimmer blocks (`radius-btn`, `surface-card`) while deps resolve; `aria-busy="true"`.

11. **Error.** Dependency fetch failure → inline, non-apologetic: *"Couldn't load the connections list. Retry."* with a Retry button (re-runs the failed query). A 409 during autosave flips the whole panel to `readonly` with the canvas-level *"Someone else saved changes. Reload their version to keep going."*

12. **Disabled.** Whole panel disabled in Watch/Locked. Individual field disabling is delegated to the child forms (e.g. Publish-only fields, absent approval toggle).

---

## 2. `WorkflowSettingsPanel` — nothing selected (workflow-level)

1. **Purpose.** The default panel when no node/edge is selected: edit workflow **name**, **description**, review **owner** and **status**, jump into the **trigger** (When… ), and open **Permissions** and **Approvals defaults**. This is the "who owns this and when does it start" home.

2. **States.** `idle` · `editing-name` · `editing-description` · `saving`/`saved` · `readonly` (Watch/Locked/mobile) · `activate-blocked` (no non-TRIGGER node yet).

3. **Interactions.** Name is an inline-editable `display-lg` field (click / `F2` to edit, `Enter` commits, `Esc` reverts). Description is a `TextAreaField`. A **"When this starts"** row summarises the current trigger (e.g. *"When a candidate emails · Gmail (careers@)"*) and, on click, selects the TRIGGER node → swaps to `TriggerInspector`. **Permissions** row shows *"Anyone in your company can run this"* (default) or *"Restricted — 3 people"* → opens `WorkflowPermissionsPanel` in a Modal. Read-only **Owner** and **Status** chips (`WORKFLOW_STATUS_STYLES`).

4. **Props (typed).**
```ts
interface WorkflowSettingsPanelProps {
  workflow: WorkflowDto;
  ownerName: string;              // resolved display name of creator
  nonTriggerNodeCount: number;    // gates Activate messaging
  runPermissionCount: number;     // RUN grants, drives the Permissions summary
  readOnly: boolean;
  onWorkflowPatch: (patch: Partial<Pick<WorkflowDto,'name'|'description'>>) => void;
  onOpenTrigger: () => void;      // selects the TRIGGER node
  onOpenPermissions: () => void;  // opens WorkflowPermissionsPanel modal
}
```

5. **Data requirements.** `workflow.{name,description,status,triggerType,triggerConfig,warnings}`; owner display name; count of RUN grants.

6. **API dependencies.** Reads from `useWorkflow(id)`. Writes via canvas `PUT /workflows/:id/draft` (name/description are part of `UpdateWorkflowDto`; committed through `PATCH /workflows/:id` on explicit Save). Permissions Modal owns its own `GET/POST/DELETE /workflows/:id/permissions`.

7. **Responsive.** Same dock/overlay/full-screen rules as §1. On mobile the trigger + permissions rows remain tappable (read-only display).

8. **Keyboard.** `F2` edits name; `Tab` order name → description → trigger row → permissions row. Rows are `button`s.

9. **Accessibility.** Name field `aria-label="Workflow name"`; trigger row `aria-label="When this starts. Currently: When a candidate emails."` announces on change. Status chip has `aria-label="Status: Draft"`.

10. **Loading.** Name/description skeleton lines; trigger/permission rows show placeholder text `Loading…`.

11. **Error.** Name save 400 (e.g. length >160) → *"Name needs to be 1–160 characters."* Blank name blocked with *"Give this workflow a name."*

12. **Disabled.** All fields disabled read-only in Watch/Locked. Name/description remain editable in Edit even for ACTIVE workflows (metadata, not graph). A quiet inline note when `nonTriggerNodeCount === 0`: *"Add at least one step before you can turn this on."* (mirrors the Activate precondition; the Activate button itself lives in the Toolbar).

---

## 3. `NodeConfigForm` (SchemaForm engine) + field-renderer library

1. **Purpose.** The single generic form that renders any node's config from a **client-side field spec** (`nodeFieldSpecs[node.type]: NodeFieldSpec[]`), because the backend ships only `{types}`. Registry-driven (ADR-003) — it never `switch(NodeType)`es for layout; it maps `NodeFieldSpec.kind` → renderer. The only hand-built exception in the whole Inspector is `TriggerInspector` (§4). Every node form shows: a header identity block (tone-badge/portrait + `node-title` name + category caption), the fields, an **"Names its result"** `OutputKeyField` where applicable, and any fixed notices (e.g. highRisk).

2. **States.** `idle` · `dirty` · `field-invalid` (client zod) · `publish-issue` (server code on this node) · `saving`/`saved` · `readonly` · `deps-loading` (picker options loading) · `deps-error`.

3. **Interactions.** Standard RHF: text commits on blur/`⌘Enter`, selects/toggles/pickers on change. `ValueInserter` `{ }` button on every template-capable field opens the insert-a-value popover (§8). Collapsible **"Advanced"** section hides low-frequency fields (e.g. `maxToolCalls`, `k`, `kind`). Each committed change calls `onConfigPatch(nodeId, patch)`.

4. **Props (typed).**
```ts
interface NodeConfigFormProps {
  node: WorkflowNode;
  spec: NodeFieldSpec[];                 // from nodeFieldSpecs[node.type]
  issues: ValidationIssue[];             // server codes for this node
  deps: InspectorDeps;                   // employees, skills, secrets, variables, upstreamOutputs
  readOnly: boolean;
  onConfigPatch: (nodeId: string, patch: Record<string, unknown>) => void;
}
type NodeFieldSpec =
  | { kind:'text'|'textarea'|'number'|'select'|'multiselect'|'toggle'|'outputKey'|'secret'
      |'employee'|'connection'|'channel'|'knowledge'|'rule'|'cases'|'operations'|'keyvalue';
      name: string; label: string; help?: string; placeholder?: string;
      required?: boolean; default?: unknown; template?: boolean;         // template=allow {{...}}
      min?: number; max?: number; step?: number;
      options?: {value:string;label:string}[]; roleFilter?: 'HR'|'MARKETING';
      advanced?: boolean; zod: ZodTypeAny; }
interface InspectorDeps {
  employees: EmployeeLite[]; skills: SkillLite[]; secretKeys: string[];
  variables: WorkflowVariableLite[]; upstreamOutputs: OutputRef[];
}
```

5. **Data requirements.** `node.config` current values; `spec` from the client registry; `deps` for pickers/inserter; `issues` for the publish strip.

6. **API dependencies.** Field-spec is local. Deps: `GET /employees`, `GET /skills`, `GET /workflow-secrets?workflowId=`, `GET /workflow-variables?workflowId=` (keys/metadata only). Persistence via canvas draft save. `GET /workflows/node-types` is consulted only to confirm the type is registered (unknown → `UNKNOWN_NODE_TYPE` publish issue).

7. **Responsive.** Fields stack single-column at all widths (360 px dock is already narrow). On tablet overlay the same layout; mobile read-only.

8. **Keyboard.** Standard tab order top→bottom; `⌘Enter` in any text field commits + blurs. `{ }` inserter opens with `Alt+/` when a template field is focused.

9. **Accessibility.** Each field label is a real `<label htmlFor>`; `aria-describedby` links help text and error; `aria-invalid` on client-invalid. Fieldset groups (rule/cases/operations) use `role="group"` + legend. Header identity announced by the Inspector region on select.

10. **Loading.** Pickers show inline skeleton option rows; text fields render immediately with current values (no block).

11. **Error.** Client zod → inline red under field. Server publish code → strip chip + red field underline. Picker dep error → the picker renders its own retry (see §7) without blocking sibling fields.

12. **Disabled.** Read-only mode disables all. Field-level disabling per spec (e.g. the highRisk notice is display-only; `outputKey` disabled for nodes that write no context value).

### 3b. Per-node field specifications (the `nodeFieldSpecs` registry, all surfaced types)

All labels are user-side; all copy is real. `template:true` fields get the `{ }` inserter. Legacy `AI_STEP`, `NOTIFY`, and `NOOP` are **not** given palette cards but still render a form if present in an imported/generated graph (kept minimal). PARALLEL/JOIN/LOOP are fully editable (they execute).

**AI Employee — `AI_EMPLOYEE_STEP`** *(cards: HR Employee / Marketing Employee, discriminated by picked employee's role)*
| Field | kind | Label / copy | Default | Validation |
|---|---|---|---|---|
| `employeeId` | employee (roleFilter from card) | **"Which employee?"** helper *"Only employees who can do this kind of work are shown."* | — | required; must be a hired employee of matching role (`INVALID_CONFIG` if empty) |
| `instruction` | textarea, template | **"What should <Employee> do?"** placeholder *"Score the CV against the role criteria and recommend only — never consider age, gender, nationality or photo."* | — | required, ≤4000 (`INVALID_CONFIG` if empty) |
| `outputKey` | outputKey | **"Name its result"** helper *"Other steps can use this as `{{screening}}`."* | `result` | `^[A-Za-z_][A-Za-z0-9_]*$` |
| `maxToolCalls` | number (advanced) | **"How many tools it may use"** helper *"Up to 10."* | 3 | int 1–10 (clamped) |
Fixed identity block: 40 px portrait, `"Emma (HR)"`, caption `"AI Employee · reviews & drafts, then hands off"`. Never the words model/agent/prompt/LLM.

**Skill / Tool — `TOOL_ACTION`** *(one card per installed skill+tool, e.g. "Send email (Gmail)")*
| Field | kind | Label / copy | Default | Validation |
|---|---|---|---|---|
| `skillKey` + `tool` | connection | **"Which connection?"** (skill) then **"What should it do?"** (tool) — a two-step `ConnectionPicker` | — | required; tool must exist in `SkillCatalog` |
| `args.*` | keyvalue (each value template) | dynamic arg fields labelled from the tool schema, e.g. **"To"**, **"Subject"**, **"Message"** | tool defaults | per-arg required flags; secret args force `SecretPicker` |
| `employeeId` | employee (advanced) | **"Act as (optional)"** helper *"Use this employee's own connection if they have one."* | — | optional |
| `outputKey` | outputKey | **"Name its result"** | `result` | as above |
Fixed **"Pauses for approval 🔴"** badge + notice when `SkillCatalog.getTool(skillKey,tool)?.highRisk` — *"This step pauses and asks for approval before it publishes — even without an approval step in front of it. That's built in and can't be turned off."* No toggle rendered.

**Knowledge — `RETRIEVE`** (Knowledge Search)
| `query` textarea template | **"What to look up"** placeholder *"the role's must-have skills"* | required |
| `k` number advanced | **"How many results"** | 5 | int 1–50 |
| `outputKey` outputKey | **"Name its result"** | `knowledge` | pattern |
Note under query: *"Searches your whole company knowledge base."* (intentionally not role-scoped — say so).

**Memory — `MEMORY_READ`** (Recall) / **`MEMORY_WRITE`** (Remember)
READ: `employeeId` (employee) **"Whose memory?"**; `kind` select `Fact｜Summary` advanced; `limit` number 1–50 default 10 advanced; `outputKey` default `memory`.
WRITE: `employeeId` **"Whose memory?"**; `content` textarea template **"What to remember"** required; `kind` select default Fact. Fixed notice: *"This saves something for later — it runs for real, not on a test run."*

**Logic — `CONDITION`** (If) → `RuleBuilderField`
Renders **"If [ value ] [ is / is not / contains / greater than / less than ] [ value ]"** as three controls: `left` (template value or `ValueInserter`), `op` select `eq→"is" · neq→"is not" · contains→"contains" · gt→"greater than" · lt→"less than"`, `right` (text/number). Helper for gt/lt: *"Use numbers for greater/less than."* Validation: `left`+`op` required; `right` required. Branch outputs are edges labelled **Yes**/**No** (edited on the canvas / EdgeInspector, not here).

**Logic — `SWITCH`** → `CasesField`
`on` (template value) **"Look at this value"**; a repeatable list of **cases**: each `{ value, branch }` → **"When it's [value], go to the '[branch name]' path."**; a **default** label field **"Otherwise, use this path"** (optional). Add/remove case rows. Validation: ≥1 case (`SWITCH_NO_CASES`); each case needs a non-empty branch label; branch labels become the node's output handles.

**Logic — `LOOP`** (Loop / For each)
| `over` | text (bare path, `ValueInserter` inserts path **without** `{{}}`) | **"Repeat for each item in"** helper *"e.g. the list of candidates"* | required (`INVALID_CONFIG`) |
| `itemVar` | text | **"Call each item"** | `item` | pattern |
| `maxIterations` | number | **"Most times it can repeat"** helper *"Required — keeps a loop from running forever."* | — | required int >0 (`UNBOUNDED_LOOP`) |
| `body` | select (node id → node name) | **"Start of the repeated steps"** | required (`INVALID_CONFIG`) |
| `done` | select advanced | **"After the loop, go to"** | optional |
Notice: *"An approval can't sit inside a loop."* (surfaces `INCOMPATIBLE_PLACEMENT` if violated).

**Logic — `PARALLEL`** (Split) / **`JOIN`** (Merge)
PARALLEL: `lanes` multiselect of node ids **"Start each parallel path at"** (≥1, `PARALLEL_NO_LANES`/`UNKNOWN_LANE_START`); `joinNodeId` select **"They all meet back at"** (required, `UNJOINED_PARALLEL`); `mode` select `All｜Any` default All. Notice: *"Paths run one after another, not truly at the same time."* No nested split (`NESTED_PARALLEL`).
JOIN: `laneOutputKey` text **"Collect the paths' results as"** default `__lanes`.

**Logic — `TERMINATE`** (Stop)
`status` select `Completed｜Failed` **"End as"** default Completed; `reason` textarea template **"Why (optional)"**. Fixed notice: *"Stop is the end — it can't lead anywhere."* (`TERMINATE_HAS_OUTGOING_EDGE`). No `outputKey`.

**Data — `SET_VARIABLE`** (Set value)
`name` text **"Name"** required (`INVALID_CONFIG`); `value` text template **"Value"**; `type` select `Text｜Number｜Boolean｜JSON` default Text advanced; `scope` select **"Keep it for"** `This run (RUNTIME) ｜ The whole workflow (WORKFLOW) ｜ As an output (OUTPUT)` default RUNTIME. Only those three scopes are offered (`SECRET/ENV/INPUT/GLOBAL` throw → `READ_ONLY_SCOPE`); helper *"'Whole workflow' and 'As an output' are saved between runs."*

**Data — `TRANSFORM` / Filter** → `OperationsField`
`input` text (bare path; `ValueInserter` no-`{{}}`) **"Take this value"**; an ordered `operations[]` builder, each `op` from the closed set `Find in JSON (jsonPath) ｜ Map ｜ Filter ｜ Join ｜ Split ｜ To number ｜ To text ｜ Default`, with op-specific args. Add/reorder/remove ops. Helper: *"Steps run top to bottom."* No free expression/eval anywhere. (The "Filter" palette card seeds `operations[0].op='filter'`.)

**Timing — `WAIT`**
`durationMs` → a friendly duration control **"Wait for"** with number + unit `seconds｜minutes｜hours` (stores ms). Clamped `0…MAX_WAIT_MS`; helper *"Max is capped by your plan."*

**Human gate — `APPROVAL`** (Approval / Sign-off) → see §10 for the routing builder
`message` textarea template **"What the reviewer sees"** placeholder *"Approve this candidate email before it sends."*; `autoApprove` toggle **"Skip the human and auto-approve"** default off, guarded with a red confirm; then the embedded `ApprovalRoutingBuilder` (**"Who approves this"**). Notice: *"If it's rejected, the run stops."*

**`TRIGGER`** — not rendered here; selecting it opens `TriggerInspector` (§4).
**Legacy `AI_STEP`/`NOTIFY`/`NOOP`** — render minimal read-mostly forms with a caption *"This is an older step type — new workflows use AI Employee / a real action instead."*; `NOTIFY` adds *"Note: this only logs — it doesn't send anything."*

---

## 4. `TriggerInspector` — the one hand-built form (workflow-level trigger)

1. **Purpose.** Edit *when the workflow starts*. It edits **workflow-level** `triggerType` + `triggerConfig` (not node `config`), keyed by the four user-facing modes. This is the salvaged `TriggerPanel` logic relocated.

2. **States.** Per mode: `manual` · `schedule` · `webhook` · `event`; plus `idle`/`dirty`/`saving`/`readonly`. WEBHOOK adds a `token-minted` / `token-absent` sub-state; SCHEDULE a `cron-valid`/`cron-invalid` sub-state.

3. **Interactions.** A segmented **"When this starts"** control: **When someone starts it (MANUAL) · On a schedule (SCHEDULE) · When a form is submitted (WEBHOOK) · When something happens (EVENT)**. Switching mode reveals that mode's fields. EVENT: `eventType` (searchable, e.g. *"When a candidate emails"*) + optional **connector scoping** picker *"Only from this connection"* (`triggerConfig.connectorId`) — with the double-fire warning (see §11 note). SCHEDULE: a plain-language schedule builder (Every day / Every Monday / Hourly / custom) → cron. WEBHOOK: read-only URL with copy button once minted on Activate. A note reminds that changing trigger type on an ACTIVE workflow will re-arm on next Activate.

4. **Props (typed).**
```ts
interface TriggerInspectorProps {
  workflow: WorkflowDto;                    // triggerType, triggerConfig, webhookToken, status
  connectors: ConnectorLite[];              // installed connections for EVENT scoping
  eventTypes: { value:string; label:string }[];
  readOnly: boolean;
  onWorkflowPatch: (patch: Partial<Pick<WorkflowDto,'triggerType'|'triggerConfig'>>) => void;
}
```

5. **Data requirements.** `workflow.triggerType/triggerConfig/webhookToken/status`; installed connectors; known event types; other ACTIVE workflows on the same connector (for the double-fire warning).

6. **API dependencies.** Writes via `PATCH /workflows/:id { triggerType, triggerConfig, expectedUpdatedAt }` (through canvas Save/draft). Connectors from `GET /skills`. Webhook token is minted server-side on `POST /workflows/:id/activate` (Toolbar action) — the Inspector only displays it. Schedule arming/disarming is server-side on activate/deactivate.

7. **Responsive.** Same dock/overlay/read-only rules. The webhook URL row wraps + truncates with a copy button at all widths.

8. **Keyboard.** Segmented control is a `radiogroup` (arrow keys switch, Space selects). Copy-URL is a button (`Enter`). Schedule builder selects are standard.

9. **Accessibility.** `radiogroup` `aria-label="When this workflow starts"`; each option's `aria-label` is the plain phrase. Webhook URL field `readonly` `aria-label="Webhook URL"`; copy announces *"URL copied."* via live region.

10. **Loading.** Connector/event-type selects skeleton; mode control renders immediately from `workflow.triggerType`.

11. **Error.** SCHEDULE/EVENT misconfig returns **400** on save → inline: *"Pick how often this should run."* / *"Choose what event starts this."* Webhook not yet minted → *"The URL appears after you turn this workflow on."*

12. **Disabled.** Read-only in Watch/Locked. EVENT connector-scoping disabled with *"No connections installed yet — add one in Skills."* when `connectors` empty. Changing trigger while a run is in-flight is allowed (affects future runs only) but shows a quiet note.

---

## 5. `EdgeInspector` — a connection selected

1. **Purpose.** Edit the meaning of a selected edge: its **branch** (for CONDITION Yes/No and SWITCH cases) and let the user re-point or remove it. There are **no ports and no label field beyond `branch`** — `branch` *is* the label.

2. **States.** `plain-edge` (non-branch source; branch not editable) · `condition-edge` (Yes/No) · `switch-edge` (case picker) · `approval-edge` (single forward; branch locked) · `readonly`. Plus `branch-duplicate-warning`.

3. **Interactions.** Header shows *"From «CV attached?» → «Store CV»"* using node names. For CONDITION/SWITCH sources: a **"On which path?"** select (Yes/No, or the case labels + default) writing `edge.branch`. Buttons: **Insert a step on this path…** (splits the edge), **Re-point…** (enters re-point mode on canvas), **Remove connection** (deletes edge only). For SWITCH, a **Rename this path** field edits the case label (kept in sync with the node's `cases[].branch`).

4. **Props (typed).**
```ts
interface EdgeInspectorProps {
  edge: WorkflowEdge; sourceNode: WorkflowNode; targetNode: WorkflowNode;
  branchOptions: { value:string; label:string; taken:boolean }[];  // from source node kind
  readOnly: boolean;
  onEdgePatch: (edgeId: string, patch: { branch?: string }) => void;
  onEdgeAction: (edgeId: string, action:'insertStep'|'repoint'|'remove') => void;
}
```

5. **Data requirements.** The edge + both endpoint nodes' names; the source node's available branch labels (CONDITION → `['true'→"Yes",'false'→"No"]`; SWITCH → case labels + default) and which are already taken.

6. **API dependencies.** None directly; edits mutate the definition → canvas draft save.

7. **Responsive.** Same dock/overlay; mobile read-only display of source/branch/target.

8. **Keyboard.** Branch select arrow-navigable; action buttons in tab order; `Delete` while an edge is selected removes the connection (mirrors canvas).

9. **Accessibility.** Region `aria-label="Connection settings"`; announces *"Connection from CV attached? to Store CV, on the Yes path."* Branch select `aria-label="Which path this connection is for"`.

10. **Loading.** Not applicable (edge + node names are in-memory); renders instantly.

11. **Error.** Choosing an already-taken branch → inline `text-red-400`: *"Yes already goes somewhere. Re-point the existing one instead."* (blocks the change; mirrors canvas `MISSING_BRANCH_EDGE`/duplicate rule). Approval edge branch is locked with *"An approval always continues on one path."*

12. **Disabled.** Branch select disabled for plain (non-branch) sources with *"This step has just one path."* Read-only in Watch/Locked. Remove disabled if it would orphan the sole trigger path (delegated to canvas branch-loss confirm).

---

## 6. `MultiSelectInspector` — bulk (≥2 selected)

1. **Purpose.** Act on a multi-selection: show the count and offer bulk actions that are safe across mixed types — Align, Distribute, Tidy selection, Duplicate, Remove — plus a read-only breakdown of what's selected. No per-field config editing across a heterogeneous set (that would be error-prone); config editing requires a single selection.

2. **States.** `homogeneous` (all same type — offers a shared note) · `heterogeneous` · `contains-trigger` (Duplicate disabled) · `readonly`.

3. **Interactions.** Header *"3 steps selected"* (+ *"and 1 connection"* if edges included). Buttons: **Align** (left/center/right), **Distribute** (horizontal/vertical), **Tidy these** (dagre on the subset), **Duplicate** (⌘D), **Remove** (aggregated branch-loss confirm). A list summarises each selected item by name + category badge; clicking one narrows selection to it (→ single-node form).

4. **Props (typed).**
```ts
interface MultiSelectInspectorProps {
  nodes: WorkflowNode[]; edges: WorkflowEdge[];
  containsTrigger: boolean; readOnly: boolean;
  onBulk: (action:'alignLeft'|'alignCenter'|'alignRight'|'distributeH'|'distributeV'
                 |'tidy'|'duplicate'|'remove') => void;
  onNarrowTo: (nodeId: string) => void;
}
```

5. **Data requirements.** The selected nodes/edges (names, categories, positions), and whether the set includes the TRIGGER.

6. **API dependencies.** None directly; bulk position/removal mutate the definition → canvas draft save.

7. **Responsive.** Dock/overlay; on mobile read-only (shows the list, no bulk edit).

8. **Keyboard.** Buttons in tab order; the item list is a `listbox` (arrows move, `Enter` narrows). `⌘D`/`Delete` mirror canvas.

9. **Accessibility.** Region `aria-label="3 steps selected"`; align/distribute buttons have descriptive `aria-label`s; the list is `role="listbox"` with each row `role="option"`.

10. **Loading.** Not applicable; renders from in-memory selection.

11. **Error.** Remove aggregates the branch-loss `window.confirm`: *"Removing these also drops the steps that only follow them. Remove anyway?"* Align/Distribute need ≥2 nodes else those buttons are disabled with a tooltip.

12. **Disabled.** Duplicate disabled when `containsTrigger` (*"A workflow has exactly one start."*). All actions disabled in Watch/Locked.

---

## 7. Param-binding pickers — `EmployeePicker` · `ConnectionPicker` · `ChannelPicker` · `KnowledgeCategoryPicker`

These four render **resource pickers, never text boxes**, matching the four `TEMPLATE_PARAMETER_BINDS` (`employee｜skill｜channel｜knowledgeCategory`). Shared shell: a `.field-modern` button that opens a searchable popover (`role="listbox"`, `radius-btn`, `surface-raised`, `elev-popover`), typeahead filter, keyboard-navigable, with an inline "install/hire" empty invitation. Below is the shared spec with per-picker deltas.

1. **Purpose.** Bind a config field to a real tenant resource (employee / installed connection / Slack channel / knowledge scope), validated against live resources so a bad bind fails early rather than at install-time 422.

2. **States.** `closed(value)` · `closed(empty)` · `open` · `searching` · `loading` · `error` · `no-results` · `empty-invitation` (zero resources exist) · `disabled` · `invalid` (bound resource no longer exists).

3. **Interactions.** Click / `Enter` opens; type filters; ↑/↓ move; `Enter` selects; `Esc` closes. Selecting writes the resource id (employee→`employeeId`; connection→`skillKey`(+ tool step); channel→channel id in the tool arg; knowledge→category key). A cleared selection sets the field empty. **EmployeePicker** additionally shows each row as a portrait + name + role badge and is **filtered to the node's role** (`roleFilter`).

4. **Props (typed).**
```ts
interface ResourcePickerProps<T> {
  value: string | null;
  options: T[];                 // EmployeeLite | SkillLite | ChannelLite | KnowledgeCat
  loading: boolean; error: NormalizedApiError | null;
  roleFilter?: 'HR' | 'MARKETING';   // EmployeePicker only
  readOnly?: boolean;
  onChange: (id: string | null) => void;
  onRetry: () => void;
}
interface EmployeeLite { id:string; name:string; role:'HR'|'MARKETING'|'CUSTOM'; avatarUrl?:string }
interface SkillLite { key:string; name:string; status:'CONNECTED'|'DEGRADED'|'DISCONNECTED'; tools:{tool:string;label:string;highRisk:boolean}[] }
interface ChannelLite { id:string; name:string }            // from installed slack config
interface KnowledgeCat { key:string; label:string }         // EmployeeRole scopes + Shared
```

5. **Data requirements.** EmployeePicker: hired employees (id/name/role/avatar), filtered to `roleFilter`, CUSTOM excluded for AI Employee node. ConnectionPicker: installed skills + their tools (+highRisk flags). ChannelPicker: channels from the installed `slack` connector config. KnowledgeCategoryPicker: role scopes + Shared.

6. **API dependencies.** EmployeePicker → `GET /employees` (client-filter by role). ConnectionPicker/ChannelPicker → `GET /skills` (installed; channel list from the slack skill's config). KnowledgeCategoryPicker → knowledge categories (via the knowledge module; static role set + Shared as fallback). All cached under their own query keys, `staleTime` 5 min.

7. **Responsive.** Popover anchors under the field on desktop/tablet; on mobile (read-only) the picker renders the bound resource's name as static text.

8. **Keyboard.** Trigger button focusable; popover is a `combobox`+`listbox` pattern (`aria-expanded`, `aria-activedescendant`); typeahead filters live; `Esc` returns focus to trigger.

9. **Accessibility.** Trigger `aria-label` = the field label + current value (*"Which employee? Emma (HR)"*). Options `role="option"` with `aria-selected`. EmployeePicker option label includes role: *"Emma, HR employee."* Announce selection via live region: *"Assigned to Emma."*

10. **Loading.** Popover shows 3 skeleton rows; trigger shows `Loading…` if opened before deps resolve.

11. **Error.** Fetch failure → in-popover inline: *"Couldn't load employees. Retry."* Invalid stored bind (resource deleted) → trigger shows red *"This employee was removed — pick another."* (surfaces at publish as the run-time miss, not a structural code).

12. **Disabled / empty-invitation.** Read-only disables. Zero resources → an **invitation**, never a dead select:
- EmployeePicker (no matching role): *"No HR employees yet. Hire one to assign this step."* (Marketing card + this message together cover the **G10 422**: *"Hire a Marketing employee to use this workflow."*)
- ConnectionPicker: *"No connections yet. Install one in Skills."*
- ChannelPicker: *"Connect Slack to pick a channel."*
- KnowledgeCategoryPicker always has ≥ Shared, so no empty state.
- Connections that are `DEGRADED`/`DISCONNECTED` render with a muted status dot and note *"Reconnect this to use it"* but remain selectable (quarantine happens at run time).

---

## 8. `ValueInserter` — "insert a value from earlier" ({{...}} builder)

1. **Purpose.** Replace raw `{{a.b.c}}` typing with a picker that inserts a reference to an earlier node's output, a trigger field, or a variable — the single UX that keeps templates user-friendly. Handles the two dialects: normal fields insert `{{path}}`; bare-path fields (LOOP `over`, TRANSFORM `input`) insert the **path without braces** (to preserve real array types).

2. **States.** `closed` · `open` · `searching` · `empty` (no upstream outputs yet) · `bare-mode` (no-braces) · `template-mode` · `disabled`.

3. **Interactions.** A small `{ }` affordance on every template-capable field opens a categorised popover: **Trigger** (`trigger.*`), **Earlier steps** (each upstream node grouped by its `outputKey`, e.g. `screening.score`), **Variables** (workflow/output-scoped `SET_VARIABLE` names). Selecting inserts the token at the caret. Nested paths expandable. A live preview line shows the literal that will be inserted (`mono-sm`): `{{screening.score}}`.

4. **Props (typed).**
```ts
interface ValueInserterProps {
  mode: 'template' | 'bare';           // bare = LOOP.over / TRANSFORM.input
  upstream: OutputRef[];               // reachable earlier nodes + their outputKeys
  triggerFields: string[];             // known trigger.* leaves (best-effort)
  variables: WorkflowVariableLite[];
  onInsert: (token: string) => void;   // caret-aware insert
  disabled?: boolean;
}
interface OutputRef { nodeId:string; nodeName:string; outputKey:string; sampleKeys?:string[] }
```

5. **Data requirements.** Topologically-earlier nodes (only those that can precede the current node), each with its `outputKey` and (best-effort) sample sub-keys; trigger field names; workflow/output variables.

6. **API dependencies.** Upstream outputs derived client-side from the graph; variables from `GET /workflow-variables?workflowId=`. No dedicated endpoint (the resolver is runtime-only).

7. **Responsive.** Popover on desktop/tablet; hidden on mobile (read-only).

8. **Keyboard.** `Alt+/` opens when a template field is focused; tree navigable with arrows; `Enter` inserts; `Esc` returns focus to the field caret position.

9. **Accessibility.** `{ }` button `aria-label="Insert a value from earlier"`; tree `role="tree"`; each leaf `aria-label` in plain words: *"Emma's result: score."* Insert announces *"Inserted a reference to Emma's score."*

10. **Loading.** Variables skeleton row while fetching; upstream/trigger render instantly.

11. **Error.** Variables fetch failure → the Variables group shows *"Couldn't load variables."* with retry; other groups still usable.

12. **Disabled / empty.** Disabled read-only. When there are no earlier steps: *"Nothing earlier to reference yet — add a step before this one."* Bare-mode shows a hint *"This inserts the value itself (a list stays a list)."*

---

## 9. `SecretPicker` — the secret field (values never rendered)

1. **Purpose.** For any arg flagged secret, insert the literal `{{secrets.KEY}}` chosen from saved connections — **the value is never fetched or shown.** This is what satisfies `INLINE_SECRET_FORBIDDEN`.

2. **States.** `closed(value)` · `open` · `loading` · `error` · `empty` (no saved connections) · `disabled`.

3. **Interactions.** Opens a list of secret **keys + metadata only** (name, connector, added date). Selecting writes `{{secrets.STRIPE_KEY}}` into the field. The field displays the *reference*, never a value, with a lock glyph.

4. **Props (typed).**
```ts
interface SecretPickerProps {
  value: string | null;                 // e.g. "{{secrets.GMAIL_OAUTH}}"
  secretKeys: { key:string; label:string; connector:string; addedAt:string }[];
  loading: boolean; error: NormalizedApiError | null;
  readOnly?: boolean;
  onChange: (ref: string | null) => void; onRetry: () => void;
}
```

5. **Data requirements.** Keys + metadata for this workflow's saved secrets. **No values, ever.**

6. **API dependencies.** `GET /workflow-secrets?workflowId=:id` (keys/metadata only).

7. **Responsive.** Popover desktop/tablet; mobile shows the reference read-only.

8. **Keyboard.** Combobox/listbox pattern; `Esc` returns focus.

9. **Accessibility.** Trigger `aria-label="Pick a saved connection"`; options labelled by key + connector; a persistent SR note *"Values are hidden — only the connection name is shown."*

10. **Loading.** 3 skeleton rows.

11. **Error.** *"Couldn't load your saved connections. Retry."*

12. **Disabled / empty.** Empty → *"No connections saved yet."* (field disabled). Read-only disables.

---

## 10. `ApprovalRoutingBuilder` — "who approves this" (P3-05)

1. **Purpose.** The signature human-gate config on the APPROVAL node (and reusable as an employee's `approvalRules.routing`): build the ordered sign-off chain — levels, per-level rule + target, SLA, escalation chain, and on-timeout policy — with safety framing that makes `AUTO_APPROVE` a deliberate, hard-to-fumble opt-in.

2. **States.** `unrouted` (no levels → "any admin") · `single-level` · `multi-level` · `has-escalation` · `sla-set` · `auto-approve-armed` (guarded) · `invalid` (rule needs a target) · `readonly`.

3. **Interactions.** Header **"Who approves this"** with a plain summary line (*"Recruiter signs off within 24 hours; if no answer, it goes to any admin."*). **Add a sign-off level** appends an ordered `ApprovalRoutingLevel` card: **rule** select `A specific person (USER) ｜ A role (ROLE) ｜ A department (DEPARTMENT) ｜ A team (TEAM) ｜ The employee's manager (EMPLOYEE_MANAGER) ｜ Any admin (ANY_ADMIN)`; a **target** picker whose kind switches on rule (user/role/department/team; hidden for manager/any-admin); **SLA** `slaMinutes` friendly duration (**"Answer within"**); a collapsible **"If no answer in time"** = `onTimeout` select `Nothing — keep waiting (NONE) ｜ Send it up the chain (ESCALATE) ｜ Approve automatically (AUTO_APPROVE) ｜ Reject automatically (AUTO_REJECT)`; and, when ESCALATE, an ordered **escalation chain** of fallback hops (same rule+target editor). Levels reorderable/removable. Choosing **AUTO_APPROVE** triggers a `window.confirm`: *"Auto-approve means this can go out with no person checking it. Only use it for low-risk steps. Turn it on?"* and paints the level card with a gold caution band.

4. **Props (typed).**
```ts
interface ApprovalRoutingBuilderProps {
  value: ApprovalRoutingConfig;         // { levels, maxEscalations?, defaultOnTimeout? }
  isWorkflowNode: boolean;              // allows {{template}} targets on WORKFLOW nodes
  directory: { users:UserLite[]; roles:{value:string;label:string}[];
               departments:{id:string;name:string}[]; teams:{id:string;name:string}[] };
  readOnly?: boolean;
  onChange: (next: ApprovalRoutingConfig) => void;   // writes node.config.routing
}
```

5. **Data requirements.** Current `config.routing`; directory of users/roles/departments/teams for target pickers; whether this is a WORKFLOW-kind node (to allow `{{template}}` targets).

6. **API dependencies.** Persisted inside the node config via the ordinary draft save — **no routing endpoint.** Target pickers depend on directory reads: `GET /company/members` (users), roles are the fixed enum, `GET /departments`, `GET /teams` ⚠ *(these directory endpoints are not in the verified workflow API surface — confirm/point them at the org module before wiring; until then the USER/DEPARTMENT/TEAM targets degrade to a validated id text field with a warning).* Read-only display of live routing state (`dueAt`, `escalationTier`, `autoDecided`, `escalatedToId`) comes from the `ApprovalRequest` in the Timeline, not here.

7. **Responsive.** Level cards stack; on tablet overlay same; mobile read-only summary.

8. **Keyboard.** Each level card is a `group`; add/remove/reorder buttons in tab order; reorder also via `⌘↑/⌘↓` on a focused card. `Esc` closes an open target picker.

9. **Accessibility.** Region `aria-label="Who approves this"`; each level `aria-label="Sign-off 1: Recruiter, answer within 24 hours."`; the AUTO_APPROVE option is `aria-describedby` the caution text; enabling it announces (assertive) *"Auto-approve is on for this step — no person will check it."*

10. **Loading.** Directory pickers show skeleton options; the levels structure renders from config instantly.

11. **Error.** A level with a targeted rule but no target → inline *"Pick who signs off at this level."* A `USER`-only chain with no `ANY_ADMIN` fallback shows a non-blocking caution: *"If this person is away, no one else can approve. Add 'any admin' as a backup?"* (the sanctioned unavailable-user answer).

12. **Disabled.** Read-only disables all. When `autoApprove` (node-level) is on, the routing builder is dimmed with *"This step auto-approves, so there's no one to route to."* `maxEscalations` (advanced) capped/defaulted to 3.

---

## 11. `WorkflowPermissionsPanel` — who can run this (P3-06)

1. **Purpose.** Grant / list / revoke **RUN** access. Explains the default (*"unrestricted = anyone in your company can run it"*) and, the moment the first grant is added, that it becomes restricted (owner/admin always retain a bypass). Only **RUN** is enforced today; other actions persist but are noted as not-yet-enforced.

2. **States.** `unrestricted` (zero RUN grants) · `restricted` (≥1) · `adding` · `saving` · `revoking` · `error` · `forbidden` (caller not owner-or-admin) · `readonly`.

3. **Interactions.** Opened from `WorkflowSettingsPanel` as a Modal. Top banner reflects current mode: unrestricted → *"Anyone in your company can run this workflow."*; restricted → *"Only the people below can run it — plus owners and admins."* **Add who can run** row: a subject-type select `A person (USER) ｜ A role (ROLE) ｜ A department (DEPARTMENT) ｜ A team (TEAM)` + a matching subject picker → **Add**. Each grant lists subject name + type with a **Remove** (`window.confirm`: *"Stop this group from running the workflow?"*). Optimistic add/remove with rollback.

4. **Props (typed).**
```ts
interface WorkflowPermissionsPanelProps {
  workflowId: string;
  canManage: boolean;                   // owner-or-admin
  permissions: WorkflowPermissionDto[]; // filtered to action==='RUN'
  directory: { users:UserLite[]; roles:{value:string;label:string}[];
               departments:{id:string;name:string}[]; teams:{id:string;name:string}[] };
  onClose: () => void;
}
```

5. **Data requirements.** RUN grants for this workflow; directory for subject pickers; whether the caller can manage.

6. **API dependencies.** `GET /workflows/:id/permissions` → filter `action:'RUN'`; `POST /workflows/:id/permissions { subjectType, subjectId, action:'RUN' }`; `DELETE /workflows/:id/permissions/:permissionId`. Subject directory as in §10 (⚠ same directory-endpoint caveat). Optimistic triad (`onMutate`/`onError`/`onSettled`) on the grants query key.

7. **Responsive.** Renders in the shared focus-trapped `Modal` (desktop/tablet). On mobile it is view-only (grants list, no add/remove) — consistent with mobile-read-only.

8. **Keyboard.** Focus trap; subject select + picker + Add in tab order; each grant row's Remove reachable via `Tab`; `Esc` closes the Modal.

9. **Accessibility.** `role="dialog" aria-modal="true" aria-label="Who can run this workflow"`; banner `role="status"`; grant list `role="list"`; add/remove announce via live region: *"Added the Recruiting team."* / *"Removed Priya."* Assertive announcement on 403.

10. **Loading.** Grants list shows 3 skeleton rows; the banner shows a neutral *"Checking who can run this…"* until resolved.

11. **Error.** Non-manager → **403** empty-permission view: *"Only the workflow's owner or a company admin can change who runs it."* (all controls hidden). Duplicate grant → **409** inline: *"They can already run this."* Revoke of a missing grant → **404** silently reconciled (refetch). Add failure rolls back optimistically with *"Couldn't add that just now. Try again."*

12. **Disabled.** Add disabled until both a subject-type and a subject are chosen. All mutating controls disabled when `!canManage` or in Watch/Locked. A footnote clarifies enforcement honesty: *"Right now this controls who can run the workflow. Edit and publish permissions are coming soon."* (only RUN is enforced).

---

### Cross-cutting through-line (the AI-Employee-OS discipline this cluster must preserve)
An action keeps its name from node → inspector → approval inbox → live string: the APPROVAL node titled **"Approve outreach"** shows *"Approve outreach"* as its reviewer prompt (`config.message`), lands in the inbox as **"Approve outreach"**, and resolves to the inline/live string *"Outreach approved."* The Inspector never exposes engine identifiers (`approverRuleType`, `highRisk`, `skillKey`, `AI_EMPLOYEE_STEP`, `EVENT`) — every label is what a manager controls, in active voice, sentence case. Employee fields always name a person (*"What should Emma do?"*), the highRisk pause is shown as a fixed truthful notice rather than a toggle, and errors are invitations to act, never apologies.


---

## 3.F — Execution & observability (live run · debug · run history)

# Execution + Observability Cluster — Component Specs

Orlixa V-AEP Workflow Builder. These three components turn the static builder into a **live theatre of the run** and an honest **post-mortem**. They inherit every token, status color, motion rule, and loading/error/empty pattern from the Design Spine — this doc only adds component-specific detail and flags where the shipped data model constrains what can truthfully be shown.

**Non-negotiable ground truths these specs are built on (do not drift):**
- The **only shipped run-read is `GET /workflows/runs/:runId`** → `WorkflowRunDto` with ordered `steps[]` (`WorkflowStepRunDto`). There is **no** `/runs/:id/timeline`, `/attempts`, and **no WebSocket gateway**. So realtime is *polling today*; the `seq`/gap/WS path is spec'd as additive and dark until the gateway ships.
- Live runs use the **legacy walk** → only `WorkflowStepRun` rows exist (no attempt rows, no `RETRYING`/`COMPENSATING`/`TIMED_OUT`, `run.workflowVersionId` may be `null`). The richer attempt view lights up **only if attempt data is present**; it is never fabricated.
- **There is no HTTP cancel/retry/resume/compensate route.** A run only stops early by **rejecting its approval** (`POST /approvals/:id/reject` → `cancelRun` → run `FAILED`). Retry = **start a fresh run** (`POST /workflows/:id/run`). Compensation cannot be user-driven today. Every control below is wired to that reality and disabled-with-a-reason where the backend can't honor it.
- Duration is **never stored** — always derived `finishedAt − startedAt`.
- `run.context` and `step.input/output` are **sensitive and server-redacted**; the client does **zero** redaction and never re-fetches secret values.

Shared token references used throughout: `status-*` colors + glyphs + motion from Spine Part 1 §4; `anim-flow`/`anim-breathe`/`anim-pulseDot` (reuse only); `elev-running`/`elev-waiting`; the single `aria-live="polite"` region; Watch/Locked modes and the `?run=` query param from Part 2 §1.1.

---

## 1A. `RunCanvasLayer` — the live run playing over the graph

### (1) Purpose
Overlays run state onto the existing `WorkflowCanvas` nodes and edges so a run reads as a sentence unfolding top-to-bottom: nodes light up as they execute, the current edge flows, the paused approval glows gold with a decide affordance, and a dry-run wears a "Test run" skin. It does **not** own the graph geometry — it consumes the same nodes/edges the canvas already renders (pinned to the run's frozen version in Watch mode) and paints status on top.

### (2) States
- **no-run** — Edit mode, nothing overlaid (component inert).
- **loading-run** — `?run=` present, run snapshot not yet fetched → canvas dims, `aria-busy`.
- **watching-active** — run status ∈ `PENDING|RUNNING|WAITING`; polling live.
- **waiting-approval** — run `WAITING`; one node in gold "waiting on a person" state with a decide seam.
- **terminal-complete** — run `COMPLETED`; one-shot green sweep then settle.
- **terminal-failed** — run `FAILED`; failed node red top-wash, `run.error` preview.
- **dry-run** — `run.dryRun===true`; whole overlay wears the Test-run skin, TOOL_ACTION nodes marked "preview / not sent."
- **degraded-legacy** — attempts/richer statuses unavailable; overlay restricts itself to `PENDING→RUNNING→COMPLETED/FAILED/WAITING`.
- **version-mismatch** — the run's version graph differs from the current draft (Watch pins to `WorkflowVersion.definition`; a banner notes "You're watching version N, not your current draft").

Per-node status (drives each `WorkflowNodeCard`'s run skin), sourced from `steps[].status`: `PENDING · RUNNING · WAITING · COMPLETED · FAILED · SKIPPED` — plus, **only if attempt data ever arrives**, `RETRYING`. Each uses the Spine §4 glyph+color+motion (never color-alone).

### (3) Interactions
- Entering Watch (clicking a history row, `?run=` load, or firing a Run) freezes the canvas `readOnly`, pins geometry to the run's version, and starts the overlay.
- Clicking any node with a step row opens the **Debug Panel** (§2) for that step; the node keeps its run skin.
- On a `WAITING` node the user can decide **inline** (see §waiting decide seam): an **Approve** / **Reject** affordance appears on the node *and* in the Run Bar, but only if the current user is an eligible decider (resolved via the approval's routing — see Data). Deciding calls the approvals API; on success the overlay optimistically flips the node to "resuming."
- Hovering a completed edge shows its from→to step names (reuses Outline labels; edges stay `aria-hidden`).
- Live progression is automatic: the RUNNING node breathes (`anim-breathe`), its incoming edge marches (`anim-flow`), the alive-dot pings (`anim-pulseDot`). At most one looping animation set on screen (Spine §5 discipline).

### (4) Props (typed shape)
```ts
interface RunCanvasLayerProps {
  runId: string | null;                 // null in Edit mode → inert
  workflowId: string;
  // geometry the canvas already computed for the run's pinned version:
  nodes: RunLayerNode[];                 // { id, nodeId, position, category, type, name, highRisk }
  // live run snapshot (from useRunTimeline):
  run: WorkflowRunDto | undefined;       // status, dryRun, error, resumeNodeId, workflowVersionId, steps[]
  realtime: RealtimeStatus;              // 'connecting'|'live'|'reconnecting'|'polling-fallback'
  pendingApproval: ApprovalRequestDto | null; // the run's PENDING approval, if any
  canDecideApproval: boolean;            // eligibility precomputed from routing
  onSelectStep: (nodeId: string) => void;
  onDecide: (decision: 'approve' | 'reject', note?: string) => void;
  reducedMotion: boolean;
}
```
No new store slice — `runId`, `realtime`, and selection live in `WorkflowCanvas` local state (Spine hard rule §f.1).

### (5) Data requirements
- **The run snapshot**: `status`, `dryRun`, `source`, `error`, `failureClass`, `resumeNodeId`, `workflowVersionId`, `startedAt`, `finishedAt`, and `steps[]` (each `{nodeId, type, status, output, error, startedAt, finishedAt}`).
- **Which node is paused**: a `WAITING` run's paused node is the step whose `output` carries `{awaitingApproval:true}` (APPROVAL node, left `RUNNING` as a paused marker) **or**, for a gated `TOOL_ACTION`, `run.resumeNodeId === node.id`. The overlay resolves the paused node from those two signals, not from a status field.
- **Pinned geometry**: `WorkflowVersion.definition` for `run.workflowVersionId`; **fallback to `Workflow.definition`** when null (pre-versioning legacy runs).
- **The approval to decide**: the `ApprovalRequest` whose `workflowRunId === runId` and `status==='PENDING'`.
- **Eligibility**: from the approval's `approverRuleType`/`approverRuleValue`/`assigneeUserId` vs the current user (Spine copy: "You're not the approver for this.").

### (6) API dependencies (exact)
- Poll: **`GET /workflows/runs/:runId`** → `WorkflowRunDto` (steps included). `refetchInterval: isActive(run) ? 1000 : false`, `isActive` = status ∈ `PENDING|RUNNING|WAITING`.
- Pinned graph: **`GET /workflows/:id/versions/:version`** → `WorkflowVersionDto` (only when `workflowVersionId` set and not already cached).
- Paused-approval lookup: **`GET /approvals?status=PENDING`** → filter client-side to `workflowRunId===runId` (no `?runId=` filter exists).
- Decide: **`POST /approvals/:id/approve`** or **`POST /approvals/:id/reject`** with `DecideApprovalDto {note?}`. Approve → run resumes (`resumeRun`); reject → run `FAILED` (`cancelRun`).
- Additive/dark until built: WS channel `run:{runId}`, envelope `{seq,runId,companyId,type,emittedAt,data}`; a `seq` gap triggers a full `GET /workflows/runs/:runId` refetch. Ships as a no-op that reports `polling-fallback` today.

### (7) Responsive behaviour
- **Desktop ≥1280**: full overlay on the interactive canvas; decide seam inline on the node + mirrored in Run Bar.
- **Tablet 768–1279**: overlay intact; decide happens in the Run Bar / bottom sheet (node is small; inline buttons collapse to a single "Waiting — decide" chip that opens the sheet).
- **Mobile <768**: canvas is a **read-only monitor**; the overlay degrades to the **Outline** run view (nodes as a `role="tree"` with status glyph + label). Approvals are fully decidable here via the mobile approvals sheet — a manager can approve on a phone.

### (8) Keyboard behaviour
- Watch mode keeps canvas `role="application"` focus semantics: **Tab / Shift-Tab** walk nodes in topo-then-id order; **Enter** on a focused node opens its Debug Panel.
- On a focused `WAITING` node the user can decide: **A** = approve, **R** = reject (both open a confirm with an optional note field; only active when `canDecideApproval`). Mirrors the node's visible buttons and the ⋯ menu so it's never mouse-only.
- **Esc** exits any decide confirm → returns focus to the node.
- Editing shortcuts (nudge, connect, delete) are suppressed in Watch (read-only).

### (9) Accessibility
- Each node keeps `role="group"` `aria-roledescription="workflow step"`; its `aria-label` is **human label + run state**, e.g. *"Emma, HR employee, reviews the application. Running."* / *"Recruiter reviews. Waiting on a person, resumes at Notify."* / *"Send email, Gmail. Test run — preview, not sent."* Never node ids or `AI_EMPLOYEE_STEP`.
- Status is **glyph + color + (for live) motion**, colorblind-safe; the label carries the state in words so greyscale/SR both work.
- Progress announces through the shared `aria-live="polite"` region, reusing the exact visible strings, throttled ≥1s and coalesced: *"Emma is reviewing the application." · "Waiting on Recruiter to approve before it sends." · "Recruiter approved. Continuing." · "Run finished. All steps complete." · "Run stopped: {failureClass in plain words}."*
- `aria-live="assertive"` reserved for a WAITING approach on an approval **this user can decide**, and for a failed decide.
- Edges remain `aria-hidden`; the Outline is the connectivity/status fallback. Minimap `aria-hidden`.

### (10) Loading state
- `?run=` load: canvas shows dim skeleton node cards at their pinned positions + centered "Loading this run…"; `aria-busy=true`; no motion until the first snapshot resolves.
- Version-graph fetch in flight: overlay waits on geometry before painting status (never paints status onto the wrong graph).
- Reduced-motion (globally enforced): all `flow`/`breathe`/`pulseDot` drop to static styles — RUNNING = static violet border + `◐` glyph, live edge = static violet solid, alive-dot = static green. Correctness never depends on animation.

### (11) Error state
- **404** (archived / purged / cross-tenant run): Locked-mode banner *"This run isn't here anymore."*, overlay cleared.
- **410** (purged after retention): retention copy in place of the run, not a generic error — *"This run's details were cleared after the retention window."*
- Poll failure (network): `realtime` pill flips `reconnecting → polling-fallback`; last-known snapshot stays on screen with a quiet *"Reconnecting…"* — never blanks a live run.
- Decide errors: **403** *"You're not the approver for this."* (buttons disable with reason); **409** *"Already approved."* / *"Already rejected."* (refetch approval + run); both announced assertively.
- A legacy node throw surfaces as `FAILED` with `run.error` preview in the failed node's subtitle + a "See why" link to the Debug Panel — no invented `RETRYING`/`COMPENSATING`.

### (12) Disabled state
- Whole overlay inert in Edit mode (`runId===null`).
- Decide affordance **disabled with reason** when `!canDecideApproval` (*"You're not the approver for this."*) or when the run isn't `WAITING`.
- In a **dry-run**, no decide seam ever appears — the G25 tool gate is skipped server-side, so a Test run never pauses; TOOL_ACTION nodes instead show the static "preview / not sent" marker.

---

## 1B. `RunBar` — bottom dock: launch, status, elapsed, stop/retry

### (1) Purpose
The persistent bottom strip that launches runs (live + Test), shows the active run's status/elapsed/source, and offers the honest set of run controls. Collapsed it's a one-line status; it hosts the Run popover (trigger JSON + dryRun, salvaged from `RunPanel`) and hands off to the ExecutionTimeline dock when expanded.

### (2) States
- **idle-no-runs** — invitation: *"No runs yet. Hit Test to try it safely, or Run to go live."*
- **idle-with-history** — *"Last run: COMPLETED 2m ago · [History ▾]"*.
- **launching** — Run/Test pressed, awaiting the 201; button shows inline progress, `aria-busy`.
- **active** — a run is `PENDING|RUNNING|WAITING`; live status pill + elapsed ticking.
- **waiting** — run `WAITING`; pill gold, "Waiting on {approver}", inline **Approve/Reject** mirror if eligible.
- **terminal** — `COMPLETED`/`FAILED` pill; elapsed frozen to final duration; **Run again** offered.
- **dry-run-active** — pill prefixed "Test run"; no live provider calls.
- **watch-readonly** / **locked** — Run/Test disabled with reason.

### (3) Interactions
- **Run** (`⌘⇧⏎`) and **Test** (`⌘⏎`) open the **Run popover**: a trigger-JSON textarea (validated as JSON) + a `dryRun` toggle preset by which button opened it; Confirm calls the run endpoint; `onSuccess` sets `runId` and flips the whole builder to Watch.
- **Status pill** click → expands the ExecutionTimeline dock (`⌘J`).
- **Stop** (see §disabled truth): enabled **only** when the run is `WAITING` with an approval the user can reject → maps to `POST /approvals/:id/reject` (the sole way to stop a run today). Otherwise disabled with reason.
- **Run again / Retry**: always a **fresh run** via `POST /workflows/:id/run` (optionally re-using the prior run's `trigger` JSON). There is no in-place retry.
- **Compensate**: rendered disabled with reason — no user-drivable route exists.
- **History ▾** opens the Run History list (§3).

### (4) Props (typed shape)
```ts
interface RunBarProps {
  workflowId: string;
  mode: 'edit' | 'watch' | 'locked';
  activeRun: WorkflowRunDto | undefined;   // the run being watched, if any
  lastRun: WorkflowRunSummary | undefined; // for the idle "last run" line
  canRun: boolean;                         // RUN-permission (403 pre-check) + not archived
  pendingApproval: ApprovalRequestDto | null;
  canRejectActive: boolean;                // eligible decider on the active WAITING approval
  onRun: (args: { trigger?: object; dryRun: boolean }) => void;
  onStopViaReject: (approvalId: string, note?: string) => void;
  onOpenTimeline: () => void;
  onOpenHistory: () => void;
  launching: boolean;
}
```

### (5) Data requirements
- Active run: `status`, `source`, `dryRun`, `startedAt`, `finishedAt`, `error`, `failureClass`.
- Elapsed = `now − startedAt` while active (client ticker, 1s), frozen to `finishedAt − startedAt` on terminal.
- Source label mapped to user terms: `MANUAL → "Started by you"`, `SCHEDULE → "On a schedule"`, `WEBHOOK → "From a webhook"`, `EVENT → "From an event"`.
- `lastRun` from the runs list (§3).

### (6) API dependencies (exact)
- Launch: **`POST /workflows/:id/run`** `{trigger?, dryRun?}` → **201** `WorkflowRunDto` (note: **no** `deduplicated`/`queued` fields; response is a bare run).
- Stop (WAITING only): **`POST /approvals/:id/reject`** `{note?}`.
- Status source: the shared `GET /workflows/runs/:runId` poll (owned by RunCanvasLayer / Timeline; RunBar reads the same cache).
- Pre-check for `canRun`: RUN-restriction returns **403** at enqueue — reflected by disabling Run with reason rather than a failed call where known.

### (7) Responsive behaviour
- **Desktop**: full inline bar, all controls visible; collapsed `h-11`, expanded hands to the `h-72` Timeline.
- **Tablet**: primary Run/Test inline; Stop/Run-again/History fold into a ⋯ overflow.
- **Mobile**: RunBar becomes the top of the full-screen run monitor; **Run/Test hidden** (editing/launching is desktop-first) but **status, elapsed, and Approve/Reject remain** so a manager can monitor and decide.

### (8) Keyboard behaviour
- `⌘⏎` Test, `⌘⇧⏎` Run (open popover pre-set). `⌘J` toggles the Timeline dock. Within the Run popover: Tab through trigger field → dryRun toggle → Confirm; Esc closes. Stop/Run-again are reachable via Tab and have visible focus rings; Enter/Space activate.

### (9) Accessibility
- Status pill is a `role="status"` (`aria-live="polite"` implicit) reusing the visible string; elapsed announced only on terminal transition (not every tick).
- Controls are real `<button>`s with descriptive labels (*"Stop this run by rejecting its approval"* when that's the actual mechanic — honest, not "Cancel"). Disabled controls expose `aria-disabled` + a reason via `aria-describedby`.

### (10) Loading state
- `launching`: Run/Test show inline spinner text *"Starting…"*, disabled to prevent double-submit; on 201 the bar swaps to `active` and Watch engages.
- Idle skeleton: a single shimmer line while the runs list resolves for the "Last run" summary.

### (11) Error state
- Launch **403** (RUN-restricted): inline *"You're not set up to run this workflow."*, Run stays disabled with that reason.
- Launch **404** (archived): *"This workflow isn't here anymore."* → Locked banner.
- Launch **429**: *"Give it a moment — too many requests just now."* with a retry-after countdown.
- Bad trigger JSON: inline under the popover field *"That trigger isn't valid JSON."* (client parse, blocks submit).
- Stop/reject errors reuse §1A's 403/409 copy.

### (12) Disabled state
- Run/Test disabled in Watch & Locked and when `!canRun` (each with its reason).
- **Stop disabled with reason whenever the run is not a WAITING approval this user can reject** — tooltip: *"A running workflow can't be stopped mid-step yet. You can stop it at an approval."* (This is the truthful shipped limit — no cancel route.)
- **Compensate** always disabled: *"Rolling back a run isn't available yet."*
- Run-again disabled while a run is still active (avoids concurrent confusion) — enabled on terminal.

---

## 2. `DebugPanel` — per-step drill-down ("why did this node do that")

### (1) Purpose
The right-dock inspector variant shown in Watch mode for a selected step: the honest post-mortem of one node — its status, the config it ran with, what it returned, tool calls it made, its error + failure class + correlation id, and derived timing. It answers "why did this node do that" using **only** fields that exist on `WorkflowStepRun` (+ `WorkflowStepAttempt` when present), and is explicit about the one thing the platform can't yet show verbatim: fully-resolved template values.

### (2) States
- **empty** — Watch mode, no step selected → *"Pick a step to see what happened."*
- **loaded-succeeded** — step `COMPLETED`; input/output/timing shown.
- **loaded-failed** — step `FAILED`; error + `failureClass` + correlation id foregrounded.
- **loaded-waiting** — step is the paused approval; shows who can decide, `dueAt`, escalation, `resumeNodeId` (read-only, sourced from the ApprovalRequest).
- **loaded-running** — step `RUNNING`; output pending, live.
- **loaded-skipped** — step `SKIPPED` (e.g. a branch not taken).
- **dry-run-step** — TOOL_ACTION under a Test run; output framed "preview / not sent."
- **truncated-output** — `output.truncated===true`; shows preview + size + authorised full-view link.
- **attempts-available** — attempt sub-rows render (state-machine runs only); otherwise a quiet *"Ran once (no retries)."*

### (3) Interactions
- Selecting a node (canvas click, Outline Enter, or Timeline row) loads that step into the panel.
- Tabs within the panel: **Summary · Input · Output · Tool calls · Attempts** (Attempts hidden when no attempt data).
- Input/Output are collapsible JSON viewers (mono, read-only) with copy-to-internal (never OS clipboard for config, per secret discipline).
- A **"Template resolution"** disclosure explains before/after honestly (see Data): shows raw `config` (before) and, where reconstructable, the value; for gated tools it shows the **resolved `args`** from the ApprovalRequest (the one place resolved values are persisted). Where it can't reconstruct, it says so rather than faking it.
- Correlation id has a copy button for log correlation.
- On a failed step, "See the run's error" links to the run-level `error`/`failureClass`.

### (4) Props (typed shape)
```ts
interface DebugPanelProps {
  runId: string;
  step: WorkflowStepRunDto | null;   // { id, runId, nodeId, type, status, input, output, error, startedAt, finishedAt, createdAt }
  node: RunLayerNode | null;         // human label, category, highRisk (for framing/copy)
  run: Pick<WorkflowRunDto,'dryRun'|'failureClass'|'error'|'correlationId'|'resumeNodeId'>;
  approvalForStep: ApprovalRequestDto | null;   // when this step is the paused approval / gated tool
  toolExecutions: SkillExecutionSummary[];      // joined by runId, filtered to this nodeId when possible
  attempts?: StepAttemptSummary[];              // present ONLY on state-machine runs; else undefined
}
```

### (5) Data requirements
- **Step**: `type`, `status`, `input` (the node's **raw config snapshot captured at enqueue — pre template-resolution**), `output` (result, or `{truncated,originalBytes,preview}` past 256KB), `error`, `startedAt`, `finishedAt`.
- **Timing**: derived `finishedAt − startedAt` (per step; per attempt when present). No stored duration, **no token/cost columns** — never show a cost panel.
- **Failure**: `run.failureClass` (open **string** set: `NODE_ERROR|CONNECTOR_UNAVAILABLE|RATE_LIMITED|TIMEOUT|APPROVAL_REJECTED|BUDGET_EXCEEDED|SUBSCRIPTION_BLOCKED|VALIDATION_ERROR|CANCELLED|INTERNAL|AUTHORIZATION_DENIED` — treat as open), plus per-attempt `failureClass`/`outcomeUnknown` when attempts exist.
- **`outcomeUnknown`** (attempt-only, reaper-set): render distinctly as the `status-timeout` color + `help-circle` glyph + copy *"outcome unknown — a person should check,"* **never** a plain failure. (Only appears if attempt data is present, which today it is not for live legacy runs.)
- **Tool calls**: `SkillExecution` rows joined by `runId`; a gated tool's **resolved `args`** live on the `ApprovalRequest.args`.
- **Template resolution honesty**: resolved `{{a.b.c}}` values are **not persisted** as an artifact. The panel reconstructs "after" from (raw `config` + `run.context`) where feasible, shows resolved `args` for gated tools, and otherwise states *"We show the settings this step ran with. The filled-in values aren't recorded separately."* — no fabricated resolution trace.
- **WAITING approval detail**: `assigneeUserId` or `approverRuleType`/`approverRuleValue`, `dueAt`, `slaMinutes`, `escalationTier`, `autoDecided`, `escalatedToId`, request `description`, and `run.resumeNodeId` (where it continues).

### (6) API dependencies (exact)
- Primary: the shared **`GET /workflows/runs/:runId`** poll supplies `steps[]` (no separate step endpoint exists).
- Tool calls: joined from `SkillExecution` — surfaced through the run read where available; **no dedicated `/runs/:id/tool-calls` route** (if unavailable in the DTO, the Tool-calls tab shows the gated-tool `args` from the approval and otherwise says *"No tool calls recorded for this step."*).
- Approval detail: **`GET /approvals/:id`** (id from `approvalForStep`), and history via **`GET /approvals/:id/history`**.
- Attempts: **no shipped endpoint** — the Attempts tab is present only if attempt data arrives via a future `GET /workflows/runs/:runId/attempts`; today it renders *"Ran once (no retries)."*

### (7) Responsive behaviour
- **Desktop**: right dock 360px, tabbed.
- **Tablet**: overlay sheet from the right (scrim), 88% width.
- **Mobile**: full-screen sheet, read-only; tabs become a stacked accordion; JSON viewers wrap and are horizontally scrollable.

### (8) Keyboard behaviour
- Opens on `Enter` over a focused node/Timeline row. Within: Tab cycles tab headers (arrow keys move between tabs, `role="tablist"`), Tab into JSON viewer (focusable, read-only), Esc closes → focus returns to the originating node/row. Copy buttons are Tab-reachable, Enter/Space activate.

### (9) Accessibility
- Panel is a labelled region `aria-label="Step details: {human node label}"`. Tabs use `role="tablist"/"tab"/"tabpanel"` with `aria-selected`. JSON viewers are `role="group"` with an accessible name ("Settings this step ran with" / "What this step returned"); large payloads get `aria-describedby` noting truncation.
- Status and failure class render as glyph + text (never color-alone); `outcomeUnknown` gets an explicit SR sentence.
- No sensitive value is exposed that the server didn't already send; secret pickers/values are never reconstructed here.

### (10) Loading state
- Selecting a step whose snapshot isn't cached: 3 field-shaped shimmer blocks (matching the Inspector loading pattern), `aria-busy`. For a `RUNNING` step, Output shows a quiet *"Working…"* placeholder that resolves on the next poll.

### (11) Error state
- Missing/purged step (**404/410**): *"This step's details aren't available."* / retention copy — not a generic error.
- Truncated output: banner *"Output was large — showing a preview ({originalBytes} bytes total)."* + an authorised "view full" affordance (gated; only if a full-view route exists, else the link is absent).
- Approval fetch failure: the WAITING detail block shows *"Couldn't load the approval details. Retry."* without collapsing the rest of the panel.
- A failed step always shows `error` + `failureClass` in plain words (e.g. `CONNECTOR_UNAVAILABLE` → *"A connection wasn't available."*, `BUDGET_EXCEEDED` → *"This employee hit its monthly budget."*, `APPROVAL_REJECTED` → *"Someone rejected the approval."*) — errors are specific, never *"Something went wrong."*

### (12) Disabled state
- Read-only throughout (a debug view never edits config). Copy buttons disabled when there's nothing to copy. In a dry-run, the Tool-calls tab is disabled with *"No tools ran — this was a test."* The Attempts tab is disabled/absent with *"Ran once (no retries)."* when no attempt data exists.

---

## 3. `RunHistory` — past runs list + open/replay + controls

### (1) Purpose
The "History" surface (Run Bar `History ▾`, and the Timeline dock's History tab) listing a workflow's past runs — status, trigger source, who, started/finished, derived duration — where opening a run replays its visualisation (§1A) + timeline, and where the honest set of per-run actions lives (open, run-again, stop-if-waiting).

### (2) States
- **loading** — skeleton rows.
- **empty** — invitation: *"No runs yet. Hit Test to try it safely, or Run to go live."*
- **loaded** — reverse-chronological list (`createdAt desc`).
- **filtered-empty** — filter yields nothing: *"No runs match this filter."* + clear-filter.
- **row-active** — a listed run is still `PENDING|RUNNING|WAITING` (live badge, its own poll if opened).
- **error** — list fetch failed.

### (3) Interactions
- **Open a run** → sets `runId`, navigates to `/workflows/:id?run=:runId`, flips to Watch, RunCanvasLayer + Timeline replay it (canvas pinned to that run's version).
- **Run again** (on a terminal row) → `POST /workflows/:id/run`, optionally re-using that run's `trigger`.
- **Stop** — enabled only on a `WAITING` row the user can reject → `POST /approvals/:id/reject`.
- **Retry / Compensate** — rendered disabled with reason (no HTTP route; retry = Run again).
- **Filters**: client-side over the fetched array — by status (`COMPLETED|FAILED|WAITING|RUNNING|PENDING`), by source (`MANUAL|SCHEDULE|WEBHOOK|EVENT`), and dry-run vs live. (No server filter/cursor params exist — list is `?limit=` only, bare array.)
- Row shows a "Test run" tag when `dryRun`.

### (4) Props (typed shape)
```ts
interface RunHistoryProps {
  workflowId: string;
  runs: WorkflowRunSummary[];  // WorkflowRunDto[] WITHOUT steps
  isLoading: boolean;
  error: NormalizedApiError | null;
  activeRunId: string | null;
  filter: { status?: WorkflowRunStatus; source?: TriggerType; dryRun?: boolean };
  onFilterChange: (f: RunHistoryProps['filter']) => void;
  onOpenRun: (runId: string) => void;
  onRunAgain: (fromRun?: WorkflowRunSummary) => void;
  onStopViaReject: (runId: string) => void;   // resolves the run's PENDING approval id, then rejects
}
```

### (5) Data requirements
- Per row (from `WorkflowRunDto` sans steps): `id`, `status`, `source`, `dryRun`, `startedAt`, `finishedAt`, `createdAt`, `error`, `failureClass`, and **who** — `MANUAL` → the clicking user (`startedByUserId`); `SCHEDULE|EVENT|WEBHOOK` → run-as the pinned version's publisher (label as *"On a schedule" / "From an event" / "From a webhook"* rather than a person). `EVENT` also carries `triggerEventId` for lineage (shown as a subtle "from event" chip).
- Duration derived `finishedAt − startedAt`; for still-active rows, "running for {elapsed}".
- Status mapped to Spine glyph+color+plain words; `WAITING` = *"Waiting on a person."*
- Note: only `PENDING/RUNNING/WAITING/COMPLETED/FAILED` are produced today; `CANCELLED/COMPENSATING/TIMED_OUT` may exist in the enum but the list treats the status set as open and renders any value via the Spine status map.

### (6) API dependencies (exact)
- List: **`GET /workflows/:id/runs?limit=`** → **bare `WorkflowRunDto[]`** ordered `createdAt desc` (default 50 / max 200; **no cursor, no status/source/q filters** — filtering is client-side).
- Open/replay: drives the shared **`GET /workflows/runs/:runId`** (with steps) + version pin as in §1A.
- Run again: **`POST /workflows/:id/run`**.
- Stop: resolve the run's PENDING approval via **`GET /approvals?status=PENDING`** (filter `workflowRunId`), then **`POST /approvals/:id/reject`**.
- Query keys: extend the factory — `workflowKeys.runs(id)` for the list, `workflowKeys.run(runId)` for a run; list refetch on window-focus off (global default), but a row that is active shares the 1s poll when opened.

### (7) Responsive behaviour
- **Desktop**: table-like rows in the Timeline History tab or a popover from `History ▾` (status · source · who · started · duration · actions).
- **Tablet**: condensed rows; secondary actions in a per-row ⋯.
- **Mobile**: **primary screen** — full-height list is the main run view; tapping a row opens the mobile run monitor (Outline + Timeline + Debug sheet). Filters collapse into a single filter sheet.

### (8) Keyboard behaviour
- List is a `role="list"`; rows Tab-focusable, Enter opens, ⇧F10/Menu opens the row action menu (Open / Run again / Stop). Filters are standard selects/toggles, Tab-reachable. Focus returns to the originating row after closing a menu.

### (9) Accessibility
- Each row `aria-label` = plain-language summary: *"Run started by you, 2 minutes ago, completed in 41 seconds."* / *"Scheduled run, waiting on a person."* / *"Test run, failed — a connection wasn't available."*
- Status is glyph + text. Live rows announce status changes only when the row (or its opened run) is focused, via the shared live region — the list itself doesn't spam.
- Action buttons carry honest names and disabled reasons (Stop = *"Stop by rejecting its approval"*; Retry disabled → *"Start a new run instead"*).

### (10) Loading state
- Row skeletons (reuse the existing list skeleton pattern), `aria-busy`. Filters render immediately but are inert until data resolves.

### (11) Error state
- List **fetch error**: inline *"Couldn't load past runs. Retry."* (retry button), never blanks silently.
- **410** on opening a purged run: retention copy in the run view.
- **429**: *"Give it a moment — too many requests just now."*
- A failed run's row shows its `failureClass` in plain words inline (no need to open it to see *why* at a glance).

### (12) Disabled state
- **Empty**: the two invitation CTAs (Test / Run), not a dead end.
- **Run again** disabled while that workflow already has an active run (avoids concurrent confusion) and in Locked/archived (*"This workflow is archived."*).
- **Stop** disabled on every non-`WAITING` row with reason *"Only a run waiting on an approval can be stopped."*
- **Retry / Compensate** permanently disabled with reason (*"Start a new run instead." / "Rolling back a run isn't available yet."*) — these map to routes that do not exist, and the UI says so plainly rather than offering a control that would 404.

---

### Cross-cutting honesty notes (so the build team doesn't over-promise)
1. **Realtime ships dark.** Build the 1s `isActive` poll first; the `RealtimeStatus` pill shows `polling-fallback` until a WS gateway exists. `seq`/gap-refetch logic is written but exercised only once the gateway lands.
2. **Attempts, token/cost, lane/iteration grouping, compensation, TIMED_OUT/COMPENSATING visuals, sub-run trees** are all **absent from the shipped schema/engine for live runs** — none of these components render them from thin air; each degrades to the `WorkflowStepRun`-only truth and says so.
3. **The only run "controls" that actually reach the backend** are: launch (`POST /run`), and stop-a-WAITING-run-by-rejecting-its-approval (`POST /approvals/:id/reject`). Everything else labelled "cancel/retry/compensate" is a disabled control with an honest reason, per the honesty-over-mockup discipline.
4. **Template "before/after"** is partial by construction (resolved values aren't persisted except gated-tool `args`) — the Debug Panel states this rather than faking a resolution trace.

Key files these components reshape (absolute): `D:/Vertical AI/platform/apps/web/src/features/workflows/components/ExecutionTimeline/` (new — RunBar + RunHistory + DebugPanel live alongside the Timeline), `.../components/WorkflowCanvas/` (RunCanvasLayer overlay), `.../features/workflows/{hooks.ts,api.ts,labels.ts}` (add `useRunTimeline`, `getRunTimeline` wrapping `GET /workflows/runs/:runId`, run-status plain-word maps), consuming `.../app/(app)/workflows/[id]/page.tsx` in Watch mode.


---

## 3.G — Lifecycle & system states (version history · publish · errors · empty · loading · disabled)

# CLUSTER SPEC — Lifecycle + System States (Workflow Builder)

*Orlixa V-AEP. Dark canvas (`#02030A`), violet (`#5E3CE8`), gold gate (`#F0B90D`). Inherits all tokens, node visual language, status colors, and the app-wide inline-feedback / skeleton / Modal patterns from the Design Spine — this doc only adds lifecycle-specific detail. No React code. All endpoints verified against the shipped API surface (Ground brief C).*

---

## 0. Ground-truth reconciliations this cluster is built on (read first)

These bind every component below — they resolve the doc-vs-code drifts so nobody codes against a route that doesn't exist:

1. **No diff endpoint.** `GET .../versions/:a/diff/:b` is **not shipped**. "Diff-at-a-glance" is **computed client-side** from two `WorkflowVersionDto.definition` payloads (a pure `diffDefinitions(a,b)` util) — never an API call.
2. **No rollback/restore/clone route.** `POST .../rollback` / `/clone` are **not shipped**. "Restore this version" and "Duplicate as draft" both resolve to: read `GET /workflows/:id/versions/:version` → write `PUT /workflows/:id/draft { definition }` (which overwrites the single mutable DRAFT). This is the *only* honest mechanism — surface it as "Copy this version into your draft," never as an atomic server rollback.
3. **Publish-invalid is `400`, not `422`.** `POST /workflows/:id/publish` throws `400` (`BadRequestException` from `validateDefinitionStructure`) with `message: string[]`. `422` in this whole surface belongs **only** to template install prereqs (§Errors). "Nothing to publish" is also `400`.
4. **Publish returns `{ version, unchanged }`** — republishing a byte-identical graph returns `unchanged:true` with **no** new version. The confirm flow must handle "nothing changed" gracefully.
5. **Activate precondition is "≥1 non-TRIGGER node" (`400` otherwise)** — NOT "has a PUBLISHED version." Do not gate Activate on publish state; gate it on node count + trigger-config validity, matching shipped `POST /workflows/:id/activate`.
6. **Deactivate = pause.** `POST /workflows/:id/deactivate` → `PAUSED`. There is no `/pause` route.
7. **Draft save concurrency:** explicit Save uses `PATCH /workflows/:id { definition, expectedUpdatedAt, position }` → **409** on mismatch. Autosave draft uses `PUT /workflows/:id/draft { definition }`. The 409 reload path clears the undo stack.
8. **No custom error envelope.** Every error is bare Nest `{ statusCode, message, error }`; `message` may be `string[]`. The web app already normalizes to `NormalizedApiError { status, message, raw }` (joins arrays). All components consume that, typed `useQuery<T, NormalizedApiError>`.
9. **No toast primitive, none added.** Success/error = **inline text** (`Saved.` emerald / red message), and the `aria-live` region reuses those exact strings. Destructive confirms use `window.confirm`. The focus-trapped `Modal` (`role="dialog" aria-modal="true"`) is the only overlay primitive — first consumers here are `PublishConfirmModal` + `VersionRestoreModal`.

**The lifecycle spine every component renders against:**

```
        edit ────autosave (PUT /draft)────►  DRAFT (one mutable scratchpad)
                                                │  Publish (POST /publish, gate: V-checks pass)
                                                ▼
   DEPRECATED ◄──prior active──  PUBLISHED v_n  ──points to──►  Workflow.activeVersionId
                                                │  Activate (POST /activate, gate: ≥1 non-TRIGGER + trigger valid)
                                                ▼
                                    ACTIVE (trigger armed) ⇄ PAUSED (deactivate)
                                                                         ARCHIVED (soft-delete)
```

Two orthogonal axes the UI must never conflate:
- **Version status** (`DRAFT | PUBLISHED | DEPRECATED | ARCHIVED`) — *what graph is this.*
- **Workflow status** (`DRAFT | ACTIVE | PAUSED | ARCHIVED`) — *is its trigger armed and firing.*

A workflow can be `ACTIVE` (trigger firing) while you edit a `DRAFT` version underneath it — publishing swaps the frozen graph without disarming the trigger. Making that legible is the core job of this cluster.

---

## 1. `LifecycleBadge` — the one canonical status chip (used everywhere)

### (1) Purpose
The single, reused representation of *both* lifecycle axes wherever a workflow or version appears (list row, toolbar breadcrumb, version history row, watch banner). One component, two `kind`s, so "DRAFT" always looks the same in every surface.

### (2) States
`kind:'workflow'` → `DRAFT · ACTIVE · PAUSED · ARCHIVED`. `kind:'version'` → `DRAFT · PUBLISHED · DEPRECATED · ARCHIVED`, plus a `current` flag ("Active version" ring when the version id equals `Workflow.activeVersionId`). Optional `dirty` flag (draft has unsaved/unpublished edits) → appends a `•` un-published dot.

### (3) Interactions
Non-interactive by default (pure label). When `href` prop is set (version row → open read-only viewer) the whole chip is a link with hover `border-hover`. Hover shows a `title`/tooltip spelling out the meaning ("Live — its trigger is armed and firing").

### (4) Props
```ts
type LifecycleBadgeProps = {
  kind: 'workflow' | 'version';
  status: WorkflowStatus | WorkflowVersionStatus;
  current?: boolean;          // version only: is Workflow.activeVersionId
  dirty?: boolean;            // draft has edits not yet published
  size?: 'sm' | 'md';         // sm=caption 11px (rows), md=13px (toolbar)
  href?: string;
};
```

### (5) Data requirements
Pure props. Caller derives `current` by comparing `version.id === workflow.activeVersionId`; derives `dirty` by comparing `draftVersion.definition` to `activeVersion.definition` (or "draft.updatedAt > lastPublishedAt").

### (6) API dependencies
None (presentational). Consumers source from `useWorkflow(id)` (`GET /workflows/:id`) and `GET /workflows/:id/versions`.

### (7) Responsive
Identical all breakpoints; `size:'sm'` on mobile rows. Never wraps — text is one token; long words impossible (fixed vocabulary).

### (8) Keyboard
Non-link: not focusable. Link variant: standard `<a>` in tab order, Enter/Space activates, `focus-visible` violet ring.

### (9) Accessibility
Renders as text, not color-only: each status has a distinct dot glyph + word. `aria-label` expands the meaning for SR (e.g. `PUBLISHED current` → "Published version 4, the one currently live"). Color mapping reuses `WORKFLOW_STATUS_STYLES` / version tokens; never conveys status by hue alone.

Color/word map (word is authoritative):
| status | dot | word | token |
|---|---|---|---|
| DRAFT | `circle-dashed` | Draft | `text-secondary` on `surface-card` |
| PUBLISHED | `check-circle` | Published | `feedback-ok` #34D399 |
| ACTIVE | `zap` (filled) | Live | `violet` #5E3CE8 |
| PAUSED | `pause` | Paused | `gold` #F0B90D |
| DEPRECATED | `history` | Superseded | `text-muted` |
| ARCHIVED | `archive` | Archived | `status-cancel` #64748B |

### (10) Loading
When the parent is loading, render a 56×20 shimmer pill (`surface-card-hover` pulse), never a bare word.

### (11) Error
No own error. If status is somehow unknown (future enum), fall back to the raw string in `text-muted` with `circle` dot rather than crashing.

### (12) Disabled
N/A (a label). The `dirty •` is informational, not a control.

---

## 2. `VersionHistoryPanel` — the version list

### (1) Purpose
A right-dock (or Modal on tablet/mobile) panel listing every version of a workflow newest-first, with which one is live, who published it, when, the change note, a client-computed "what changed" summary vs the prior version, and the actions **View (read-only)**, **Copy into draft (restore)**, and **Compare**. This is the "time machine" for the workflow's frozen graphs.

### (2) States
`loading` (skeleton rows) · `loaded` · `empty` (only a DRAFT exists, never published) · `error` · `single` (v1 only — no diff possible) · `viewing` (a row is selected, canvas pinned read-only to that version) · `comparing` (two rows selected → diff view). A per-row `restoring` (optimistic) sub-state.

### (3) Interactions
- Row click → opens that version in **read-only Watch mode** on the canvas (`?version=n`), row gets violet selected ring; breadcrumb shows "Viewing v3 (read-only)."
- Row `⋯` menu (always-visible button, not hover-only): **View**, **Copy into draft…**, **Compare with current draft**, **Copy change note**.
- Multi-select via a "Compare" toggle: pick exactly two versions → diff panel replaces the list.
- "Copy into draft" → opens `VersionRestoreModal` (§3) confirm, because it overwrites the live draft.
- Newest row pinned; "Active version" carries the `current` ring.

### (4) Props
```ts
type VersionHistoryPanelProps = {
  workflowId: string;
  activeVersionId: string | null;
  draftVersionId: string | null;
  currentDraftDefinition: WorkflowDefinition; // for "compare with draft"
  onViewVersion: (version: number | 'draft') => void; // pins canvas
  onClose: () => void;
  readOnly: boolean; // true in Watch/Locked → hides "Copy into draft"
};
```

### (5) Data requirements
Ordered `WorkflowVersionDto[]` (`version desc`), each `{ id, version, status, publishedAt, publishedById, changeNote, definition, createdAt }`. Resolve `publishedById` → display name via the members cache (fallback "Someone" if unresolved — never render a raw user id). Diff computed from adjacent `definition`s.

### (6) API dependencies
- `GET /workflows/:id/versions` → `WorkflowVersionDto[]` (hook `useWorkflowVersions(id)`, key `['workflows', id, 'versions']`).
- `GET /workflows/:id/versions/:version` → single (lazy, on View/Compare) — key `['workflows', id, 'version', n]`.
- Restore path: `PUT /workflows/:id/draft { definition }` (`useSaveDraft`). **No** diff/rollback endpoints.
- Publisher names: existing members query (reuse whatever `useAppShellProps`/org members hook exists).

### (7) Responsive
Desktop: right dock 360px, sits where Inspector docks (mutually exclusive with Inspector — opening Version History deselects any node). Tablet: scrimmed overlay sheet from right, 88% width. Mobile: full-screen list via a `Modal`; View pins the Outline (mobile has no editable canvas) to that version read-only.

### (8) Keyboard
Panel is a `role="region"` with `aria-label="Version history"`. Rows are a `role="listbox"` (single-select) / arrow-key navigable; Enter = View; `⇧F10`/Menu opens the row `⋯`. In Compare mode rows become `aria-multiselectable` checkboxes (Space toggles, max 2). Esc closes the panel and returns focus to the toolbar `⋯ → Version history` trigger.

### (9) Accessibility
Each row `aria-label` = human sentence: *"Version 4, live, published by Priya, 2 days ago. 3 steps changed."* The `current` version announced as "currently live." Diff summary chips have text labels, not color-only. `aria-live="polite"` announces "Copied version 3 into your draft" after restore.

### (10) Loading
4 row-skeletons (title bar + meta line + 2 diff-chip placeholders), `aria-busy`. Panel frame renders immediately; only the list body shimmers. View action disabled while a specific version fetch is in flight (spinner-in-button is disallowed → row shows an inline "Loading version…" text).

### (11) Error
- List `GET` fails → inline in-panel: *"Couldn't load version history. Try again."* + Retry (refetch). Reuses `NormalizedApiError.message`.
- **404** (workflow purged/cross-tenant) → *"This workflow isn't here anymore."* + link back to `/workflows`.
- Single-version fetch fail → row shows red inline *"Couldn't open this version."*, panel list stays usable.

### (12) Disabled
- "Copy into draft" disabled in `readOnly` (Watch/Locked) with tooltip *"You're viewing a run — switch to editing to change the draft."*
- "Compare" disabled when only one version exists (tooltip *"There's only one version so far."*).
- Restore of the version whose definition is byte-identical to the current draft → disabled, tooltip *"Your draft already matches this version."*

---

## 3. `VersionRow` + `VersionDiffSummary` (the row internals)

### (1) Purpose
One version's line: `LifecycleBadge(kind:'version')`, `v{n}`, publisher + relative time, change note (truncated), and a `VersionDiffSummary` — the at-a-glance "what changed vs the previous version," computed client-side.

### (2) States
`idle · hover · selected · current (live) · restoring (optimistic) · restore-error`. Diff summary sub-states: `computing` (very brief, sync so usually skipped) · `no-change` ("Republished, no changes") · `changes`.

### (3) Interactions
Row body click = View. Change note expands on click (line-clamp-2 → full) without triggering View (stopPropagation). `⋯` = the row menu (§2.3). Diff chips are not individually clickable in v1 (they summarize; the full diff is Compare mode).

### (4) Props
```ts
type VersionRowProps = {
  version: WorkflowVersionDto;
  prev?: WorkflowVersionDto;         // for diff; absent on v1
  isCurrent: boolean;
  isSelected: boolean;
  publisherName: string | null;
  disabledRestoreReason?: string;
  onView: () => void;
  onRestore: () => void;
  onCompare: () => void;
};

type DefinitionDiff = {
  addedNodes: string[]; removedNodes: string[]; changedNodes: string[]; // node ids
  addedEdges: number; removedEdges: number;
  triggerChanged: boolean;
};
```

### (5) Data requirements
`diffDefinitions(prev.definition, version.definition)` → `DefinitionDiff`, rendered as up-to-4 chips: `+2 steps` (emerald), `−1 step` (red), `3 changed` (violet), `rewired` (slate, when edges changed). Node labels resolved via `NODE_LABELS` + employee/tool naming for the tooltip ("Added: Emma reviews the application").

### (6) API dependencies
None directly — consumes data passed from `VersionHistoryPanel`. Restore triggers `PUT /workflows/:id/draft` via the parent.

### (7) Responsive
Desktop/tablet: single row, meta on one line. Mobile: two-line stack (title+badge row, then meta+chips), 44px min touch target for row + `⋯`.

### (8) Keyboard
Row is the listbox option (§2.8). `⋯` reachable via `⇧F10`. Change-note expand toggled with Enter when the note is focused (it's a `<button>` disclosure with `aria-expanded`).

### (9) Accessibility
Diff chips have `aria-label` full text, not just "+2". `current` row has `aria-current="true"`. Relative time has a `<time datetime>` with the absolute time in `title`.

### (10) Loading
Inherited skeleton from parent. Individual restore → row shows inline *"Copying into your draft…"* text (no spinner-only).

### (11) Error
Restore fail → row inline red: maps `NormalizedApiError` — **409** *"Your draft changed somewhere else. Reload and try copying again."*; **400** (would-be-invalid draft, rare) *"That version can't be copied as-is — it has a step that's no longer available."*; generic *"Couldn't copy this version. Try again."*

### (12) Disabled
Restore disabled per `disabledRestoreReason` (matches current draft / read-only). The `current` (live) version's restore is allowed (you may want to re-draft from live) but labeled "Copy the live version into your draft."

---

## 4. `VersionViewer` (read-only pin) — reuse of Watch/Locked canvas

### (1) Purpose
When a user opens a past version, the canvas pins to that frozen `WorkflowVersion.definition`, fully read-only, with a persistent banner making the read-only + which-version state unmistakable. This is not a new canvas — it's `WorkflowCanvas` in `readOnly` with a version source instead of a run source.

### (2) States
`viewing-version` (a historical or deprecated version) · `viewing-draft` (current draft, editable — so this state just exits the viewer) · `viewing-active` (the live version). Banner variants per which.

### (3) Interactions
Read-only: pan/zoom/select-to-inspect allowed; move/connect/delete/edit all suppressed. Banner primary action: **"Copy into draft to edit"** (→ VersionRestoreModal) or **"Back to draft"** (exit viewer, `?version` removed). Selecting a node opens Inspector in read-only.

### (4) Props
```ts
type VersionViewerBannerProps = {
  version: number;
  status: WorkflowVersionStatus;
  isCurrent: boolean;
  publisherName: string | null;
  publishedAt: string | null;
  onBackToDraft: () => void;
  onCopyIntoDraft: () => void;
  canEdit: boolean; // false in Locked/insufficient perms
};
```

### (5) Data requirements
`WorkflowVersionDto.definition` → `{nodes,edges}` for the canvas; no run overlay (versions have no run status). `position` per node comes from the definition.

### (6) API dependencies
`GET /workflows/:id/versions/:version`. Copy-into-draft → `PUT /workflows/:id/draft`.

### (7) Responsive
Desktop/tablet: full canvas, banner sticky under the toolbar. Mobile: Outline tree pinned to the version (read-only), banner as a top strip.

### (8) Keyboard
Canvas remains `role="application"` but `aria-readonly="true"`; Tab still walks nodes to inspect; editing keys are no-ops with an `aria-live` note on first attempt: *"You're viewing version 3. Copy it into your draft to make changes."* Esc → Back to draft.

### (9) Accessibility
Banner `role="status"`. Canvas `aria-label` includes "read-only, version 3." Every node's `aria-label` appends "read-only."

### (10) Loading
Canvas shows the dim node-skeleton at dagre-estimated positions + "Loading version 3…"; blocks interaction (`aria-busy`).

### (11) Error
Version fetch fail → full-canvas empty state: *"Couldn't open version 3."* + Retry + "Back to draft." **410** (retention/purged version, if ever) → retention copy, not generic.

### (12) Disabled
All edit affordances disabled with the single shared reason *"You're viewing a saved version. Copy it into your draft to edit."* "Copy into draft" itself disabled when `!canEdit` (tooltip *"You don't have permission to edit this workflow."*).

---

## 5. `PrePublishValidationPanel` — the publish gate

### (1) Purpose
The blocking gate shown when the user hits Publish (⌘⇧P): runs the same structural validation the server enforces, lists every blocking issue grouped per node in plain language, and lets the user jump straight to the offending node. Publish cannot proceed while blockers exist. This is where V1/V4/V5/V6/V7/V8/V11/V12 + edge/id/type checks surface.

### (2) States
`validating` (brief) · `clean` (0 issues → hands off to `PublishConfirmModal`) · `blocked` (≥1 issue) · `warnings-only` (server `warnings[]` present but no blockers — publishable, shown as advisory) · `server-rejected` (optimistic client check passed but server `400` returned issues we didn't catch → reconcile and show them).

### (3) Interactions
- Opens as a right-dock panel (not modal — user needs the canvas to fix issues). Each issue row: plain-language message + node chip; click → selects + centers that node (violet-error ring) and opens its Inspector with the offending field red-underlined.
- "Re-check" button re-runs client validation after edits (also auto-re-runs on canvas change, debounced).
- When `blocked → clean`, the panel's footer button flips from disabled "Fix issues to publish" to enabled "Publish…" → opens `PublishConfirmModal`.
- Warnings render collapsed under "Publish anyway" affordance (non-blocking).

### (4) Props
```ts
type ValidationIssue = { nodeId: string | null; code: string; message: string };

type PrePublishValidationPanelProps = {
  workflowId: string;
  issues: ValidationIssue[];        // client-computed, reconciled with server
  warnings: string[];               // from WorkflowDto.warnings
  isValidating: boolean;
  onJumpToNode: (nodeId: string) => void;
  onRecheck: () => void;
  onProceed: () => void;            // → PublishConfirmModal
  onClose: () => void;
};
```

### (5) Data requirements
Client mirror of `collectDefinitionIssues()` producing `{nodeId, code, message}` with the exact codes. Code→plain-language map (authoritative copy):

| code | plain message | jump target |
|---|---|---|
| `SINGLE_TRIGGER_REQUIRED` | "A workflow can only have one start. Remove the extra." | the extra TRIGGER |
| `TRIGGER_NOT_ENTRY` | "The start can't have anything leading into it." | the TRIGGER |
| `DUPLICATE_NODE_ID` | "Two steps share the same id — duplicate one fresh." | either node |
| `UNKNOWN_EDGE_SOURCE` / `UNKNOWN_EDGE_TARGET` | "A connection points to a step that isn't here anymore." | dangling edge |
| `UNKNOWN_NODE_TYPE` | "This step type isn't available. Replace it." | node |
| `UNJOINED_PARALLEL` | "This Split has to meet back at a Merge." | the PARALLEL |
| `PARALLEL_NO_LANES` / `UNKNOWN_LANE_START` | "Give this Split at least one branch to run." | the PARALLEL |
| `NESTED_PARALLEL` | "A Split can't sit inside another Split." | inner PARALLEL |
| `CYCLE_DETECTED` | "These steps loop back on themselves. Only a Loop can point backwards." | first node in cycle |
| `UNBOUNDED_LOOP` | "This loop needs a limit — set how many times it can repeat." | LOOP |
| `INCOMPATIBLE_PLACEMENT` | "An approval can't sit inside a loop — it would ask a person on every pass." | APPROVAL |
| `TERMINATE_HAS_OUTGOING_EDGE` | "Stop is the end — it can't lead anywhere." | TERMINATE |
| `INVALID_CONFIG` | field-specific, e.g. "Tell Emma what to do before publishing." | node + field |
| `SWITCH_NO_CASES` | "This Switch has no branches to choose between." | SWITCH |
| `MISSING_BRANCH_EDGE` | "One branch here doesn't go anywhere yet." | branching node |
| `READ_ONLY_SCOPE` | "You can't write to that kind of value." | SET_VARIABLE |
| `INLINE_SECRET_FORBIDDEN` | "Don't paste a secret here — pick it from your saved connections." | node + field |
| `GRAPH_TOO_LARGE` | "This workflow has more steps than we can publish. Split it up." | panel-level |

### (6) API dependencies
- Publish attempt: `POST /workflows/:id/publish { changeNote? }` → **400** `{ message: string[] }` on invalid; **200** `{ version, unchanged }` on success.
- Client pre-check avoids a round-trip; server 400 is the source of truth — its `message[]` strings are parsed back into issues (best-effort node attribution by code prefix) and shown here so client/server never disagree silently.
- `WorkflowDto.warnings` from `GET /workflows/:id` for advisory "no incoming edge" notes.

### (7) Responsive
Desktop: right dock 360px alongside canvas. Tablet: bottom sheet (so canvas stays visible for jump-to-node), 50% height. Mobile: full-screen list; jump-to-node selects in the Outline (no editable canvas) and shows "Fix on a larger screen" if the fix needs the graph.

### (8) Keyboard
Panel `role="region" aria-label="Publish checks"`. Issue list is a listbox; Enter jumps to node (moves focus to that node on canvas). "Re-check" and "Publish…" in tab order. Esc closes. ⌘⇧P re-opens.

### (9) Accessibility
`aria-live="assertive"` announces the count on open: *"3 things to fix before publishing."* Each issue `role="option"` with full message. When clean: *"All checks passed. Ready to publish."* Error rings on nodes are paired with the issue text (never color-only). Publish button `aria-disabled` with `aria-describedby` pointing at the blocker count.

### (10) Loading
`validating` shows 3 issue-row skeletons + "Checking your workflow…"; sub-second in practice, so mainly covers the server-round-trip reconcile after a Publish click.

### (11) Error
- Publish `400` non-validation (e.g. "Nothing to publish") → panel top strip *"Nothing new to publish — your draft matches the live version."* (this is the `unchanged`/no-draft case; surface as info, not red).
- **409** (workflow ARCHIVED mid-flow) → *"This workflow was archived. You can't publish it."* → Locked mode.
- **403** → *"You don't have permission to publish this workflow."*
- Network/offline → *"You're offline. We'll try again when you're back."* + Retry.

### (12) Disabled
Publish button disabled while `issues.length > 0` (reason: *"Fix {n} issue(s) to publish"*) OR while draft is unchanged since last publish (reason: *"Nothing new to publish"*). Re-check disabled during an in-flight validation. Never a bare disabled button — the reason is always inline beside/under it.

---

## 6. `PublishConfirmModal` — the change-note confirm

### (1) Purpose
The final confirm after checks pass: capture an optional change note and explain in one line what publishing does, then call publish. Publishing a workflow that's already `ACTIVE` swaps the live graph without disarming the trigger — that consequence is stated here.

### (2) States
`idle · submitting (optimistic pending) · success (unchanged=false) · no-change (unchanged=true) · error`. If the workflow is currently `ACTIVE`, an extra "this is live" notice renders.

### (3) Interactions
- Change-note textarea (≤500 chars, optional). Primary "Publish" (violet CTA gradient); secondary "Cancel."
- On success: modal closes, canvas returns to Edit, inline `Saved` → **"Published v{n}."** (green) in the toolbar; the new version appears at the top of Version History; the draft is now equal to the published version (dirty dot clears).
- `unchanged:true` → modal shows *"Nothing changed since v{n} — nothing to publish."*, single "Close."
- If workflow is `ACTIVE`: notice *"This is live — publishing updates what runs from now on. In-flight runs finish on their old version."*

### (4) Props
```ts
type PublishConfirmModalProps = {
  workflowId: string;
  nextVersionNumber: number;      // for the button/label "Publish v5"
  isWorkflowActive: boolean;
  onPublished: (result: PublishWorkflowResultDto) => void;
  onClose: () => void;
};
```

### (5) Data requirements
`nextVersionNumber` derived from current max version + 1 (from versions list). `isWorkflowActive` from `WorkflowDto.status === 'ACTIVE'`.

### (6) API dependencies
`POST /workflows/:id/publish { changeNote?: string(≤500) }` → **200** `PublishWorkflowResultDto { version, unchanged }`. Hook `usePublishWorkflow` (mutation; on success invalidate `['workflows','detail',id]` + versions key). No optimistic version insert (server assigns the number).

### (7) Responsive
Reuses `Modal`: desktop centered 480px; tablet 90% width; mobile full-screen sheet. Textarea min 3 rows.

### (8) Keyboard
Focus-trapped (`role="dialog" aria-modal="true"`). Focus lands on the textarea. ⌘⏎ / Ctrl⏎ submits; Esc cancels (with a "discard note?" only if the note is non-empty — else closes immediately). Tab cycles textarea → Publish → Cancel → textarea.

### (9) Accessibility
`aria-labelledby` = "Publish this workflow"; the live-vs-draft consequence in `aria-describedby`. Submit result announced `aria-live`: *"Published version 5."* / *"Nothing changed — nothing to publish."*

### (10) Loading
`submitting`: Publish button label → "Publishing…", button disabled, textarea disabled, modal not dismissable (Esc suppressed) until settled. Optimistic: toolbar pill shows "Publishing…".

### (11) Error
Maps `NormalizedApiError`: **400** validation (shouldn't happen post-gate, but if it does) → close modal, re-open `PrePublishValidationPanel` with the returned issues + inline *"A couple of checks need another look."* **400** "nothing to publish" → the no-change state. **403** → *"You don't have permission to publish."* **409** archived → *"This workflow was archived."* Network → inline *"Couldn't publish — check your connection and try again."*, note preserved, button re-enabled.

### (12) Disabled
Publish disabled while `submitting`. Change note >500 chars → disabled + counter turns red *"Keep it under 500 characters."*. (The publishability gate already passed upstream, so no gate here.)

---

## 7. `ActivateControl` — arm / pause the trigger (with confirm)

### (1) Purpose
The toolbar control that arms the workflow's trigger (Activate → `ACTIVE`) or pauses it (Deactivate → `PAUSED`), with a confirm that names *how* it will fire (Manual / On a schedule / Webhook / Event) and surfaces the one-active-trigger caveats. Distinct from Publish — Activate is about *whether the trigger fires*, not *what graph runs*.

### (2) States
`inactive (DRAFT/PAUSED, can activate)` · `active (can deactivate)` · `activating` / `deactivating` (optimistic) · `blocked` (precondition unmet) · `error`. Trigger-type-specific confirm variants (SCHEDULE shows the schedule; WEBHOOK will mint/show a URL; EVENT shows the event + connector scope).

### (3) Interactions
- Button label reflects state: **Activate** (violet CTA) when inactive; **Deactivate** (ghost/gold) when active.
- Activate → `ActivateConfirmPopover` (anchored popover, not full modal): shows "This will start firing **{when}**." For SCHEDULE: the cadence. For EVENT/WEBHOOK: the trigger + a one-active caveat if a conflicting active workflow shares the connector. Confirm arms it.
- On activate success: `LifecycleBadge` flips to **Live**; toolbar inline **"Live — trigger armed."**; WEBHOOK reveals the `webhookToken` URL with a copy affordance.
- Deactivate → confirm popover *"Pause this? Its trigger stops firing. Runs already going will finish."* → sets `PAUSED`.
- **One-active-trigger caveat (Gmail/EVENT):** when activating a second EVENT workflow on the same `connectorId`, popover warns *"Another workflow already listens to this connection. Two will double-fire the same email. Scope this to a different connection, or merge them."* with links to (a) trigger editor connector scoping, (b) cancel.

### (4) Props
```ts
type ActivateControlProps = {
  workflow: WorkflowDto;                 // status, triggerType, triggerConfig, webhookToken
  nonTriggerNodeCount: number;           // precondition
  conflictingActiveWorkflow?: { id: string; name: string } | null; // same connector EVENT
  onActivated: (w: WorkflowDto) => void;
  onDeactivated: (w: WorkflowDto) => void;
};
```

### (5) Data requirements
`workflow.status`, `triggerType`, `triggerConfig` (cadence/event/connector), `webhookToken`. `nonTriggerNodeCount` computed from the definition. Conflict detection: scan the tenant's ACTIVE EVENT workflows sharing `triggerConfig.connectorId` (from the workflows list).

### (6) API dependencies
- `POST /workflows/:id/activate` → **200** `WorkflowDto` (mints `webhookToken` for WEBHOOK, arms SCHEDULE BullMQ job). Precondition fail → **400** ("≥1 non-TRIGGER node" / invalid trigger config).
- `POST /workflows/:id/deactivate` → **200** `WorkflowDto` (disarms schedule).
- Hooks `useActivateWorkflow` / `useDeactivateWorkflow` (existing, reused unchanged; optimistic status flip with rollback).

### (7) Responsive
Desktop: inline toolbar buttons. Tablet: primary Activate/Deactivate stays inline; confirm is a centered sheet. Mobile: Activate/Deactivate available (monitor+manage is allowed on mobile), confirm full-screen.

### (8) Keyboard
Button in toolbar tab order. Enter/Space opens confirm popover (`role="dialog"`, focus-trapped, Esc cancels, focus returns to the button). Webhook URL copy button reachable + announces "Copied."

### (9) Accessibility
Button `aria-label` includes current + next state ("Activate — arm this workflow's trigger"). Confirm popover `aria-describedby` = the "will fire when…" sentence. Conflict warning `role="alert"`. Success announced `aria-live`: *"Live. Its trigger is armed."* / *"Paused."*

### (10) Loading
`activating`/`deactivating`: button label → "Activating…"/"Pausing…", disabled, optimistic badge flip; on settle, confirm/rollback.

### (11) Error
- **400** precondition (activate) → popover inline *"Add at least one step before this can go live."* (shouldn't reach here if disabled correctly, but server is source of truth).
- **400** bad trigger config → *"This trigger isn't set up yet — finish the ‘when it starts' settings first."* + link to TriggerInspector.
- **403** → *"You don't have permission to activate this workflow."*
- **409**/**404** archived → Locked mode banner.
- Network → *"Couldn't reach the server. Try again."*, optimistic flip rolled back.

### (12) Disabled
- **Activate disabled until `nonTriggerNodeCount ≥ 1`** → tooltip *"Add at least one step first."* (matches shipped precondition — NOT gated on publish state).
- Activate disabled in Watch/Locked/read-only.
- Deactivate disabled when not `ACTIVE`.
- If `conflictingActiveWorkflow` exists, Activate is *enabled* but the confirm forces an explicit acknowledgement (not silently disabled) — the user must choose scope-or-cancel.

---

## 8. `InlineFeedback` + `ConflictReloadBanner` + the error-envelope→UI map

### (1) Purpose
The app-wide, no-toast feedback system for this cluster: an inline success/error text primitive (reusing `Saved.`/red-message convention), the 409 stale-version reload banner, and the canonical `NormalizedApiError → copy + placement` mapping every lifecycle component defers to. Errors state *what* + *how to fix*, never apologise, never vague.

### (2) States
`InlineFeedback`: `ok` (emerald) · `error` (red) · `info` (muted) · `pending` (muted "Saving…"). `ConflictReloadBanner`: `visible` (409 encountered) · `reloading` · `dismissed-after-reload`.

### (3) Interactions
- `InlineFeedback` is passive text mirrored into the `aria-live` region (same string). Auto-clears `ok`/`info` after ~4s; `error` persists until the next action.
- `ConflictReloadBanner` (409 on Save/publish): sticky under toolbar, *"Someone else saved changes. Reload their version to keep going."* + **Reload** (refetches `GET /workflows/:id`, replaces canvas nodes/edges, **clears the undo stack**) + a read-only "See what changed" (opens Version History compare). No silent overwrite either direction.

### (4) Props
```ts
type InlineFeedbackProps = { tone:'ok'|'error'|'info'|'pending'; message:string; };
type ConflictReloadBannerProps = {
  workflowId:string;
  onReload:()=>void;   // refetch + replace canvas + clear undo
  onCompare:()=>void;
};
```

### (5) Data requirements
`NormalizedApiError { status, message, raw }`. The 409 banner needs the latest server `updatedAt` after reload to reset `expectedUpdatedAt`.

### (6) API dependencies
Reload → `GET /workflows/:id` (+ `GET /workflows/:id/versions` to refresh history). All cluster mutations funnel their errors through the map below.

**Canonical error map (this cluster):**
| status | context | copy | placement |
|---|---|---|---|
| 400 | publish/draft invalid | per-node issues (§5 table) | `PrePublishValidationPanel` (blocking dock) |
| 400 | "nothing to publish" | "Nothing new to publish — your draft matches the live version." | inline info, non-blocking |
| 400 | activate precondition | "Add at least one step before this can go live." | inline on Activate |
| 403 | run/publish/activate not permitted | "You don't have permission to {run/publish/activate} this workflow." | inline, control disabled |
| 403 | plan-gated Generate | "Generating with AI is on Business and Enterprise plans." | inline on Generate |
| 404 | archived / cross-tenant / purged | "This workflow isn't here anymore." | Locked-mode banner |
| 409 | stale version (Save) | "Someone else saved changes. Reload their version to keep going." | `ConflictReloadBanner` |
| 409 | delete with in-flight run | "This is still running — you can archive it once the run finishes." | inline on Delete |
| 409 | already-decided approval | "Already {approved/rejected}." | inline in inbox |
| 409 | archived-workflow edit | "This workflow was archived — you can't change it." | Locked banner |
| 410 | purged run opened | "This run's details were cleared after the retention window." | Timeline empty state |
| 422 | template install prereq | exact miss: "Hire a Marketing employee to use this workflow." / "Install Gmail first." / "Upgrade to Business to install this." | per-field in install Modal |
| 429 | throttle / Generate quota | "Give it a moment — too many requests just now." | inline, retry-after countdown |
| — | offline/network | "You're offline. We'll try again when you're back." | inline + Retry |

### (7) Responsive
`InlineFeedback` sits beside its action all breakpoints. `ConflictReloadBanner` full-width sticky; on mobile it's a top strip with a full-width Reload button.

### (8) Keyboard
Reload/Compare in tab order; Reload is the default-focused action when the banner appears. Esc does **not** dismiss the 409 banner (dismissing would risk silent overwrite) — only Reload resolves it.

### (9) Accessibility
`InlineFeedback` mirrored to `aria-live="polite"`; save/publish **failures** and the 409 banner use `aria-live="assertive"`. Banner `role="alert"`. Success strings reuse the exact visible text (no separate SR copy). Color never sole signal — `ok` has a check glyph, `error` an `x`.

### (10) Loading
`pending` tone renders "Saving…"/"Publishing…". Banner `reloading` disables Reload, shows "Reloading…".

### (11) Error
This *is* the error surface. If Reload itself fails (network) → banner stays, appends *"Couldn't reload — check your connection."*

### (12) Disabled
Reload disabled during `reloading`. `InlineFeedback` has no disabled state.

---

## 9. `EmptyState` — every empty surface as an invitation

### (1) Purpose
The one reusable empty-state primitive + the exact copy/CTA for each lifecycle empty surface. Empty screens are invitations to act, never dead ends.

### (2) States
Single presentational component; variant chosen by `context`. No internal state beyond hover on its CTA(s).

### (3) Interactions
Primary CTA (violet gradient) + optional secondary (ghost). Each CTA does the obvious next thing (open Templates, add a step, run a test, etc.).

### (4) Props
```ts
type EmptyStateProps = {
  icon: LucideIcon;
  title: string;
  body: string;
  primary?: { label:string; onClick:()=>void };
  secondary?: { label:string; onClick:()=>void };
  compact?: boolean; // canvas ghost vs full panel
};
```

### (5) Data requirements
None (copy-driven). Callers decide which context applies from their own query results (empty list, lone-TRIGGER definition, zero runs, single version, zero permissions).

**The surfaces + exact copy:**
| surface | icon | title | body | primary | secondary |
|---|---|---|---|---|---|
| No workflows (`/workflows`) | `sparkles` | "No workflows yet" | "Start from a template, or describe what you want and let AI draft it." | "Browse templates" | "Generate with AI" |
| New DRAFT (lone TRIGGER) | `plus-circle` | (ghost under trigger handle) "Add the first step" | — | opens Node Library | — |
| No runs yet | `play` | "No runs yet" | "Hit Test to try it safely, or Run to go live." | "Test run" | "Run" |
| No versions (never published) | `git-commit` | "Nothing published yet" | "Publish your draft to keep a version you can come back to." | "Publish…" | — |
| No permissions (anyone can run) | `users` | "Anyone on your team can run this" | "Add a rule to limit who can run it. Owners and admins always can." | "Add a run rule" | — |
| No templates match search | `search-x` | "No templates match ‘{q}'" | "Try a different word, or start from a blank workflow." | "Clear search" | "New workflow" |
| Approvals inbox empty | `inbox` | "Nothing's waiting on you" | "Approvals people send you will show up here." | — | — |
| Run purged (410) | `clock-x` | "This run's details were cleared" | "We keep run details for a limited time. This one's past that window." | "See recent runs" | — |

### (6) API dependencies
None directly; CTAs invoke existing flows (Templates modal, Node Library, Run popover, `PublishConfirmModal`, permissions form).

### (7) Responsive
Full-panel variant centers with max-width 420px; `compact` (canvas ghost) is a dashed 2px violet outline affordance beneath the trigger's `main` handle. Mobile stacks CTA buttons full-width.

### (8) Keyboard
CTAs are buttons in tab order; primary is default-focused when the empty state is the main content. The canvas ghost "Add first step" is reachable via ⌘K too.

### (9) Accessibility
`role="region"` `aria-label` = title. Icon `aria-hidden`. Copy is the accessible name; no color-only meaning.

### (10) Loading
Empty states never show during loading — skeletons take precedence; the empty state renders only after a settled query returns zero items (`isSuccess && data.length===0`).

### (11) Error
Not an error surface — if the underlying query errored, the error pattern (§8) renders instead, not the empty state.

### (12) Disabled
CTAs inherit disabled rules from their target (e.g. "Generate with AI" disabled + reason on non-Business plans; "Publish…" disabled if draft invalid — reason shown).

---

## 10. `LoadingVocabulary` — where each loader is used

### (1) Purpose
Define the skeleton-first loading language for lifecycle surfaces so nothing shows a bare spinner. Skeletons match the shape of what's coming.

### (2) States
Per surface: `route-skeleton` · `panel-shimmer` · `optimistic-pending` · `revalidating` (silent — stale-while-revalidate, no visible loader). No blocking full-screen spinner anywhere.

### (3) Interactions
Skeletons are inert (`aria-busy`, pointer-events none). Optimistic-pending controls stay visible but disabled with a "…ing" label.

### (4) Props
```ts
type SkeletonProps = { variant:'version-rows'|'validation-rows'|'canvas-nodes'|'inspector-fields'|'timeline-rows'; count?:number };
```

### (5) Data requirements
Driven purely by `isLoading`/`isPending` from the relevant hooks.

**Where each is used:**
| surface | loader | trigger |
|---|---|---|
| `/workflows` list | row skeletons (existing) | `useWorkflows` loading |
| Builder route first paint | canvas dim node-skeletons at dagre-estimated positions + "Loading your workflow…" | `useWorkflow(id)` loading |
| Version History | 4 `version-rows` skeletons | `useWorkflowVersions` loading |
| Pre-publish check | 3 `validation-rows` + "Checking your workflow…" | client validate + server reconcile |
| Publish confirm | button "Publishing…", modal locked | `usePublishWorkflow` pending |
| Activate/Deactivate | button "Activating…/Pausing…", optimistic badge | activate/deactivate pending |
| Version viewer | canvas node-skeletons + "Loading version n…" | version fetch |
| Restore (copy into draft) | row inline "Copying into your draft…" | `useSaveDraft` pending |

### (6) API dependencies
None own; reflects the state of every lifecycle query/mutation above.

### (7) Responsive
Skeleton counts scale down on mobile (fewer rows in view). Canvas skeleton uses the same dagre estimate at all sizes.

### (8) Keyboard
`aria-busy` regions are skipped for interaction; focus is parked on the nearest stable control until content arrives, then restored.

### (9) Accessibility
Each skeleton region `aria-busy="true"` + `aria-live="polite"` announces once ("Loading version history…") — not repeatedly. On settle, announce completion only where meaningful (e.g. run/publish), not for passive lists.

### (10) Loading
(This is the loading spec.) Rule: skeleton if we have *nothing* to show; stale-while-revalidate (no loader) if cached data exists (Node Library uses cached `['workflow-nodes']` staleTime 5min instantly).

### (11) Error
If a load fails, swap skeleton → the §8 error pattern with Retry. Never leave a skeleton spinning on error.

### (12) Disabled
Controls dependent on loading data are disabled with "Loading…" reason until their query settles.

---

## 11. `DisabledControl` pattern — never a dead control

### (1) Purpose
The rule + wrapper ensuring every disabled lifecycle control explains *why* and *how to enable it*, inline or via tooltip — no bare greyed buttons.

### (2) States
`enabled` · `disabled-with-reason`. Reason surfaces as: tooltip on hover/focus + `aria-describedby`; for the primary action of a panel, also as inline text beside the button.

### (3) Interactions
Disabled control is focusable enough to read its reason (uses `aria-disabled="true"` + visually-disabled styling rather than the native `disabled` attribute where the reason must be reachable by keyboard/SR; native `disabled` only where a visible inline reason already sits adjacent).

### (4) Props
```ts
type DisabledControlProps = { disabled:boolean; reason?:string; children:ReactNode };
```

**The lifecycle disabled vocabulary (control → reason):**
| control | disabled when | reason copy |
|---|---|---|
| Publish | issues present | "Fix {n} issue(s) to publish" |
| Publish | draft == live | "Nothing new to publish" |
| Activate | 0 non-TRIGGER nodes | "Add at least one step first" |
| Activate | bad trigger config | "Finish the ‘when it starts' settings first" |
| Deactivate | not ACTIVE | "It's not live right now" |
| Run | Watch/Locked mode | "You're watching a run — switch to editing to run again" |
| Run | RUN-restricted (403) | "You're not set up to run this workflow" |
| Test | — | *never disabled in Edit* |
| Generate with AI | plan < Business | "On Business and Enterprise plans" |
| Copy version into draft | matches current draft | "Your draft already matches this version" |
| Copy version into draft | read-only mode | "Switch to editing to change the draft" |
| Compare | only one version | "There's only one version so far" |
| highRisk TOOL_ACTION approval toggle | (absent by design) | persistent "Pauses for approval 🔴" badge + "built in and can't be turned off" |
| Secret field picker | no saved connections | "No connections saved yet" |

### (5) Data requirements
Each reason derived from the same data the gate uses (node count, issue count, plan, version equality, workflow status).

### (6) API dependencies
None own; mirrors gates enforced by `POST /publish` (400), `POST /activate` (400), RUN permission (403), PlanGuard (403).

### (7) Responsive
Tooltip on desktop/tablet (hover+focus); mobile has no hover → reason renders as persistent inline caption under the control (mobile can't rely on tooltips).

### (8) Keyboard
`aria-disabled` controls remain in tab order so the reason (`aria-describedby`) is reachable; activating them is a no-op that (re-)announces the reason via `aria-live`.

### (9) Accessibility
Reason wired via `aria-describedby`; disabled state via `aria-disabled` (not silent). Announce the reason on focus, not just hover. Color of the disabled control is not the only signal — the reason text carries it.

### (10) Loading
While the gate's data is still loading, the control is disabled with reason "Loading…" (distinct from the real gate reason) so users don't misread a transient disable as a permanent block.

### (11) Error
If the gate can't be evaluated (data errored), default to disabled with reason "Couldn't check — reload to try" rather than enabling a control that would fail server-side.

### (12) Disabled
(This is the disabled spec.) Invariant: `disabled === true` ⇒ `reason` is required and rendered. A disabled control without a reason is a lint-level bug.

---

## Cross-cutting through-line (why this reads as an AI-Employee OS, not a CI pipeline)

The lifecycle copy keeps the *manager-of-people* frame: you don't "deploy a pipeline," you **publish a version** of your team's playbook and **put it live**. An action keeps its name the whole way — "Publish" (button) → "Publishing…" (pending) → "Published v5." (inline + `aria-live`); "Activate" → "Live — trigger armed." Version history reads as *"Priya published this 2 days ago, 3 steps changed,"* not a git log. The two safety seams the whole product sells — a named human signs off (APPROVAL), and publishing never disarms trust (in-flight runs finish on their old frozen version) — are stated in plain words at exactly the moments (`PublishConfirmModal`, `ActivateConfirmPopover`) where a manager would otherwise worry.

**New hooks/util this cluster requires** (extend `features/workflows/{api.ts,hooks.ts}`, no new store slice): `useWorkflowVersions(id)` (`GET /workflows/:id/versions`), `useWorkflowVersion(id,n)` (`GET /workflows/:id/versions/:version`), `useSaveDraft(id)` (`PUT /workflows/:id/draft`), `usePublishWorkflow(id)` (`POST /workflows/:id/publish`), reuse `useActivateWorkflow`/`useDeactivateWorkflow` unchanged, and a pure `diffDefinitions(a,b): DefinitionDiff` util + a client `collectDefinitionIssues(def): ValidationIssue[]` mirror of the server validator. New query keys: `['workflows', id, 'versions']`, `['workflows', id, 'version', n]`. New UI primitives: `components/ui/Modal.tsx` (shared), `LifecycleBadge`, `EmptyState`, `InlineFeedback`, `ConflictReloadBanner` under `features/workflows/components/`.


---

# APPENDIX A — API DEPENDENCY MATRIX (component → exact endpoints)

*All GETs are `useQuery<T, NormalizedApiError>`; mutations use the optimistic triad where noted. ⚠ = unconfirmed against the ground brief (Appendix C).*

| Component | Endpoints |
|---|---|
| WorkflowListPage | `GET /workflows?limit=` · `GET /employees` · `GET /workflows/:id/runs?limit=1` (lazy) · `POST /workflows/:id/run` · `POST /workflows/:id/activate` · `POST /workflows/:id/deactivate` · `GET /workflows/:id` + `POST /workflows` (duplicate) · `DELETE /workflows/:id` (+`?hard=true`) · `GET/POST/DELETE /workflows/:id/permissions` · ⚠`GET /subscription` |
| CreateWorkflowMenu / NameForm | `POST /workflows` · `POST /workflows/generate` (Business/Enterprise) · ⚠`GET /subscription` |
| TemplateGallery / InstallForm | `GET /workflow-templates` · `GET /workflow-templates/:id/parameters` · `POST /workflow-templates/:id/install` (+`Idempotency-Key`) · `GET /employees` · `GET /skills` · ⚠ Slack channels (from skill config) · ⚠ knowledge categories · ⚠`GET /subscription` |
| WorkflowCanvasSurface / RunCanvasLayer | `GET /workflows/:id` · `GET /workflows/node-types` · `GET /workflows/runs/:runId` (1s poll) · `GET /workflows/:id/versions/:version` (pin) · ⚠`GET /approvals?status=PENDING` · `POST /approvals/:id/approve\|reject` · writes `PUT /workflows/:id/draft`, `PATCH /workflows/:id` |
| ConnectionDragLayer / Validity / WorkflowEdge | none at drag time (client mirror); authoritative `PUT /workflows/:id/draft` + `POST /workflows/:id/publish` |
| useNodePalette / NodeLibrary / CommandPalette | `GET /workflows/node-types` · `GET /employees` · `GET /skills` |
| useAddNode | writes `PUT /workflows/:id/draft`; TRIGGER adds `PATCH /workflows/:id` |
| Node cards | render from cached `workflow.definition`; `GET /workflows/node-types`; Watch `GET /workflows/runs/:runId`; identity `GET /employees`, `GET /skills` (Inspector-side) |
| Inspector / NodeConfigForm | `GET /employees` · `GET /skills` · `GET /workflow-secrets?workflowId=` · ⚠`GET /workflow-variables?workflowId=` · writes via canvas draft |
| TriggerInspector | `PATCH /workflows/:id { triggerType, triggerConfig, expectedUpdatedAt }` · `GET /skills` · webhook token minted on `POST /workflows/:id/activate` · ⚠ event types source |
| Param pickers | `GET /employees` · `GET /skills` · ⚠ Slack channels · ⚠ knowledge categories |
| ValueInserter | ⚠`GET /workflow-variables?workflowId=` (upstream derived client-side) |
| SecretPicker | `GET /workflow-secrets?workflowId=` (keys/metadata only) |
| ApprovalRoutingBuilder | node config draft save (no routing endpoint) · ⚠`GET /company/members`, ⚠`GET /departments`, ⚠`GET /teams` |
| WorkflowPermissionsPanel | `GET/POST/DELETE /workflows/:id/permissions` (RUN) · ⚠ directory endpoints |
| RunBar / RunHistory | `POST /workflows/:id/run` · `GET /workflows/:id/runs?limit=` · `GET /workflows/runs/:runId` · ⚠`GET /approvals?status=PENDING` → `POST /approvals/:id/reject` |
| DebugPanel | `GET /workflows/runs/:runId` · `GET /approvals/:id` · `GET /approvals/:id/history` · ⚠`GET /workflows/runs/:runId/attempts` (future) · ⚠ full-view route for truncated output |
| LifecycleBadge / VersionHistoryPanel / VersionRow / VersionViewer | `GET /workflows/:id/versions` · `GET /workflows/:id/versions/:version` · restore `PUT /workflows/:id/draft` · ⚠ org-members hook (publisher names) |
| PrePublishValidationPanel / PublishConfirmModal | `POST /workflows/:id/publish` · `GET /workflows/:id` (`warnings[]`) |
| ActivateControl | `POST /workflows/:id/activate` · `POST /workflows/:id/deactivate` |
| ConflictReloadBanner | `GET /workflows/:id` (+ `GET /workflows/:id/versions`) |

**Query-key factory (extend, no new store slice):** `workflowKeys.list`, `.detail(id)`, `.runs(id)`, `.run(runId)`, `['workflows',id,'versions']`, `['workflows',id,'version',n]`, `['workflow-nodes']` (5min), `['employees']`, `['skills']`, `['workflow-templates']`, `['workflow-template',id]`, ⚠`['subscription']`. **New hooks/util:** `useWorkflowVersions`, `useWorkflowVersion`, `useSaveDraft`, `usePublishWorkflow`, `useRunTimeline`, `useNodePalette`, reuse `useActivate/Deactivate` unchanged, pure `diffDefinitions(a,b)` + client `collectDefinitionIssues(def)`.

---

# APPENDIX B — FULL STATE INVENTORY

**Builder modes:** Edit · Watch (`?run=`) · Version-view (`?version=`) · Locked (archived / unresolved 409 / 404).

**Node states (every card, §1.6):** idle · hovered · selected · invalid · running · waiting-approval · succeeded · failed · disabled · dry-run.

**Run/step statuses (§1.7–1.8):** base — PENDING · RUNNING · WAITING · COMPLETED · FAILED · SKIPPED · (CANCELLED). Extended (only if attempt data) — RETRYING · COMPENSATING/COMPENSATED · TIMED_OUT · ESCALATED · EXPIRED · outcomeUnknown.

**Workflow lifecycle:** Draft · Live · Paused · Archived. **Version:** Draft · Published · Superseded · Archived (+ `current`, `dirty`).

**Connection/drag:** idle · pending · valid-hover · invalid-hover · dropped-valid · dropped-invalid · drop-on-empty · keyboard-connect. Reject codes: SELF_LOOP · INTO_TRIGGER · OUT_OF_TERMINATE · WOULD_CYCLE · DUPLICATE_BRANCH · DUPLICATE_EDGE · INTO_OCCUPIED_INPUT.

**Validation codes (blockers, §2.13):** SINGLE_TRIGGER_REQUIRED · TRIGGER_NOT_ENTRY · DUPLICATE_NODE_ID · UNKNOWN_EDGE_SOURCE/TARGET · UNKNOWN_NODE_TYPE · UNJOINED_PARALLEL · PARALLEL_NO_LANES · UNKNOWN_LANE_START · NESTED_PARALLEL · CYCLE_DETECTED · UNBOUNDED_LOOP · INCOMPATIBLE_PLACEMENT · TERMINATE_HAS_OUTGOING_EDGE · INVALID_CONFIG · SWITCH_NO_CASES · MISSING_BRANCH_EDGE · READ_ONLY_SCOPE · INLINE_SECRET_FORBIDDEN · GRAPH_TOO_LARGE.

**Save/persistence:** idle · dirty · saving · saved · draft-invalid-400 (non-blocking) · conflict-409 (ConflictReloadBanner) · publishing · published · publish-blocked · nothing-to-publish.

**Loading (skeleton-first, §2.6):** route-skeleton · panel-shimmer (version-rows / validation-rows / canvas-nodes / inspector-fields / timeline-rows) · optimistic-pending · revalidating (silent).

**Error (§2.7):** 400-validation · 400-nothing-to-publish · 400-activate-precondition · 403 (run/publish/activate/approver/plan) · 404 · 409 (stale-save / in-flight-run-delete / already-decided / archived-edit) · 410 (purged run) · 422 (template prereq) · 429 · offline.

**Empty (§2.8):** no-workflows · empty-after-filter · lone-TRIGGER · truly-empty · no-runs · no-versions · no-permissions · no-template-match · approvals-inbox-empty · run-purged-410.

**Disabled (§2.9):** every control carries a reason; full vocabulary table in §2.9.

**Realtime (§2.12):** connecting · live · reconnecting · polling-fallback.

**Responsive:** desktop (full authoring) · tablet (scrim overlays) · mobile (monitor + approve only).

---

# APPENDIX C — OPEN QUESTIONS, DECISIONS MADE, UNCONFIRMED DEPENDENCIES

## C.1 Decisions made (contradictions resolved)
1. **Validation panel unified.** Section 2 `ValidationIssuePanel` = Section 7 `PrePublishValidationPanel` → **one component, canonical `PrePublishValidationPanel`** (right-dock, non-modal). `ConnectionValidityFeedback` remains the separate client-mirror engine that feeds it + the drag layer.
2. **`ValidationIssue` shape unified** to `{ nodeId?:string|null; edgeId?:string; code; message; severity?:'blocker'|'warning' }`.
3. **Empty states.** `EmptyState` is the reusable primitive; `CanvasEmptyState` is its canvas consumer; copy comes from the single §2.8 table.
4. **Workflow ACTIVE displays as "Live"** everywhere (enum stays `ACTIVE`); distinct from a *Running* run. Section 1's "Active" pill re-worded to "Live."
5. **"Which version is live" derived from version `status==='PUBLISHED'`** (draft = `status==='DRAFT'`), **not** from the unconfirmed `WorkflowDto.activeVersionId`/`draftVersionId`.
6. **Four builder modes** (Edit / Watch / Version-view / Locked) unify Spine's three + Section 7's version-view; Watch and Version-view are both read-only pinned canvases (run overlay vs none).
7. **Right dock in Watch = `DebugPanel`; in Edit = `Inspector`.** Same dock, switched by mode.
8. **Activate precondition = ≥1 non-TRIGGER node + valid trigger config** (not "has a published version").
9. **Publish-invalid = 400** (422 is template-install only). "Nothing to publish" = 400 surfaced as info.
10. **Duplicate/restore/rollback** all resolve to `GET …` then `PUT /workflows/:id/draft` — no atomic route; surfaced as "Copy into your draft." `VersionRestoreModal` added (was referenced but unspecced).
11. **highRisk skill keys are illustrative** (`postiz.*` vs `mkt.social-*`) — the authoritative signal is `SkillCatalog.getTool()?.highRisk`.
12. **Run popover extracted as shared `RunLaunchPopover`** (List rows + RunBar + context menus).
13. **`WorkflowPermissionsPanel`** is the canonical name (Section 1's "PermissionsPanel" is the same).
14. **Owner disambiguated:** "employees on this workflow" (derived from `definition` nodes, always available) vs "owner/creator user" (needs a WorkflowDto user field — unconfirmed; hide the Owner chip if absent).

## C.2 Unconfirmed fields/endpoints (⚠ — nothing invented; each degrades honestly)
- **`NodeDefinitionDto`** (handles / config schema / `highRisk` / `pausesRun` / `default`) — **not in `@vaep/types`**; `GET /workflows/node-types` returns only `{ types }`. Handle topology + field specs are the client `labels.ts` + `nodeFieldSpecs.ts` registry until the DTO ships.
- **`WorkflowDto.activeVersionId` / `draftVersionId`** — Section 1 flags absent, Section 7 assumed present → derived from version status (C.1.5).
- **`WorkflowDto` creator/owner user field** (+ version `publishedById` → display name) — needs a members-resolution hook; hide/fallback "Someone" if absent.
- **`WorkflowRunDto`:** `correlationId`, `startedByUserId`, `triggerEventId`, `failureClass`/`error` (open string set), `resumeNodeId`, step `output.{truncated,originalBytes,preview}` (256KB) — used by RunHistory/DebugPanel; confirm.
- **Attempt data** (`WorkflowStepAttempt`, RETRYING/COMPENSATING/TIMED_OUT/outcomeUnknown) — **absent for live legacy runs**; extended states + Attempts tab render only if present.
- **WebSocket gateway** `run:{runId}` + `RunEventEnvelope.seq` — **not shipped**; realtime is the 1s poll, pill reads `polling-fallback`.
- **Not-shipped routes:** `GET /workflows/runs/:runId/timeline` · `/attempts` · `/runs/:id/tool-calls` · `GET .../versions/:a/diff/:b` · `POST .../rollback` · `/clone` · `/instantiate` · `/pause` · full-view route for truncated step output. Every UI control that would map to these is a **disabled control with an honest reason** or a client-side computation.
- **Approvals list filters** `?status=PENDING` / `?assignedToMe=true` (no `?runId=` — filter client-side by `workflowRunId`) — confirm the server supports the status/assignee filters.
- **Directory endpoints** `GET /company/members`, `GET /departments`, `GET /teams` — **not in the verified workflow API surface**; ApprovalRoutingBuilder + WorkflowPermissionsPanel degrade USER/DEPARTMENT/TEAM targets to a validated id text field with a warning.
- **`GET /workflow-variables?workflowId=`** and **`GET /workflow-secrets?workflowId=`** (keys/metadata only) — referenced as shipped; confirm.
- **Slack channel list** ("from the installed slack skill's config") and **knowledge categories** ("via the knowledge module; static role set + Shared fallback") — no dedicated endpoints confirmed.
- **`GET /subscription`** (`useSubscription` plan gate for Generate) — confirm.
- **`GET /employees` `avatarUrl`**, **`GET /workflow-templates/:id/parameters`** (summary with `parameters`+`requires`, definition omitted) — confirm shapes.
- **Event types source** for `TriggerInspector` (searchable EVENT list) — confirm.
- **`ApprovalRequest.args`** (resolved args persisted) — DebugPanel relies on this as the one place resolved template values live; confirm.

## C.3 Open product questions
- **Marketing employee (G10):** the Marketing card + Marketing role stay hidden until `EmployeeRole.MARKETING` ships; until then only `HR` renders and CUSTOM is never offered for AI Employee nodes. Confirm G10 timing.
- **Gmail/EVENT double-fire:** only one recruiting/EVENT workflow should be ACTIVE per connector; the ActivateConfirm conflict warning + TriggerInspector connector-scoping are the guardrails. Confirm whether the backend enforces or merely warns.
- **P3-05 / P3-06 sign-off:** ApprovalRoutingBuilder + WorkflowPermissionsPanel depend on R12 approval-guard sign-off and the directory endpoints; ship the id-text-field degrade until confirmed.
- **Truncated-output full view:** only render the "view full" affordance if an authorised route exists; otherwise the link is absent.

---

# APPENDIX D — BUILD-ORDER RECOMMENDATION

**Phase 0 — Foundations + shared primitives (unblocks everything).**
Register `cat-*`/`status-*`/`edge-*`/`elev-*` tokens + Space Grotesk/JetBrains Mono; `labels.ts` extensions (`NODE_CATEGORY`/`nodeIcon`/`nodeTone`/`defaultConfig`) + the **client handles/flags map** + `nodeFieldSpecs.ts`; shared primitives `Modal`, `InlineFeedback`, `ConflictReloadBanner`, `EmptyState`, `DisabledControl`, `RunLaunchPopover`; the `NormalizedApiError` map + `aria-live` region; query-key factory + new hooks (`useSaveDraft`, `useWorkflowVersions/Version`, `usePublishWorkflow`, `useRunTimeline`, `useNodePalette`); pure `diffDefinitions` + `collectDefinitionIssues`.

**Phase 1 — Entry surfaces.** `WorkflowListPage` (table + derived employee stack + client filter/sort), `CreateWorkflowMenu`/`NewWorkflowNameForm`, `TemplateGallery`/`TemplateInstallForm`/`PrereqChecklist`. Ships value immediately on the existing routes.

**Phase 2 — Canvas read path.** `WorkflowCanvasSurface` (React Flow config, dagre-once, dot-grid, skeleton), `WorkflowNodeCard` (registry-driven, all 10 states) starting with the signature `AI_EMPLOYEE_STEP` + `TRIGGER` + `TOOL_ACTION` + `APPROVAL`, then Logic/Data/Knowledge/Memory; `WorkflowEdge` (bezier + branch pills); `Minimap`, `ZoomControl`, `Outline` (a11y fallback). Read-only first (Version-view/Watch skins reuse this).

**Phase 3 — Canvas edit path.** `useAddNode` + `NodeLibrary` + `CommandPalette` (fan-out catalogue); `ConnectionDragLayer` + `ConnectionValidityFeedback`; marquee/align/undo/tidy; autosave `PUT /draft` + 409 banner.

**Phase 4 — Inspector cluster.** `Inspector` shell → `NodeConfigForm` (+ field renderers) → `TriggerInspector` → `EdgeInspector` → `MultiSelectInspector`; then pickers (`EmployeePicker`/`ConnectionPicker`/`ChannelPicker`/`KnowledgeCategoryPicker`), `ValueInserter`, `SecretPicker`. Defer `ApprovalRoutingBuilder`/`WorkflowPermissionsPanel` behind the directory-endpoint confirmation (ship the id-text degrade).

**Phase 5 — Lifecycle.** `PrePublishValidationPanel` → `PublishConfirmModal` → `ActivateControl` → `LifecycleBadge` → `VersionHistoryPanel`/`VersionRow`/`VersionViewer`/`VersionRestoreModal`.

**Phase 6 — Execution + observability (polling first).** `useRunTimeline` (1s poll) → `RunBar` + `RunLaunchPopover` → `RunCanvasLayer` overlay → `DebugPanel` → `RunHistory`. Realtime WS + attempt views ship dark/additive once the gateway + state-machine data land.

Rationale: each phase is independently shippable and read-before-write; the signature person-card lands early (Phase 2) so the differentiation is visible from the first canvas; every honesty degrade (disabled controls, polling fallback, id-text directory) is built in from the start rather than retrofitted.

---

# APPENDIX E — KEY FILES (absolute)

- `D:/Vertical AI/platform/apps/web/src/app/(app)/workflows/page.tsx` — list + entry toggle host.
- `D:/Vertical AI/platform/apps/web/src/app/(app)/workflows/[id]/page.tsx` — builder route (replace internal layout only; keep params, AppShell, accessToken guard, `useWorkflow`; Watch/Version-view/Locked modes).
- `D:/Vertical AI/platform/apps/web/src/features/workflows/{api.ts,hooks.ts,labels.ts,schemas.ts}` — extend (new endpoints, hooks, `nodeFieldSpecs.ts`, client handles/flags map, `diffDefinitions`, `collectDefinitionIssues`).
- New `D:/Vertical AI/platform/apps/web/src/features/workflows/components/` — `WorkflowCanvas/` (+ `RunCanvasLayer`), `CanvasToolbar/`, `Inspector/`, `NodeLibrary/`, `CommandPalette/`, `ExecutionTimeline/` (RunBar + RunHistory + DebugPanel), `Outline/`, `ContextMenu/`, `shortcuts/`, `WorkflowListTable/`, `CreateWorkflowMenu/`, `NewWorkflowNameForm/`, `Templates/{TemplateGallery,TemplateInstallForm,PrereqChecklist}/`, `WorkflowPermissionsPanel/`, `VersionHistory/`, `LifecycleBadge/`.
- New `D:/Vertical AI/platform/apps/web/src/components/ui/Modal.tsx` — shared focus-trapped overlay.
- **Do not edit:** `AppShell.tsx`, the single `apiClient`/`queryClient`/session store, or the shipped API contracts.

*End of specification.*
