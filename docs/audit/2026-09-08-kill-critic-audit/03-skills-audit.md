# Cluster 3 — Skills Complete Audit

Source: direct code read, 2026-09-08 (catalog, executors, OAuth, connectors, engines, frontend). Evidence
hierarchy: executable code > schema > docs. All paths relative to `d:/Vertical AI/platform` unless noted.
CLAUDE.md's own "Skills" section (module-status log) is treated as a hypothesis throughout, not a fact —
every claim in it is checked against `apps/api/src/modules/skills/**`, `apps/api/src/modules/engines/**` and
`apps/web/src/features/skills/**` directly.

**Headline: this is the most self-auditing part of the codebase.** The catalog cannot claim a skill is real
without a matching `case` in the executor (`real-execution-support.spec.ts` fails the build otherwise, per
`executors/real-execution-support.ts:22-28`), and `OAuthService.assertCanActuallyAct` refuses to let a
customer connect a skill with no real executor at all. That said, three concrete gaps survived this
discipline — one of them a live "green Connected badge, functionally dead skill" bug, and one a
readiness/executability contradiction identical in shape to the `workflow-ux-simplification` invariant bug
CLAUDE.md already documents for a different feature. See §E and Top 5.

---

## A. Skill inventory (the code catalog, `apps/api/src/modules/skills/catalog.ts`)

`executionSupport` is **derived, not authored** — `catalog.ts:955-969` decorates every entry from
`REAL_EXECUTION_TOOLS` (`executors/real-execution-support.ts:30-62`) on the way out, so the catalog cannot
drift from the executor's actual `switch` without failing `real-execution-support.spec.ts`.

