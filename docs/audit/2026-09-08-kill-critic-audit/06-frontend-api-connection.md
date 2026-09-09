# Cluster 6 — Frontend ↔ API Connection Audit

Source: Explore agent research pass, 2026-09-08. Every claim traced page.tsx → feature component → hook → `apiClient` call → backend controller. Paths relative to `d:/Vertical AI/platform/`.

---

## A. Route-by-route audit

Every `app/(app)/**/page.tsx` audited is a thin client-guard shell that renders feature components from `features/*/components/*` backed by real TanStack Query hooks — no page contains inline hardcoded business data.

| Page | UI | Real API | Real data | E2E | Notes |
|---|---|---|---|---|---|
| `/dashboard` | Yes | `useOverview`→`GET /analytics/overview` | Real | Yes | `StatTile` marks derived figures `estimate` honestly. |
| `/employees`, `/employees/[id]` | Yes | `features/employees/api.ts` full CRUD + conversations/learning/skills | Real | Yes | 6 tabs each backed by distinct hooks. |
| `/assist`, `/assist/[sessionId]` | Yes | `/assist/suggestions`,`/sessions`; streaming via dedicated `fetch` (`useAssistStream.ts:95-96`, axios can't stream) | Real | Yes | |
| `/workflows`, `/templates`, `/new` | Yes | `/workflows`, `/workflow-templates`, install | Real | Yes | Legacy inline controls behind `simplifiedWorkflowUX` flag. |
| `/skills` | Yes | `/skills/catalog`,`/installed`,`/connect`, OAuth redirect | Real | Yes | `SIMULATED` skills (stripe/github/hubspot/jira) show "Demo only" instead of a fake connect button — honest dead-end. |
| `/knowledge` | Yes | `/knowledge/documents`,`/search` | Real | Yes | |
| `/approvals` | Yes | `/approvals/:id/{approve,reject,modify}` | Real | Yes | |
| `/billing`, `/billing/usage` | Yes | `/billing/plans,subscription,usage,credits,credit-packs` | Real | Yes | |
| `/leads` | Yes | `GET /leads` | Real | Yes | |
| `/leads/[id]` | Yes | `GET /leads/:id` | Real, **incomplete render** | Partial | See §D1 — `qualificationData` fetched, never shown. |
| `/leads/whatsapp-connect` | Yes | dedicated `WhatsAppAccount` endpoints | Real | Yes | |
| `/marketplace` | Yes | employee-template install, `SkillCatalog` reuse | Real | Yes | "Workflow Templates" section header has no list under it — minor dead section (functionality lives at `/workflows/templates`). |
| `/organization`,`/team`,`/hr` | Yes | org/users/hr APIs | Real | Yes | `/hr` retrofitted 2026-09-02 after backend shipped with zero frontend. |
| `/runs`,`/runs/[runId]` | Yes | `/workflows/runs*`, cancel/retry | Real | Yes | Shows `actingEmployeeId` (see §D3). |
| `/schedules`,`/scheduling` | Yes | derived from `/workflows`; interview-slot API | Real | Yes | |
| `/admin/health` | Yes | `/admin/dlq`,`/circuit` | Real | Yes | |
| `/onboarding` | Yes | `/onboarding/status,catalog,complete` | Real | Yes | |

## B. Fake/dead pattern search — essentially clean

- Hardcoded `const X = [{...}]` array literals standing in for API data in components: **0 matches** repo-wide.
- Static metrics that never move: **0** — dashboard rebuilt as server-resolved `DashboardWidgets` with explicit empty-state hints instead of zero-rows.
- Dead buttons (empty onClick / console.log-only / TODO): **0 matches** anywhere in `apps/web/src`.
- Connect/Install/Activate buttons checked (`ConnectSkillControl`, `EmployeeTemplateList`, `TemplateGallery`, `WorkflowListTable` activate/deactivate) — **all call real mutations**.
- One minor real dead spot: `/marketplace` "Workflow Templates" section (empty, `app/(app)/marketplace/page.tsx:41-45`).

## C. API→Frontend connection audit (orphans found)

- `GET /employees/:id/dependencies` — **orphaned**. Built specifically ("call this before offering `?hard=true`") but `EmployeeCard.tsx:90-110` only wires the soft delete; no hard-delete UI exists at all.
- `GET /workflows/node-types` — **orphaned**, self-documented as legacy "back-compat" now that `node-definitions` is what the builder actually calls.
- `POST /workflow-templates` (author a tenant template) — **orphaned**; frontend only calls list/parameters/install, never create.
- `internal/platform-admin/*` (credit-enforcement, finance/rollup, credits/adjustments) — **zero frontend callers**, but by design (`PlatformAdminGuard`, ops-only surfaces per their own file-header docs) — flagged as "no UI exists to operate real money-moving endpoints," not a defect.
- No broken frontend calls found (no endpoint called by the frontend that's missing from the backend).

## D. Specific gap verification

1. **`LeadDetail.tsx` qualificationData — CONFIRMED still true.** `LeadDetailDto.qualificationData` (`packages/types/src/index.ts:4481`) is typed, populated by `leads.service.ts`, fetched by `useLead`, but `grep qualificationData apps/web/src` → 0 results. `LeadDetail.tsx` (95 lines) renders name/status/source/email/dates/conversation only.
2. **Employees budgetLimit/permissions/approvalRules — NOT the same gap.** These ARE rendered (`EmployeeAbout.tsx:24-31`, `EmployeeSettings.tsx:474-518`) and the settings panel copy explicitly states they're enforced ("blocks the matching actions... in chat and in workflows"), consistent with CLAUDE.md's remediation log.
3. **Workflows list actingEmployeeId — not a gap either.** `/workflows` correctly shows a *definition-derived* roster (who's configured), not per-run attribution; `actingEmployeeId` is correctly surfaced one level down at `/runs` (`RunsTable.tsx:112-117`) and `/runs/[runId]` (page.tsx:75-80), matching its per-run semantics.

## Top 5 most severe findings

1. **`LeadDetail.tsx` throws away `qualificationData`** — site-visit/budget/need/timeline notes the API returns are invisible on the only screen a human would check them (`features/leads/components/LeadDetail.tsx`, confirmed 0 references repo-wide).
2. **`GET /employees/:id/dependencies` is a fully orphaned safety-check endpoint** — built to warn "you'll lose N conversations" before a hard delete, but no hard-delete UI was ever built, so it's unreachable dead code on the backend.
3. **Three `internal/platform-admin/*` billing-mutation endpoints (credit enforcement toggle, finance rollup, manual credit adjustment) have zero UI anywhere** — real money/enforcement operations are curl-only today.
4. **`POST /workflow-templates` (author a tenant template) has no frontend caller** — the backend capability for a company to publish its own reusable template is inert.
5. Everything else checked (fake data, dead buttons, decorative Connect/Activate buttons, broken frontend→404 calls) came back **clean** — this frontend is unusually well-wired compared to typical MVP scaffolds; the only real "UI throws away richer API data" instance found was the already-known leads gap, not a systemic pattern.