| Skill | Category | Connection | Tools (real vs simulated) | executionSupport | Runtime callers | e2e coverage | Status |
|---|---|---|---|---|---|---|---|
| `slack` | communication | oauth | `send_message` (real, webhook or bot token) | REAL | chat ACT, TOOL_ACTION, manual execute | `skills.e2e-spec.ts`, `skill-connection-framework.e2e-spec.ts` | **PRODUCTION READY** |
| `email` (SMTP) | communication | api_key | `send_email` (real, nodemailer) | REAL | same | `skill-connection-framework.e2e-spec.ts` | **PRODUCTION READY** |
| `gmail` | communication | oauth | `send_email` (real) · `read_inbox` (mock) | PARTIAL | same | `skill-connection-framework.e2e-spec.ts`, `per-employee-skill-connections.e2e-spec.ts` | **PARTIALLY IMPLEMENTED** |
| `calendar` | productivity | oauth | `create_event` (real, incl. real Meet link) | REAL | same, + `scheduling.claim_slot` | `interview-scheduling` e2e (per user memory) | **PRODUCTION READY** |
| `gdrive` | productivity | oauth | `upload_file`/`create_folder`/`move_file`/`list_files`/`read_file` (all real) | REAL | same | `skill-connection-framework.e2e-spec.ts` | **PRODUCTION READY** |
| `scheduling` | productivity | none (internal) | `claim_slot`/`reschedule_slot` (real, wraps `SchedulingService` + real Calendar) | REAL | TOOL_ACTION only (no chat use case documented) | dedicated scheduling e2e | **PRODUCTION READY** |
| `http` | utility | none | `request` (real, SSRF-guarded fetch) | REAL | chat ACT, TOOL_ACTION | `skills.e2e-spec.ts` | **PRODUCTION READY** |
| `stripe` | payments | api_key | `create_payment_link` (highRisk), `list_charges`, `get_balance` — **no case at all** in `RealSkillExecutor` | SIMULATED | chat ACT (via approval), TOOL_ACTION | `skills.e2e-spec.ts` (mock-executor only) | **MOCK/FAKE** — OAuth-connect gate N/A (api_key), but `assertNotSimulatedInProduction` blocks `connectSkill` in prod (`skills.service.ts:576-584`) |
| `github` | development | api_key | `create_issue` — **no case**; `remove_collaborator` — **deliberately never implemented** (comment at `catalog.ts:306-308`: destructive on a live external system) | SIMULATED | same | `skills.e2e-spec.ts` | **MOCK/FAKE** |
| `hubspot` | crm | oauth | `create_contact`, `update_deal` — **no case at all** | SIMULATED | same | none found beyond catalog unit specs | **MOCK/FAKE**, OAuth-connect **BLOCKED** in prod by `OAuthService.assertCanActuallyAct` (`oauth.service.ts:94-103`) |
| `jira` | development | oauth | `create_issue`/`list_issues`/`get_issue`/`transition_issue` — **no case at all** | SIMULATED | same | none found | **MOCK/FAKE**, OAuth-connect **BLOCKED** in prod (same gate) |
| `postiz` (Marketing) | marketing | none | 6 tools, all real (Postiz REST + idempotent scheduling/publishing) | REAL | TOOL_ACTION (marketing templates), chat | `engines-marketing.e2e-spec.ts` | **UNREACHABLE in a from-scratch deployment** — see §E1 (`postizCustomerGroupId` is admin-set only, `marketing.service.ts:107`) |
| `marketing` (compliance) | marketing | none | `check_consent` (real, queries `MarketingConsent`/`MarketingSuppression`) | REAL | TOOL_ACTION (marketing templates) | covered by marketing-workflow-templates spec | **PRODUCTION READY** (once postiz-side account exists) |
| `chatwoot` | support | none | `list_open_conversations`/`get_conversation`/`reply_to_conversation` (real) · `resolve_conversation` — **hardcoded permanent failure**, see §E3 | REAL (mis-classified, see §E3) | TOOL_ACTION, chat | `engines-support.e2e-spec.ts` | **UNREACHABLE in production** — see §E2 (no code path anywhere creates a `ChatwootAccount` row) |
| `plane` | project_management | none | `list_issues`/`create_issue`/`update_issue_status` (all real) | REAL | TOOL_ACTION | `engines-pm.e2e-spec.ts` | **UNREACHABLE in production** — see §E2 (no code path creates a `PlaneWorkspace`/`PlaneProject` row) |
| `whatsapp` | communication | api_key | `send_message`/`send_template`/`get_conversation`/`update_lead_status` (all real, Twilio) | REAL | TOOL_ACTION, chat (leads workflows) | `whatsapp-lead-pipeline.e2e-spec.ts` | **PARTIALLY IMPLEMENTED / MISLEADING UI** — see §E4 (real executor, but the *generic* Skills-page connect flow for this `api_key` skill writes a CONNECTED badge that the real executor never reads) |
| `leads` | crm | none | `record_site_visit` (real, merges `Lead.qualificationData`) | REAL | TOOL_ACTION | `whatsapp-lead-pipeline.e2e-spec.ts` | **PRODUCTION READY** |

> **⚠ CORRECTION (2026-09-09 verification pass):** the tally in this section is wrong. The real figures are
> **43 tools, 31 in `REAL_EXECUTION_TOOLS`, 12 REAL skills** (not 45/30/11) — `leads` IS scored and is REAL,
> and `postiz` is REAL on all 6 tools. Separately, §E4's mechanism is wrong: the generic `/skills` page reaches
> `configureSkill` + `verifyConnection`, NOT `connectSkill`, so the badge there stays `Not connected`. The real
> defect on that page is the wizard's sentence *"your settings are saved and this skill is ready to use"*; the
> `CONNECTED`-badge lie is reachable only via the raw API endpoint. See `verify-04-skill-readiness.md`.

**Catalog-wide tally:** 17 skills, 45 tools. `REAL_EXECUTION_TOOLS` names 30 of them as real
(`real-execution-support.ts:30-62`); `executionSupportFor` (same file, :96-104) rolls that up per skill:
**11 skills REAL, 1 PARTIAL (gmail), 4 SIMULATED (stripe/github/hubspot/jira), 1 not scored** (`leads` is
folded into "crm" but is 100% real — no PARTIAL/SIMULATED skill exists among the "newer" additions the
brief asked about; every gap left is in the four original mock-only integrations, unchanged since the
Phase-1 remediation CLAUDE.md documents).

**DB usage (`InstalledSkill`/`EmployeeSkill`):** confirmed ACTIVE by Cluster 1 (23 real-code writers/readers,
not test-only) — not re-verified per-skill-key here; the runtime seam (`getToolsForEmployee`,
`runTool`) is skill-agnostic, so every catalog entry reaches the exact same DB path once installed+assigned.

---

## B. Chain traces (skill → employee → permission → connection → tool → executor → external service)

### B1. `gmail.send_email` (representative of the OAuth "PARTIAL" class)
`Employee chat / TOOL_ACTION` → `SkillsService.runTool` (`skills.service.ts:627`) → grant check
(`employeeMayUseSkill`) → permission check (`employeePermissionDenial`, capability `EMAIL_SEND` via
`capabilities.ts:15-18`) → suppression check → credit reservation → `resolveExecutorContext` decrypts the
per-employee-or-company-wide `InstalledSkill.credentials` (`skills.service.ts:1091-1117`) → dispatched to
`RealSkillExecutor.gmailSendEmail` (`real-skill-executor.ts:542-593`) → **real** `POST
gmail.googleapis.com/gmail/v1/users/me/messages/send` with the stored `accessToken`. `read_inbox` has no
case in the switch → falls to `MockSkillExecutor`, which never fails the credential check, so the tool
silently answers `{sandbox:true}` in production if `SKILL_EXECUTOR=real` and `failClosed` is bypassed... no —
confirmed `failClosed` (prod) makes the `default:` branch of `RealSkillExecutor` **refuse** rather than
delegate (`real-skill-executor.ts:283-296`), so in production `gmail.read_inbox` returns an honest
`ok:false` ("no real integration ... NOT executed"), not a fabricated inbox. In non-production it silently
returns a mock inbox — correct for offline dev, but means **no environment ever really reads Gmail** (there
is no real `read_inbox` case at all, only a fail-closed refusal in prod and a sandbox echo elsewhere).

### B2. `stripe.create_payment_link` (representative of the "no real executor at all" class)
Catalog marks it `highRisk: true` → `toolRequiresApproval` (`tool-approval-policy.ts:76-78`) always routes it
to the Approval Center regardless of executor mode. A manager approves it → `runTool` → no case in
`RealSkillExecutor` → prod: `ok:false` refusal naming the gap explicitly (`real-skill-executor.ts:288-293`);
non-prod: `MockSkillExecutor` returns a fabricated `{id:'mock_create_payment_link_...', sandbox:true}` **and
the human approver has no way to tell from the approval UI that the "payment link" about to be approved will
be fake** — the Approval Center surfaces the tool name/args, not `executionSupport`. This is a defensible
trade for offline dev/test (the whole point of the mock), but worth naming: **a human approver in a non-prod
environment can approve a Stripe payment link that was never real**, with the same UI they'd use in
production. Connecting a real Stripe key at all is blocked by `assertNotSimulatedInProduction` in prod
(`skills.service.ts:576-584`, since `executionSupport==='SIMULATED'`); in non-prod, `connectSkill` proceeds
with **zero credential validation** (no adapter registered for `stripe` in `providers/index.ts`) — a company
could paste a garbage `sk_live_...` string and see `CONNECTED` in dev, though this never reaches production
per the SIMULATED-connect gate.

### B3. `whatsapp.send_message` (real executor, catalog `api_key`, but see §E4 for the connect-path bug)
Lead-qualification workflow / chat → `runTool` → grant/permission/suppression checks → idempotency-keyed
(`whatsappSendMessageIdempotencyKey`, 5-min dedupe window, `real-skill-executor.ts:100-104`) →
`RealSkillExecutor.whatsappSendMessage` (`:1478-1544`) queries the **separate** `WhatsAppAccount` table
(`findWhatsAppAccount`, `:1471-1476`) — **not** `ctx.credentials` from `InstalledSkill` — decrypts
`twilioAuthToken` via `CryptoService`, calls `TwilioWhatsappClientService.sendFreeform` (real Twilio REST).
24-hour session-window enforcement is real (`WHATSAPP_SESSION_WINDOW_MS`, checks last **inbound** message
role, a previously-fixed bug per the code comment at `:1492-1500`). This is a genuinely real, well-guarded
integration — **when reached through the correct connect path** (`WhatsappAccountsService.connect`,
`whatsapp-accounts.service.ts:48-106`, which does a real Twilio `GET /Accounts/{sid}` auth probe before
writing `CONNECTED`). The generic Skills-catalog connect path for this same skill key does **not** reach that
service at all — see §E4.

### B4. `chatwoot.reply_to_conversation` / `plane.create_issue` (real code, unreachable prerequisite)
Both executors are fully real (Chatwoot: idempotency-keyed reply + escalation check against
`HandoffRequest`, `real-skill-executor.ts:1233-1309`; Plane: real REST create/update against
`PlaneClientService`, `:1365-1455`) and both correctly resolve `ChatwootAccount`/`PlaneWorkspace` rows
scoped by `companyId`. The gap is upstream: **no code anywhere creates those rows** — see §E2. Every call
against a company that has never had one manually inserted returns a clean `ok:false` ("Chatwoot/Plane not
connected for this company") — never a fake success — but the workflow publish-time readiness gate reports
these skills `READY` regardless (§E2), so the honest runtime failure is the first time anyone learns this.

---

## C. Unused / mock / dead classification

| Class | Skills | Evidence |
|---|---|---|
| **MOCK/FAKE (no real executor exists at all)** | `stripe`, `github`, `hubspot`, `jira` | `real-execution-support.ts:9-16` names these four explicitly as the motivating case for the whole file; zero `case` in `RealSkillExecutor`'s switch for any of their tools (confirmed by direct read, `real-skill-executor.ts:220-297`) |
| **OAuth-connect actively BLOCKED (not just labeled)** | `hubspot`, `jira` | `OAuthService.assertCanActuallyAct` (`oauth.service.ts:94-103`) throws 400 before an authorize URL is ever built, for any skill where `hasAnyRealExecution()` is false |
| **api_key-connect actively BLOCKED in production only** | `stripe`, `github` | `SkillsService.assertNotSimulatedInProduction` (`skills.service.ts:576-584`) — `NODE_ENV!=='production'` still allows a demo connection with zero validation (no adapter for either key in `providers/index.ts`) |
| **PARTIAL (some tools real, some not)** | `gmail` (send real / read mock-or-refused) | §B1 |
| **UNREACHABLE (real code, unreachable prerequisite)** | `chatwoot`, `plane` | §E2 — no `ChatwootAccount`/`PlaneWorkspace` creation path exists anywhere in `apps/api/src` outside test fixtures |
| **UNREACHABLE (real code, admin-only prerequisite)** | `postiz` | `Company.postizCustomerGroupId` is set only via `PlatformAdminGuard`-gated `postiz-tenancy.controller.ts` — no self-service onboarding path (consistent with Cluster 6's note that platform-admin billing endpoints are "curl-only today"; same pattern here for marketing tenancy) |
| **Permanently-failing "real" case** | `chatwoot.resolve_conversation` | §E3 |
| **Valid-but-narrow** | `scheduling.*` | Internal-only, correctly has no OAuth/connection surface; genuinely used by the interview-scheduling flow, not dead |
| **No orphans found** | — | Every catalog skill has at least one real runtime caller (`TOOL_ACTION` node handler and/or the chat ACT loop both go through the same `SkillsService.runTool`, so there is no "installed but never callable" skill) |

No skill in the catalog is UNUSED, LEGACY, or DUPLICATE in the strict sense — the four SIMULATED skills are
intentionally kept installable ("a simulated run is a legitimate way to try a workflow out",
`ConnectSkillControl.tsx:70-72`) rather than removed, and the catalog explicitly documents this as a product
decision, not an oversight.

---

## D. The `assertCanActuallyAct` / `assertNotSimulatedInProduction` gates — verified

Both gates read the **same** single source of truth (`hasAnyRealExecution` /
`SkillDefinition.executionSupport`, both derived from `REAL_EXECUTION_TOOLS`), confirming CLAUDE.md's claim:

- `apps/api/src/modules/skills/oauth/oauth.service.ts:94-103` — `assertCanActuallyAct`, called from
  `buildAuthorizeUrl` before any provider redirect is ever constructed. Blocks `hubspot`, `jira` (the two
  SIMULATED skills that use OAuth). `stripe`/`github` are `api_key`, so they never reach this gate — they're
  covered by the sibling one below instead.
- `apps/api/src/modules/skills/skills.service.ts:576-584` — `assertNotSimulatedInProduction`, called from
  both `connectSkill` (api_key path, `:318`) and `connectOAuth` (the OAuth callback's own write path,
  `:1351` — the class doc at `:1348-1350` notes this is deliberate: "hubspot and jira reach CONNECTED through
  HERE, not through connectSkill(), so guarding only the other door would have left the actual one open").
  **Production only** — `process.env.NODE_ENV !== 'production'` short-circuits at the top.
- Frontend mirror: `ConnectSkillControl.tsx:74-80` renders "Demo only — nothing to connect yet" instead of a
  credential form whenever `executionSupport === 'SIMULATED'`, and its own comment states plainly this is
  "the half that stops a customer walking into it, not the half that enforces it" — the server-side gates
  above are the actual enforcement, matching the codebase's stated discipline everywhere else (§37 references
  throughout `skills.service.ts`).

**Real-vs-mock verified per the brief's specific list:**

| Skill | Claim in commits/CLAUDE.md | Verified |
|---|---|---|
| gmail send/inbound | "real send" | Send: **confirmed real** (Gmail API). Inbound: IMAP polling exists (`providers/imap.util.ts`, `imap-inbound.processor.ts` per Cluster 1) as a separate ingestion path, not a `read_inbox` tool call — the tool itself is mock/refused (§B1). |
| twilio whatsapp | "real" | **Confirmed real** (Twilio REST via `TwilioWhatsappClientService`), with the connect-path caveat in §E4. |
| postiz | "real" | **Confirmed real** client + idempotent publish/schedule, gated on an admin-only tenancy prerequisite (§E1). |
| chatwoot | "real" | **Confirmed real** client + reply/list/get, gated on a prerequisite with literally no creation path (§E2). |
| stripe/github/hubspot/jira | "no real executor" | **Confirmed** — zero `case`s exist for any of the 4 skills' 11 combined tools. |

---

## E. Severe findings — "looks connected, does nothing real" and readiness/executability contradictions

### E1. `postiz` — real code, admin-only-provisioned prerequisite, no self-service path
`RealSkillExecutor`'s postiz.* handlers are fully real, but every one of them resolves a `SocialAccount` row
that only exists once `Company.postizCustomerGroupId` is set — and that field is written **only** by
`postiz-tenancy.controller.ts` behind (implicitly, per its sibling billing endpoints) a platform-operator-only
surface, confirmed by grep: the sole writers of `postizCustomerGroupId` are `postiz-tenancy.controller.ts`
itself. No onboarding flow, no self-service company setting, sets it. A customer can install/assign the
`postiz` skill and build a workflow around it; nothing will work until Orlixa staff manually flip a value in
the database or through an internal-only endpoint.

### E2. `chatwoot` / `plane` — real code, ZERO creation path for the prerequisite row (severe)
Grepped the entire `apps/api/src` tree for any writer of `ChatwootAccount` or `PlaneWorkspace`
(`prisma.chatwootAccount.create/upsert`, `prisma.planeWorkspace.create/upsert`) — **zero matches outside test
spec files**. Both engine adapters' own `connect()` methods **document this directly**:
`chatwoot-engine.adapter.ts:42-50` — `connect()` unconditionally rejects with
`EngineCapabilityUnsupportedError('connect', 'account provisioning needs a live Chatwoot instance to verify
the sequence against; an account is registered out of band today')`; `plane-engine.adapter.ts` carries the
identical pattern per its own header comment ("Note what it does NOT do... `provisionAccount` throws rather
than pretending"). This means: **today, no company — not even a manually-configured one via any exposed
API — can ever get chatwoot/plane support working**, because the one thing that would create the row a real
executor needs does not exist anywhere in the code. This is a stronger defect than "mock" — the code that
*would* work is real and tested, but it is permanently unreachable in this build. `docs/audit`'s own evidence
hierarchy calls this out precisely: don't conclude a skill "works" because it has a real executor — trace
whether the call can ever reach it, and here it provably cannot.

Compounding this: `skill-requirements.service.ts:235-236` explicitly classifies any `connection.type==='none'`
skill (which includes `chatwoot` and `plane`, alongside the genuinely-fine `http`/`scheduling`/`postiz`) as
**`READY`the moment it's installed** — "it is operational as soon as it exists, so it never blocks" — so a
workflow using `chatwoot.reply_to_conversation` or `plane.create_issue` sails through
`SkillRequirementsService.assertPublishable` with `allRequiredReady: true`, goes live, and then fails at the
first real run with "SupportConversation not found" / "PlaneProject not found for this company". This is the
same *readiness !== executability* trap CLAUDE.md documents for the `workflow-ux-simplification` feature
(`readiness === (publish would succeed)` invariant) — except here the invariant is violated by design for
these two skills, not by a bug in one code path, and nothing in the readiness DTO, the SkillCatalog UI, or the
publish-time gate warns the workflow author before they ship it.

### E3. `chatwoot.resolve_conversation` — cataloged REAL, permanently hardcoded to fail
`REAL_EXECUTION_TOOLS` (`real-execution-support.ts:53`) lists `chatwoot.resolve_conversation`, which makes
`executionSupportFor('chatwoot', [...])` count it toward "REAL" (all 4 chatwoot tools are in the list, so the
skill rolls up to `executionSupport: 'REAL'`, not `PARTIAL`). But the actual `case` in
`RealSkillExecutor.chatwootResolveConversation` (`real-skill-executor.ts:1311-1341`) **unconditionally
returns `ok:false`** with the message "resolve_conversation is NOT YET IMPLEMENTED against the real Chatwoot
API ... The conversation was NOT resolved." The drift-guard spec (`real-execution-support.spec.ts`) only
proves "a switch case exists for this pair" — it does not (and structurally cannot, without executing the
case) prove the case can ever succeed. So a skill can be labeled fully REAL in the catalog and the frontend
(no "Partly simulated" warning renders, since `t.simulated` is unset for this tool) while one of its tools is
mathematically guaranteed to fail every single time it's called. This is a narrower, more honest cousin of
E2 — the failure is loud (`ok:false`, clearly worded) rather than silent, but the **classification is wrong**:
this tool should be flagged the same way `github.remove_collaborator` is (deliberately excluded from
`REAL_EXECUTION_TOOLS`, `catalog.ts:306-319`), not counted as real.

### E4. `whatsapp` skill — real executor, but the GENERIC connect path writes a meaningless "Connected" badge
This is the closest the codebase comes to the audit's named worst-case pattern ("a real, CONNECTED-gated
skill whose tool execution is still mocked/broken underneath"), and it survived despite the §37 discipline
because it falls through a seam between two independently-correct subsystems:

1. `whatsapp`'s catalog `connection.type` is `'api_key'` (`catalog.ts:856`), so it renders on the generic
   `/skills` catalog page exactly like `stripe`/`github`/`email`, using `ConnectSkillControl.tsx`'s generic
   `api_key` branch (a single password-style field, labelled "API key" for every non-Slack `api_key` skill,
   `ConnectSkillControl.tsx:129-144`).
2. Submitting that form calls `SkillsService.connectSkill` (`skills.service.ts:311-393`). `whatsapp` has
   `executionSupport: 'REAL'` (not SIMULATED), so `assertNotSimulatedInProduction` does **not** block it.
   `providers/index.ts` registers adapters only for `smtp/gmail/calendar/gdrive/slack` — **there is no
   adapter for `whatsapp`** — so `getProviderAdapter('whatsapp')` returns `undefined` and the §37
   credential-validation gate (`skills.service.ts:338-361`) is skipped entirely ("Skills WITHOUT an adapter
   keep the previous behaviour on purpose"). The row is written straight to `connectionStatus: 'CONNECTED'`
   with whatever the generic form posted (e.g. `{ apiKey: "anything" }`).
3. But `RealSkillExecutor`'s whatsapp.* handlers (`real-skill-executor.ts:1471-1643`) **never read
   `ctx.credentials` at all** — they call `findWhatsAppAccount(ctx.companyId)`, which queries the entirely
   separate `WhatsAppAccount` Prisma model (no FK to `InstalledSkill`). That row is only ever created by the
   **dedicated** `WhatsappAccountsService.connect()` (`whatsapp-accounts.service.ts`), reached through the
   `/leads/whatsapp-connect` page (Cluster 6, confirmed real), which correctly does a live Twilio
   `GET /Accounts/{sid}` probe before writing anything.

Net effect: a user who finds the `whatsapp` skill on the **generic** `/skills` catalog page (a perfectly
reasonable place to look — every other skill is connected from there) can type garbage into the "API key"
box, click Save, and see a green **"Connected"** badge on `InstalledSkill` — a badge that means literally
nothing, because the real executor for this skill was never wired to read that credential in the first
place. The actual send tools still fail cleanly at runtime (`ok:false`, "No WhatsAppAccount configured for
this company") rather than lying about success, and the *correct* dedicated connect page does work — but the
generic page's badge actively misrepresents the skill's true readiness, which is exactly the class of bug
the whole `assertNotSimulatedInProduction`/`hasAnyRealExecution` machinery exists to prevent for the other
four skills. `whatsapp` was missed because that machinery only gates on "does *any* real code exist", not
"does *this specific connect surface* feed the code that actually runs."

---

## Top 5 most severe findings

1. **`chatwoot` and `plane` are permanently unreachable in production, and the readiness gate hides it
   (§E2).** No code path anywhere creates the `ChatwootAccount`/`PlaneWorkspace` row both skills' otherwise-real
   executors depend on — both engine adapters' `connect()` throw on purpose, admitting "provisioned out of
   band." `SkillRequirementsService` still reports both skills `READY` at publish time (because their catalog
   `connection.type` is `'none'`), so a workflow author gets a green light to ship a Support/PM workflow that
   is mathematically guaranteed to fail its first real Chatwoot/Plane call — the exact readiness/executability
   contradiction CLAUDE.md's own `workflow-ux-simplification` post-mortem warns about, reproduced here for two
   entire skills rather than one workflow-validator bug.

2. **The `whatsapp` skill's generic Skills-catalog connect path writes a "Connected" badge the real executor
   never reads (§E4).** Because no provider adapter is registered for `whatsapp` in `providers/index.ts`, the
   §37 credential-validation gate that exists precisely to prevent this class of bug is silently skipped for
   this one `api_key` skill — the only skill with a real executor that can reach `CONNECTED` with zero
   verification through its most discoverable UI surface. The separate, correct `/leads/whatsapp-connect` page
   does verify — but nothing stops a user from finding and using the wrong one first.

3. **`chatwoot.resolve_conversation` is classified `REAL` in the catalog while being hardcoded to always fail
   (§E3).** The drift-guard test (`real-execution-support.spec.ts`) only proves a `switch case` exists, not
   that it can succeed — so this tool passes every automated check while being permanently broken, and neither
   the catalog DTO nor the frontend warns a workflow author, unlike the deliberately-excluded
   `github.remove_collaborator`.

4. **`postiz` requires an admin-only, self-service-less prerequisite (`Company.postizCustomerGroupId`)
   (§E1).** Same shape as Cluster 6's "money-moving endpoints are curl-only" finding, reproduced in the
   Marketing engine: real, tested code, gated on a field only Orlixa staff can set.

5. **Everything else is unusually disciplined.** 11 of 17 skills are fully REAL with real network calls
   traced to exact file:line; the 4 genuinely mock skills (`stripe`/`github`/`hubspot`/`jira`) are honestly
   labeled, gated from real OAuth consent (`hubspot`/`jira`) and from production connection
   (`stripe`/`github`) by code that reads the SAME single source of truth as the catalog itself, and the
   frontend renders an honest "Demo only" state rather than a decorative Connect button. The gaps found above
   are real and worth fixing, but they are narrow seams in an otherwise carefully self-verifying system, not a
   systemic mock-dressed-as-real pattern.
