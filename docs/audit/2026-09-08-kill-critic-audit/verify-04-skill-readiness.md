# Verify-04 — Skill readiness honesty (Fixes 1–4)

Read-only verification pass, 2026-09-09. Verifies (and where necessary **corrects**) the hypotheses in
`03-skills-audit.md` §A/§E1–E4 and `10-billing-credits-and-integrations.md` Part B, and supplies the exact
current-state facts an implementation plan must match. All paths relative to `d:/Vertical AI/platform`.
Nothing was modified.

**Verdict up front:** every load-bearing claim in the prior audit is confirmed **except two**, both in §E4
(WhatsApp), where the *mechanism* is different from the one described — and the real mechanism is worse in
one direction and better in another. See **Fix 3 → “Correction”**. Two counting errors in §A are also
corrected. One **new** defect was found (`AutoSkillExecutor` refuses WhatsApp when it is *correctly*
connected) — see **Fix 3 → F3-N1**.

---

## Fix 1 — `SkillRequirementsService` cannot distinguish "no connection needed" from "can never be connected"

### 1.1 The service in full — every status it can emit, and the exact logic

File: `apps/api/src/modules/skills/skill-requirements.service.ts` (267 lines; read in full).

**The status union is declared in `packages/types/src/index.ts:1091-1116`** — 11 values, and the doc comment
already admits only 5 are producible today:

```ts
// packages/types/src/index.ts:1079-1116
/**
 * Operational state of a required skill inside AI Assist / the Workflow Builder.
 * A SUPERSET of {@link SkillConnectionStatus}: a computed projection that never
 * treats "credentials exist" as "operational".
 *
 * Producible by today's resolver (SkillRequirementsService): READY,
 * NOT_CONNECTED, DEGRADED, DISCONNECTED, ERROR. The remaining values —
 * AUTHORIZING, CONFIGURATION_REQUIRED, VALIDATING, EXPIRED, REVOKED,
 * INSUFFICIENT_PERMISSION — are part of the contract but only emitted once the
 * OAuth-resume + post-connect scope/health-validation slices land (they need a
 * live provider probe that doesn't exist yet). The UI must handle all of them.
 */
export type SkillRequirementStatus =
  | 'READY' | 'NOT_CONNECTED' | 'AUTHORIZING' | 'CONFIGURATION_REQUIRED'
  | 'VALIDATING' | 'DEGRADED' | 'DISCONNECTED' | 'EXPIRED' | 'REVOKED'
  | 'INSUFFICIENT_PERMISSION' | 'ERROR';

export const SKILL_REQUIREMENT_STATUSES: readonly SkillRequirementStatus[] = [ …all 11… ] as const;
```

There is **no local DTO** — the service imports the shared type directly (`skill-requirements.service.ts:3-12`).
`SKILL_REQUIREMENT_STATUSES` has **no consumer anywhere** in `apps/api`, `apps/web` or `packages`
(grep: only its own declaration + the built `dist`), so it is a dead export today — safe to extend, but it
also means nothing validates the union at runtime.

**The assignment logic — the whole of it** (`skill-requirements.service.ts:227-251`):

```ts
private projectStatus(
  skillKey: string,
  known: boolean,
  requiresConnection: boolean,
  installed: InstalledSkillDto | null,
): SkillRequirementStatus {
  if (!known) return 'ERROR'; // references a skill outside the catalog
  // A `none`-connection skill (http/scheduling/postiz/…) needs no auth: it is
  // operational as soon as it exists, so it never blocks.
  if (!requiresConnection) return 'READY';           // ← lines 235-236, the defect
  if (!installed || !installed.enabled) return 'NOT_CONNECTED';

  const status: SkillConnectionStatus = installed.connectionStatus;
  switch (status) {
    case 'CONNECTED':    return 'READY';
    case 'DEGRADED':     return 'DEGRADED';
    case 'DISCONNECTED': return 'DISCONNECTED';
    case 'NOT_CONNECTED':
    default:             return 'NOT_CONNECTED';
  }
}
```

**Confirmed exactly as hypothesised.** `requiresConnection` comes from `capabilities.ts:132-136`:

```ts
/** True when the skill needs an authenticated connection before it can run for real. */
requiresConnection(skillKey: string): boolean {
  const type = SkillCapabilities.connectionType(skillKey);
  return type === 'oauth' || type === 'api_key';
},
```

so **`connection.type === 'none'` ⇒ `requiresConnection === false` ⇒ `status: 'READY'`, unconditionally,
with no DB read at all.** That covers `http`, `scheduling`, `postiz`, `marketing`, `chatwoot`, `plane`,
`leads` — three of which are correct and three of which are not (§1.3).

`isBlocking` and `assertPublishable` (`:128-152`):

```ts
async assertPublishable(companyId: string, definition: WorkflowDefinition): Promise<void> {
  if (!this.enforcementEnabled()) return;                       // :129
  const { requirements, allRequiredReady } = await this.forDefinition(companyId, definition, {
    canManageConnection: true,
  });
  if (allRequiredReady) return;
  const blockers = requirements.filter((r) => this.isBlocking(r));
  const listed = blockers.map((r) => `${r.displayName} (${this.humanStatus(r.status)})`).join(', ');
  throw new BadRequestException(
    `Cannot publish: ${blockers.length} required skill ` +
      `${blockers.length === 1 ? 'connection is' : 'connections are'} not ready — ${listed}. ` +
      'Connect the skill(s), or keep the workflow as a draft.',
  );
}

/** A dependency blocks publish when it's required and not operational. */
private isBlocking(r: WorkflowSkillRequirementDto): boolean {
  return r.required && r.status !== 'READY';                    // :150-152
}
```

`enforcementEnabled()` (`:51-53`): `(SKILL_EXECUTOR ?? 'mock').toLowerCase() !== 'mock'`. **The gate is a
complete no-op in `mock` mode**, which is the shipped default (`.env.example:135`, `preflight-env.mjs:204`)
and the whole e2e suite's mode — a fact that materially de-risks Fix 1 (see §1.5 “blast radius”).

`humanStatus` (`:253-266`) is a `switch` with a `default:` that lowercases + underscore-strips, so **adding a
new status value does not break it** — it degrades to e.g. `"cannot currently be connected"`. That is the one
place where a new value costs nothing.

### 1.2 Every caller of `SkillRequirementsService`

| # | Caller | Call | What it does with the result |
|---|---|---|---|
| 1 | **Publish gate** — `workflows/workflow-version.service.ts:193` | `assertPublishable(companyId, draftDefinition)` | Throws 400 → the workflow stays DRAFT. Comment at `:190-192`: *"A workflow whose required skills aren't connected must stay a DRAFT… Structural validity is not enough."* |
| 2 | **Readiness preflight** — `workflows/readiness/workflow-readiness.service.ts:51-63` | `forDefinition` | Feeds `skillRequirements` into the pure `computeReadiness` (`readiness/workflow-readiness.ts:192-205`), which emits `SKILL_NOT_CONNECTED` **BLOCKER** issues + the `SKILLS` checklist row. |
| 3 | **Per-workflow read endpoint** — `workflows/workflows.controller.ts:301-312` (`GET /workflows/:id/skill-requirements`) | `forDefinition` | Returns the DTO verbatim. Any member may read. |
| 4 | **Bare-key read endpoint** — `skills/skills.controller.ts:60-72` (`GET /skills/requirements?skillKeys=a,b`) | `forSkillKeys` | Backs the in-chat card's 4s poll. |
| 5 | **AI Assist card emission** — `assist/agent/assist-agent.service.ts:331-349` | `forSkillKeys` | **Filters `requirements.filter((r) => r.requiresConnection)`** (`:338`) before emitting the `connection` stream event. |
| 6 | DI registration | `skills/skills.module.ts:139,172` (provider + export) | — |
| 7 | Unit spec | `skills/skill-requirements.service.spec.ts` (13 tests) | Pins today's behaviour, incl. `'treats a `none`-connection skill (http) as READY and non-blocking'` (`:95-103`). |

**Consequence chain for `chatwoot`/`plane` today, end to end:**
`projectStatus → 'READY'` → `isBlocking → false` → `allRequiredReady: true` → `assertPublishable` returns →
`computeReadiness` skips it (`workflow-readiness.ts:193` — `if (!req.required || !req.requiresConnection) continue;`)
→ `SKILLS` check renders PASS → `assist-agent.service.ts:338` filters it **off the in-chat card entirely** →
publish succeeds → first real run returns `ok:false, 'Chatwoot not connected for this company'`.
**Four independent surfaces all say "fine" and none of them ever mentions the skill.** Confirmed.

Frontend consumers of the DTO (files that must change if the shape changes):
`apps/web/src/features/assist/components/SkillRequirementCard.tsx` (owns `STATUS_META:
Record<SkillRequirementStatus, …>` at `:292-304` — **a total `Record`, so a new union member is a compile
error there**, exactly the guard-rail CLAUDE.md's *"a cast is not a conversion"* memory wants),
`.../AssistChat.tsx`, `.../AssistMessage.tsx`, `.../useAssistStream.ts`,
`apps/web/src/features/skills/api.ts`, and
`apps/web/src/features/workflows/components/builder/ReviewPublishDialog.tsx:338` (`issue.fix?.kind ===
'CONNECT_SKILL'`). `apps/web/src/features/skills/schemas.ts` is a **pure type re-export** — no zod runtime
schema for the catalog/requirement DTOs on the web side, so no validator to keep in sync.

### 1.3 The catalog `connection` field — exact type, values, and the per-skill table

```ts
// packages/types/src/index.ts:832-844
/**
 * How a skill authenticates against its (real) backend. `api_key` prompts for a
 * secret key; `oauth` is a stubbed connect flow (real OAuth = TODO); `none` needs
 * no connection (mock/sandbox executors run without one either way).
 */
export type SkillConnectionType = 'oauth' | 'api_key' | 'none';

/** Connection descriptor for a catalog skill. */
export interface SkillConnectionDto {
  type: SkillConnectionType;
  /** Human label for the connect action, e.g. "Connect Slack". */
  label?: string;
}
```

Exactly three values; `label` is the only other field. `SkillDefinitionDto.connection: SkillConnectionDto`
(`:943`). The catalog authors `CatalogEntry = Omit<SkillDefinitionDto, 'executionSupport'>`
(`catalog.ts:27`) — i.e. **`connection` is hand-authored, `executionSupport` and per-tool `simulated` are
derived on the way out by `decorate()` (`catalog.ts:955-969`)**.

**All 17 skills** (`apps/api/src/modules/skills/catalog.ts`; `executionSupport` recomputed here from
`executionSupportFor` against `REAL_EXECUTION_TOOLS`):

| # | key | catalog line | `connection.type` | tools | real tools | `executionSupport` | provisioning reality |
|---|---|---|---|---|---|---|---|
| 1 | `slack` | :35 | `oauth` | 1 | 1 | REAL | self-service (adapter) |
| 2 | `email` (SMTP) | :79 | `api_key` | 1 | 1 | REAL | self-service (adapter) |
| 3 | `stripe` | :212 | `api_key` | 3 | 0 | SIMULATED | n/a (no executor) |
| 4 | `github` | :283 | `api_key` | 2 | 0 | SIMULATED | n/a (no executor) |
| 5 | `http` | :328 | **`none`** | 1 | 1 | REAL | **nothing to provision — correct** |
| 6 | `gmail` | :358 | `oauth` | 2 | 1 | **PARTIAL** | self-service (adapter) |
| 7 | `hubspot` | :400 | `oauth` | 2 | 0 | SIMULATED | n/a (no executor) |
| 8 | `jira` | :439 | `oauth` | 4 | 0 | SIMULATED | n/a (no executor) |
| 9 | `calendar` | :504 | `oauth` | 1 | 1 | REAL | self-service (adapter) |
| 10 | `gdrive` | :531 | `oauth` | 5 | 5 | REAL | self-service (adapter) |
| 11 | `scheduling` | :610 | **`none`** | 2 | 2 | REAL | **internal — correct** |
| 12 | `postiz` | :645 | **`none`** | 6 | 6 | REAL | **platform-admin only** (§1.4) |
| 13 | `marketing` | :727 | **`none`** | 1 | 1 | REAL | **internal — correct** |
| 14 | `chatwoot` | :749 | **`none`** | 4 | 4 | REAL | **NO creation path exists** (§1.4) |
| 15 | `plane` | :810 | **`none`** | 3 | 3 | REAL | **NO creation path exists** (§1.4) |
| 16 | `whatsapp` | :856 | `api_key` | 4 | 4 | REAL | self-service, but via a **separate table** (Fix 3) |
| 17 | `leads` | :928 | **`none`** | 1 | 1 | REAL | **internal — correct** |

Totals: **17 skills, 43 tools, 31 in `REAL_EXECUTION_TOOLS`** → **12 REAL, 1 PARTIAL (`gmail`), 4 SIMULATED**.
Inline comments on the three `none` entries that are *not* internal are worth quoting, because they document
the assumption that failed:
- `catalog.ts:645` — `connection: { type: 'none' }, // company-level OAuth-connect happens per-platform via start_connect_account, not a single skill-level connection`
- `catalog.ts:749` and `:810` — `connection: { type: 'none' }, // provisioned once per company at onboarding, not per-employee OAuth` — **there is no such onboarding step.**

> ⚠️ **Corrections to `03-skills-audit.md` §A:** the tally there says *"17 skills, 45 tools… names 30 of them…
> 11 skills REAL, 1 PARTIAL, 4 SIMULATED, 1 not scored"*. The real numbers are **43 tools, 31 real, 12 REAL
> skills** (`leads` **is** scored — it is REAL; `postiz` is REAL on all 6 tools). Nothing downstream depends on
> the wrong figures, but a plan that quotes them will not add up.

### 1.4 Per-engine prerequisites — exact model, lookup site, and provisioning site

**`chatwoot`**

| | |
|---|---|
| Prerequisite row | `ChatwootAccount` (scoped `companyId`), fields `chatwootAccountId`, `agentBotToken` (encrypted), `webhookSecret` |
| Executor lookup | `executors/real-skill-executor.ts:1260-1265` — `prisma.chatwootAccount.findFirst({ where: { companyId: ctx.companyId } })` → `if (!account) return { ok: false, error: 'Chatwoot not connected for this company' };` |
| Provisioning | `engines/support/chatwoot-client.service.ts:72-107` — `provisionAccount()` documents an 8-step, source-grounded sequence then **`throw new Error('NOT YET IMPLEMENTED (provisionAccount for "…") — sequence documented above from source, but requires a live Chatwoot instance to verify before implementing for real; do not fabricate a "working" implementation that has never been run')`** (`:106`) |
| Adapter | `engines/support/chatwoot-engine.adapter.ts:42-50` — `connect()` rejects with `EngineCapabilityUnsupportedError(this.engineKey, 'connect', 'account provisioning needs a live Chatwoot instance to verify the sequence against; an account is registered out of band today')`; `capabilities()` at `:31-36` deliberately **omits `'connect'`** |
| Writers, repo-wide | **ZERO.** `grep -rn "chatwootAccount\.\(create\|upsert\)" apps/api/src` → no matches at all (not even in specs; the e2e fixtures use raw SQL/other paths). The only mutation is `deleteMany` (`chatwoot-engine.adapter.ts:53`) |

**`plane`**

| | |
|---|---|
| Prerequisite rows | `PlaneWorkspace` (`planeWorkspaceSlug`, `apiToken` encrypted) **and** `PlaneProject` (`planeWorkspaceId`, `planeProjectId`) — two rows, both needed |
| Executor lookup | `real-skill-executor.ts:1375-1386` (`create_issue`) — `planeProject.findFirst` → `'Plane not connected for this company'`, then `planeWorkspace.findFirst({ where: { id: project.planeWorkspaceId, companyId } })` → same error. Also `:1353-1357` (`list_issues`, `'PlaneProject not found for this company'`) and `:1426-1436` (`update_issue_status`) |
| Provisioning | `engines/pm/plane-client.service.ts:123-140` — `provisionWorkspace(): Promise<never>` with a 16-line source-grounded comment, then **`throw new Error('NOT YET IMPLEMENTED — requires a live Plane instance to verify the session-based provisioning sequence')`** (`:139`) |
| Adapter | `engines/pm/plane-engine.adapter.ts:44` — same `EngineCapabilityUnsupportedError` shape; header comment at `:32` |
| Writers, repo-wide | **ZERO** `planeWorkspace.create/upsert` in `apps/api/src`. Only `deleteMany` + reads |

**`postiz`**

| | |
|---|---|
| Prerequisite row | `SocialAccount` (`companyId`, `postizIntegrationId`, `status`), read at `real-skill-executor.ts:936-938` (`list_connected_accounts`), `:965-968` (`schedule_post` → `'SocialAccount not found for this company'`), `:1018-1021` (`publish_now`) |
| Prerequisite **column** | **`Company.postizCustomerGroupId`** |
| Writer of `SocialAccount` | `marketing/marketing.service.ts:149` (`update`) and **`:156-158` (`create`)**, inside `importAccounts(companyId)` |
| Gate on that writer | `marketing.service.ts:100-113` — reads `company.postizCustomerGroupId`; **`if (!company.postizCustomerGroupId) throw new ConflictException('This company has no Postiz customer group assigned yet, so connected accounts cannot be imported safely. Ask support to finish setting up social publishing.')`** |
| Sole writer of `postizCustomerGroupId` | **`marketing/postiz-tenancy.controller.ts:70-74`** (`PATCH internal/platform-admin/companies/:companyId/postiz-group`) — grep for the column across `apps/api/src` returns only this controller, `marketing.service.ts` reads, the DTO, and specs. **Confirmed: no self-service path.** |
| Guard | `postiz-tenancy.controller.ts:39-41` — `@Controller('internal/platform-admin/companies/:companyId/postiz-group')` + **`@UseGuards(PlatformAdminGuard)`**. Class doc `:19-27`: *"Every Orlixa company shares ONE Postiz instance, so this id is the entire boundary between one company's connected social accounts and another's… it is a tenant-isolation control, so it sits behind `PlatformAdminGuard`, whose token is signed with a secret distinct from the company JWT secret."* Doc `:32-37` adds that an operator must **also** tag the integration *inside Postiz* first, because Postiz's public API cannot (`PUT /:id/group` is internal-session only) |
| Tenant-facing half | `marketing/marketing.controller.ts` — `POST /marketing/accounts/import` (`@RequirePermission('marketing:manage')`) and `POST /marketing/accounts/connect`. So the customer *can* self-serve the last mile; they cannot self-serve the operator step that must precede it |

**Verdict:** `postiz` is **one operator step** away from usable per tenant (a deliberate isolation design,
not a gap). `chatwoot` and `plane` are **not reachable by any code path in the repository** — the gap is not
"no infra", it is "no writer". Both prior audits confirmed.

### 1.5 Recommended design

The four states the brief names map onto **two different axes**, and conflating them is what produces the
current bug. Keep them separate in the code and join them only at projection time:

* **Axis A — catalog fact (static, per skill): how can this skill's prerequisite ever come into existence?**
  Values: `NOT_REQUIRED` · `SELF_SERVICE` · `OPERATOR_ASSISTED` · `UNAVAILABLE`.
* **Axis B — tenant fact (dynamic, per company): does the prerequisite actually exist right now?**
  Already exists for `oauth`/`api_key` skills (`InstalledSkill.connectionStatus`); **does not exist at all**
  for the four engine skills, because their prerequisite lives in another table.

The requested user-facing vocabulary is then a pure function of (A, B):

| A `provisioning` | B prerequisite present? | projected requirement status |
|---|---|---|
| `NOT_REQUIRED` | — | `NO_CONNECTION_REQUIRED` (non-blocking) |
| `SELF_SERVICE` | yes | `CONNECTION_REQUIRED_AND_AVAILABLE` → today's `READY` |
| `SELF_SERVICE` | no | today's `NOT_CONNECTED` / `DEGRADED` / `DISCONNECTED` (unchanged, blocking) |
| `OPERATOR_ASSISTED` | no | **`SUPPORTED_BUT_NOT_CONFIGURED`** (blocking; message names the support step, not a Connect button) |
| `OPERATOR_ASSISTED` | yes | `CONNECTION_REQUIRED_AND_AVAILABLE` → `READY` |
| `UNAVAILABLE` | — | **`CANNOT_CURRENTLY_BE_CONNECTED`** (blocking; no fix action offered) |

**Recommendation A — add a catalog-authored, spec-guarded `provisioning` discriminator. Do NOT try to derive
it purely from source.**

The brief asks whether `real-execution-support.ts`'s mechanism can derive provisioning availability
automatically. It cannot, and the reason is instructive: **`real-execution-support.ts` is itself not
auto-derived** — it is a hand-maintained list (`REAL_EXECUTION_TOOLS`, `:30-62`) whose *spec* greps the
executor source for `case '…':` labels in both directions
(`real-execution-support.spec.ts:28-30, 33-45`). The thing it greps for is a **syntactic, one-to-one**
artefact: one `case` label per (skill, tool).

Provisioning availability has no such one-to-one artefact. The nearest greppable fact —
"does `prisma.<model>.create|upsert` appear outside a spec?" — answers a *different* question:

* it is **true** for `SocialAccount` (`marketing.service.ts:156`) even though a tenant cannot reach it
  without an operator first setting `postizCustomerGroupId` — so a pure grep would call `postiz`
  self-service, which is exactly the wrong answer;
* deciding "operator-only vs self-service" requires resolving a **guard on a controller**
  (`PlatformAdminGuard` vs `@RequirePermission`), i.e. tracing authz, not matching a token. That is not
  decidable by a regex, and a guard-tracing test would be a small static analyser — far more fragile than the
  fact it protects.

So: author the field, and **guard the one direction that a regex genuinely can decide** — that an
`UNAVAILABLE` skill has no writer, and that a non-`UNAVAILABLE` skill has one. That catches the only drift
that matters (someone implements `provisionAccount()` and forgets to flip the flag, or deletes the writer)
and it fails the build, in the same shape as `real-execution-support.spec.ts` / `capabilities.spec.ts` /
`node-catalog.spec.ts`. A bare hand-maintained field with no guard is the pattern this repo has *already*
been burned by twice (`schema.prisma:709-713`'s stale "inert until…" comment, per cluster 10 §5).

Concretely, in `apps/api/src/modules/skills/executors/` (next to its sibling, **not** in `catalog.ts`, so the
catalog stays declarative and there is one file that answers "can this be provisioned?"):

```ts
// NEW FILE: apps/api/src/modules/skills/executors/provisioning-support.ts
import type { SkillProvisioningModel } from '@vaep/types';

/** The tenant-scoped row (or Company column) a skill's real executor requires. */
export interface SkillPrerequisite {
  /** Prisma model the executor reads, in prisma-client camelCase. null = none. */
  readonly model: string | null;
  /** A Company column that must also be set (postiz's tenancy bridge). */
  readonly companyColumn?: string;
  /** How that row/column can come into existence TODAY. */
  readonly provisioning: SkillProvisioningModel;
  /** Where a customer goes, when they can act themselves. */
  readonly connectPath?: string;
  /** Why, in the customer's words, when they cannot. */
  readonly unavailableReason?: string;
}

export const SKILL_PREREQUISITES: Readonly<Record<string, SkillPrerequisite>> = {
  // Internal / nothing external to link.
  http:       { model: null, provisioning: 'NOT_REQUIRED' },
  scheduling: { model: null, provisioning: 'NOT_REQUIRED' },
  marketing:  { model: null, provisioning: 'NOT_REQUIRED' },
  leads:      { model: null, provisioning: 'NOT_REQUIRED' },

  // Credential-bearing InstalledSkill rows the generic connect flow owns.
  slack: { model: 'installedSkill', provisioning: 'SELF_SERVICE', connectPath: '/skills' },
  // …email, gmail, calendar, gdrive, stripe, github, hubspot, jira…

  // Dedicated connect surface, separate table (Fix 3).
  whatsapp: {
    model: 'whatsAppAccount',
    provisioning: 'SELF_SERVICE',
    connectPath: '/leads/whatsapp-connect',
  },

  // Operator step first: Company.postizCustomerGroupId is PlatformAdminGuard-only
  // (postiz-tenancy.controller.ts:39-41), and importAccounts refuses without it
  // (marketing.service.ts:107-113).
  postiz: {
    model: 'socialAccount',
    companyColumn: 'postizCustomerGroupId',
    provisioning: 'OPERATOR_ASSISTED',
    connectPath: '/marketing',
  },

  // provisionAccount()/provisionWorkspace() throw NOT YET IMPLEMENTED and there
  // is no create/upsert for these models anywhere in apps/api/src.
  chatwoot: {
    model: 'chatwootAccount',
    provisioning: 'UNAVAILABLE',
    unavailableReason:
      'Chatwoot support is not available yet — Orlixa cannot link a company to a ' +
      'Chatwoot account in this build, so this step would fail every time it ran.',
  },
  plane: {
    model: 'planeWorkspace',
    provisioning: 'UNAVAILABLE',
    unavailableReason:
      'Plane project tracking is not available yet — Orlixa cannot link a company ' +
      'to a Plane workspace in this build, so this step would fail every time it ran.',
  },
} as const;
```

`packages/types/src/index.ts` additions:

```ts
/**
 * How a skill's real-execution PREREQUISITE can come into existence today.
 * Distinct from `SkillConnectionType` (which auth mechanism) and from
 * `SkillExecutionSupport` (does executor code exist): a skill can have a fully
 * real executor and still be impossible to connect (chatwoot, plane).
 */
export type SkillProvisioningModel =
  | 'NOT_REQUIRED'      // internal capability — operational once installed
  | 'SELF_SERVICE'      // the customer can complete it unaided
  | 'OPERATOR_ASSISTED' // needs an Orlixa operator step first (postiz)
  | 'UNAVAILABLE';      // no code path can create the prerequisite in this build

export const SKILL_PROVISIONING_MODELS: readonly SkillProvisioningModel[] = [
  'NOT_REQUIRED', 'SELF_SERVICE', 'OPERATOR_ASSISTED', 'UNAVAILABLE',
] as const;
```

…and **three** new `SkillRequirementStatus` members, because the existing 11 have no honest home for these:

```ts
export type SkillRequirementStatus =
  | 'READY'
  | 'NO_CONNECTION_REQUIRED'          // NEW — non-blocking, replaces the READY lie for `none` skills
  | 'SUPPORTED_BUT_NOT_CONFIGURED'    // NEW — blocking, operator step outstanding
  | 'CANNOT_CURRENTLY_BE_CONNECTED'   // NEW — blocking, no path exists
  | 'NOT_CONNECTED' | 'AUTHORIZING' | 'CONFIGURATION_REQUIRED' | 'VALIDATING'
  | 'DEGRADED' | 'DISCONNECTED' | 'EXPIRED' | 'REVOKED'
  | 'INSUFFICIENT_PERMISSION' | 'ERROR';
```

The brief's fourth name, `CONNECTION_REQUIRED_AND_AVAILABLE`, deliberately maps onto the **existing `READY`**
rather than a fifth value: `READY` already means exactly that, it is the value 6 call sites and
`isBlocking` key off, and renaming it would churn every consumer for no information gain. State that
explicitly in the plan so it reads as a decision, not an omission.

`isBlocking` must then become explicit rather than `!== 'READY'`:

```ts
private isBlocking(r: WorkflowSkillRequirementDto): boolean {
  if (!r.required) return false;
  return r.status !== 'READY' && r.status !== 'NO_CONNECTION_REQUIRED';
}
```

**Recommendation B — resolve Axis B against the row the executor actually reads.** This is the part that
makes the new states truthful rather than decorative, and it is the same fix Fix 3 needs. Today
`buildRequirements` only ever calls `this.skills.findInstalledConnection(...)`
(`skill-requirements.service.ts:99-103`), which reads `InstalledSkill` — a table three of the four engine
skills never touch. Add one narrow, injected resolver:

```ts
// NEW FILE: apps/api/src/modules/skills/skill-prerequisite.service.ts (PrismaService-only ⇒ cycle-safe)
@Injectable()
export class SkillPrerequisiteService {
  constructor(private readonly prisma: PrismaService) {}

  /** Does the row/column this skill's real executor reads exist for this company? */
  async isSatisfied(companyId: string, skillKey: string): Promise<boolean | null> {
    const pre = SKILL_PREREQUISITES[skillKey];
    if (!pre || pre.model === null || pre.model === 'installedSkill') return null; // n/a — caller keeps today's logic
    switch (skillKey) {
      case 'whatsapp': return (await this.prisma.whatsAppAccount.count({ where: { companyId } })) > 0;
      case 'chatwoot': return (await this.prisma.chatwootAccount.count({ where: { companyId } })) > 0;
      case 'plane':    return (await this.prisma.planeWorkspace.count({ where: { companyId } })) > 0;
      case 'postiz':   return (await this.prisma.socialAccount.count({
                                 where: { companyId, status: 'CONNECTED' } })) > 0;
      default: return null;
    }
  }
}
```

A `switch` rather than a dynamic `this.prisma[pre.model]` index **on purpose**: the dynamic form loses all
Prisma typing and would silently return `undefined` for a typo'd model name — the exact silent-zero class
this codebase has already been bitten by (`increment` on a nullable column). The `SKILL_PREREQUISITES.model`
string then exists solely for the drift-guard spec to grep on, and a spec asserts the switch covers every
non-null, non-`installedSkill` model.

**Recommendation C — the drift guard (the part that keeps it honest).**

```ts
// NEW: apps/api/src/modules/skills/executors/provisioning-support.spec.ts
// Same technique as real-execution-support.spec.ts: read the SOURCE, not a comment.
// 1. every catalog skill appears in SKILL_PREREQUISITES (and vice versa)
// 2. for each UNAVAILABLE skill: grep apps/api/src/**/*.ts (excluding *.spec.ts) for
//    `<model>.create(` / `.upsert(` → MUST be empty. The day provisionAccount() lands,
//    this test fails and forces the flag to move.
// 3. for each SELF_SERVICE/OPERATOR_ASSISTED skill with a non-null model: that grep
//    MUST be non-empty. A deleted writer can no longer masquerade as available.
// 4. every UNAVAILABLE skill carries an `unavailableReason`; every SELF_SERVICE one a `connectPath`.
// 5. SkillPrerequisiteService's switch covers every non-null/non-installedSkill model.
```

**Files that must change (Fix 1), exhaustive:**

*Backend*
1. `packages/types/src/index.ts` — add `SkillProvisioningModel` + `SKILL_PROVISIONING_MODELS`; add 3 members to `SkillRequirementStatus` + `SKILL_REQUIREMENT_STATUSES`; add `provisioning: SkillProvisioningModel` (+ optional `connectPath`, `unavailableReason`) to `SkillDefinitionDto`; add `provisioning` + `connectPath` + `unavailableReason` to `WorkflowSkillRequirementDto`.
2. **NEW** `apps/api/src/modules/skills/executors/provisioning-support.ts`.
3. **NEW** `apps/api/src/modules/skills/executors/provisioning-support.spec.ts`.
4. **NEW** `apps/api/src/modules/skills/skill-prerequisite.service.ts`.
5. `apps/api/src/modules/skills/catalog.ts` — `decorate()` (`:955-969`) also stamps `provisioning`/`connectPath`/`unavailableReason` from `SKILL_PREREQUISITES`, keeping the "derived on the way out, never authored" rule intact.
6. `apps/api/src/modules/skills/capabilities.ts` — add `provisioningFor(skillKey)`; **leave `requiresConnection` alone** (it is the back-compat boolean).
7. `apps/api/src/modules/skills/skill-requirements.service.ts` — inject `SkillPrerequisiteService`; `buildRequirements` awaits `isSatisfied`; `projectStatus` gains the `provisioning` argument and the table above; `isBlocking` as shown; `humanStatus` needs no change (its `default:` handles new values).
8. `apps/api/src/modules/skills/skills.module.ts` — provide + export `SkillPrerequisiteService`.
9. `apps/api/src/modules/workflows/readiness/workflow-readiness.ts:192-205` — stop keying on `requiresConnection`; key on the new status. Emit `SKILL_NOT_CONNECTABLE` (BLOCKER, `fix: null`) for `CANNOT_CURRENTLY_BE_CONNECTED` and `SKILL_NEEDS_SETUP_ASSISTANCE` (BLOCKER, `fix: null`) for `SUPPORTED_BUT_NOT_CONFIGURED`, using `unavailableReason` as the message. `WorkflowReadinessIssueDto.code` is a plain `string` (`packages/types/src/index.ts:1409`), so **no union to extend**; `WorkflowReadinessFix.kind` (`:1403`) is a union but stays untouched because these issues have no fix action.
10. `apps/api/src/modules/assist/agent/assist-agent.service.ts:338` — 🔴 **the filter `requirements.filter((r) => r.requiresConnection)` must change**, or `chatwoot`/`plane` remain invisible on the in-chat card even after everything else is fixed. New predicate: `r.status !== 'NO_CONNECTION_REQUIRED'`.
11. `apps/api/src/modules/product-context/capability-resolver.ts:341-402` — `resolveSkillStatuses` currently returns `AVAILABLE`/`RECOMMENDED` for an uninstalled `chatwoot`/`plane`, i.e. the discovery screen invites the customer to install them. Add an `UNAVAILABLE`-aware band. `SkillStatus` (`packages/types/src/index.ts:3977-3987`) gains e.g. `'NOT_AVAILABLE_YET'`, and the `rank: Record<SkillStatusDto['status'], number>` at `:392-398` is a **total Record** → compile error until updated (good).

*Frontend*
12. `apps/web/src/features/assist/components/SkillRequirementCard.tsx` — `STATUS_META: Record<SkillRequirementStatus, …>` (`:292-304`) must gain 3 entries (compile error otherwise); the `req.connectionType === 'oauth'` branch (`:227`) needs a fourth arm that renders `unavailableReason` with **no** action for `CANNOT_CURRENTLY_BE_CONNECTED`, and a "contact support" line for `SUPPORTED_BUT_NOT_CONFIGURED`; the `rows` filter (`:90`) mirrors change #10.
13. `apps/web/src/features/skills/components/SkillCatalog.tsx` — `STATUS_ORDER`/`STATUS_LABEL`/`STATUS_STYLE` (`:29-51`) are total `Record<SkillStatus, …>`s → must gain the new band; the pre-install notice block (`:132-149`) should also say "not available yet" for `UNAVAILABLE`.
14. `apps/web/src/features/skills/components/SkillSetupWizard.tsx` — for an `UNAVAILABLE` skill, refuse the wizard outright instead of walking to `done` (see Fix 3/4; today four skills — `scheduling`, `postiz`, `chatwoot`, `plane` — already take the `!canReturnToDetails` path documented at `:70-80`).
15. `apps/web/src/features/skills/components/ConnectSkillControl.tsx:53-55` — `if (type === 'none') return <span>No connection required</span>;` is **wrong for `chatwoot`/`plane`/`postiz`**; branch on `def.provisioning`.
16. `apps/web/src/features/workflows/components/builder/ReviewPublishDialog.tsx:322-365` — `IssueRow` renders nothing when `fix` is null, which is acceptable, but the new blockers deserve a distinct tone; verify the message reads well verbatim.

**Blast radius / risk.** Because `assertPublishable` no-ops in `SKILL_EXECUTOR=mock`
(`skill-requirements.service.ts:129` + `:51-53`) and that is the e2e suite's mode, promoting
`chatwoot`/`plane` to a publish blocker **should not break the offline suite**. Two suites need an explicit
check: `test/e2e/engines-support.e2e-spec.ts` overrides the *executor provider* via `overrideProvider`, not
`ConfigService`, so `SKILL_EXECUTOR` stays `mock` for the requirements service — but this must be *verified by
running*, not assumed. The readiness **endpoint** always reports true state regardless of mode
(`skill-requirements.service.ts:41-42`), so `/workflows/:id/readiness` **will** start reporting a blocker in
mock mode too — which is the desired honesty, and which will break
`workflow-ux-simplification.e2e-spec.ts`'s "readiness agrees with publish" invariant if a fixture uses a
`none`-connection engine skill. 🔴 **Check that suite's fixtures first**; the invariant
`ready === (publish would succeed)` is explicitly mode-dependent once the two disagree.

---

## Fix 2 — `chatwoot.resolve_conversation` is catalogued REAL but hardcoded to always fail

### 2.1 Confirmed, with exact lines

Registry (`apps/api/src/modules/skills/executors/real-execution-support.ts:53`):

```ts
  'chatwoot.list_open_conversations',
  'chatwoot.get_conversation',
  'chatwoot.reply_to_conversation',
  'chatwoot.resolve_conversation',   // :53
```

Switch label: `real-skill-executor.ts:263-264` → `case 'chatwoot.resolve_conversation': return await this.chatwootResolveConversation(args, ctx);`

Handler (`real-skill-executor.ts:1311-1341`) — after two arg/ownership guards it **unconditionally** returns
a failure:

```ts
    // S-02: ChatwootClientService has no live resolve/toggle-status call yet —
    // a prior version of this method silently updated only Orlixa's own mirror
    // row and reported ok:true, which is a silent-success defect (the real
    // Chatwoot ticket stays open). Per this codebase's own discipline for
    // provisionAccount() (never fabricate an unverified "working" call), this
    // returns an honest failure instead of a fake success. Do NOT update the
    // local mirror on this path — a status that claims RESOLVED while the
    // real ticket is still open is worse than no status change at all.
    return {
      ok: false,
      error:
        'resolve_conversation is NOT YET IMPLEMENTED against the real Chatwoot API — ' +
        'no verified toggle-status call exists yet (needs either a source-grounded read of ' +
        "Chatwoot's conversations controller, mirroring how sendReply/verifyWebhookSignature " +
        'were verified, or a live instance to test against). The conversation was NOT resolved.',
    };
```

Because all 4 chatwoot tools are in the registry, `executionSupportFor('chatwoot', […4])`
(`real-execution-support.ts:96-104`) returns `'REAL'`, and `decorate()` (`catalog.ts:962-967`) leaves
`simulated` **absent** on this tool — so `SkillCatalog.tsx:132` (`skill.executionSupport !== 'REAL'`) renders
**no warning at all**. Confirmed.

### 2.2 How `github.remove_collaborator` is handled differently — the quote

It is **absent from `REAL_EXECUTION_TOOLS`** (grep: no `github.*` entry) and the reason is in the catalog,
`catalog.ts:305-310`:

```ts
      {
        // No real executor case exists for this (intentional — revoking a real
        // person's org access is a destructive, hard-to-reverse action on a
        // live external system). Always falls through to the mock executor.
        name: 'remove_collaborator',
        description: 'Remove a collaborator\'s access to a repository (simulated — no live GitHub call is made).',
```

Two differences from `resolve_conversation`: (a) no `case` exists, so `decorate()` stamps `simulated: true`
and the UI warns; (b) the **description itself** says "simulated". `resolve_conversation`'s description
(`catalog.ts:788`) says only `'Mark a conversation as resolved.'`, while its `highRisk` comment
(`catalog.ts:789-794`) *does* admit *"Currently always returns a NOT_IMPLEMENTED failure (S-02); this flag is
kept ready for when a real Chatwoot resolve call is added."* — i.e. **the truth is in a code comment and
nowhere in the API response.**

### 2.3 Would the drift-guard spec need updating? **Yes — it would FAIL.**

`real-execution-support.spec.ts` asserts **both** directions (`:32-45`):

```ts
  const casesInSource = [
    ...executorSource.matchAll(/case '([a-z_]+\.[a-z_]+)':/g),
  ].map((m) => m[1]);

  it('lists every case the executor actually implements', () => {
    const missing = casesInSource.filter((ref) => !REAL_EXECUTION_TOOLS.includes(ref));
    expect(missing).toEqual([]);
  });

  it('claims nothing the executor does not implement', () => {
    const overclaimed = REAL_EXECUTION_TOOLS.filter((ref) => !casesInSource.includes(ref));
    expect(overclaimed).toEqual([]);
  });
```

So **deleting the entry alone breaks the build** — the first test would report
`missing: ['chatwoot.resolve_conversation']`. This is the guard working correctly: it is telling you the
registry's vocabulary is too coarse (it has "case exists" and "case absent", but the truth is "case exists
and can never succeed").

### 2.4 Recommended minimal change

1. `real-execution-support.ts`: **remove** `'chatwoot.resolve_conversation'` from `REAL_EXECUTION_TOOLS` and
   add a third, explicitly-named list:

```ts
/**
 * Tools that HAVE a `case` in RealSkillExecutor and can never succeed — the case
 * exists only to return an honest, source-cited failure instead of letting the
 * `default:` branch answer from the sandbox.
 *
 * Kept SEPARATE from REAL_EXECUTION_TOOLS (which would over-claim) and from
 * plain omission (which would under-claim: `simulated` means "you get a
 * plausible sample result", and this returns no result at all). The drift guard
 * asserts each entry really is a case AND really is unimplemented, so the day
 * one is implemented the test fails and forces it to move lists.
 */
export const NOT_IMPLEMENTED_TOOLS: readonly string[] = [
  'chatwoot.resolve_conversation',
] as const;

/** True when the tool has an executor case that is hardcoded to fail. */
export function isNotImplemented(skillKey: string, tool: string): boolean { … }
```

2. `real-execution-support.spec.ts`: change the "lists every case" filter to
   `casesInSource.filter((ref) => !REAL_EXECUTION_TOOLS.includes(ref) && !NOT_IMPLEMENTED_TOOLS.includes(ref))`,
   and add: (a) each `NOT_IMPLEMENTED_TOOLS` pair exists in the catalog, (b) each has a `case` in the source,
   (c) `NOT_IMPLEMENTED_TOOLS ∩ REAL_EXECUTION_TOOLS = ∅`, (d) — the important one — the executor **source
   text** between that `case`'s handler start and the next `private async` contains
   `NOT YET IMPLEMENTED`, so implementing the tool without moving the list fails the build.

3. `packages/types/src/index.ts` — `ToolDefinitionDto` gains a sibling to `simulated`:

```ts
  /**
   * True when this tool has an executor case that ALWAYS fails (no verified
   * provider call exists yet). Distinct from `simulated`: a simulated tool
   * returns a plausible sandbox result, this one returns an honest error.
   */
  notImplemented?: boolean;
```

4. `catalog.ts` `decorate()` (`:955-969`) stamps `notImplemented: true` from `isNotImplemented(...)` and
   **must not** stamp `simulated` for the same tool.

5. `apps/web/src/features/skills/components/SkillCatalog.tsx:132-149` — split the PARTIAL sentence into two
   clauses: `…t.simulated` → "produce sample results, not real ones"; `…t.notImplemented` → "**are not
   available yet and will fail if used**".

**Knock-on effects to plan for:**
* `chatwoot.executionSupport` becomes **`PARTIAL`** (3 of 4). `hasAnyRealExecution('chatwoot')` stays `true`,
  so `OAuthService.assertCanActuallyAct` (`oauth/oauth.service.ts:94-103`) and
  `SkillsService.assertNotSimulatedInProduction` (`skills.service.ts:576-584`) are unaffected.
* No spec asserts `chatwoot` is `REAL`. `test/phase1-safety.e2e-spec.ts:266-297` only pins
  hubspot/jira/github/stripe = SIMULATED, gmail = PARTIAL, and stripe's per-tool `simulated` flags. Safe.
* `capabilities.ts:60-63` keeps `SUPPORT_REPLY: [chatwoot.reply_to_conversation, chatwoot.resolve_conversation]`;
  `capabilities.spec.ts` only asserts the pairs exist in the catalog, which they still do. No change needed.
  (Worth a plan note: `SUPPORT_REPLY` is now satisfiable by one working tool out of two.)
* `tool-approval-policy.ts:124` (`'chatwoot:resolve_conversation'` in the external-action list) and its spec
  (`tool-approval-policy.spec.ts:16,32`) are independent of the registry. No change.
* `real-skill-executor.spec.ts:892-959` already pins the honest failure — **keep it**, it becomes the proof
  that entry (d) above is true.

**Do NOT "fix" this by deleting the `case`.** With no case, `default:` (`real-skill-executor.ts:283-296`)
returns the fail-closed refusal in production but delegates to `MockSkillExecutor` everywhere else — which
fabricates `{ id: 'mock_resolve_conversation_…', sandbox: true, ok: true }` (`mock-skill-executor.ts:41-47`).
That would re-introduce the exact silent-success defect the comment at `:1325-1332` says was already fixed
once.

---

## Fix 3 — WhatsApp's generic connect path

### 3.1 The provider-adapter contract, in full

File: `apps/api/src/modules/skills/providers/provider-adapter.ts` (304 lines). The contract
(`:86-134`), verbatim:

```ts
export interface SkillProviderAdapter {
  /** Catalog skillKey this adapter serves. */
  readonly key: string;

  /**
   * §3 AUTHENTICATING → AUTHENTICATED. A real authenticated handshake with the
   * provider. This is the check that makes `connect` mean something.
   */
  validateCredentials(input: AdapterInput): Promise<AdapterCheck>;

  /** §3 DISCOVERING_ACCOUNT — which external identity did we just connect? */
  discoverAccount?(input: AdapterInput): Promise<DiscoveredAccount>;

  /** §3 TESTING — a real, non-destructive action proving the connection works end to end. */
  test?(input: AdapterInput, opts?: { to?: string; requesterEmail?: string }): Promise<AdapterCheck>;

  /** §3 CONFIGURING_INBOUND — can this connection RECEIVE? */
  validateInbound?(input: AdapterInput): Promise<AdapterCheck>;

  /** §33 — the cheap recurring liveness check. */
  healthCheck?(input: AdapterInput): Promise<AdapterCheck>;

  /** Map a thrown provider error onto the §3 vocabulary. */
  classifyError(error: unknown): ConnectionFailureCode;
}

export interface AdapterInput { creds: Record<string, unknown>; config: Record<string, unknown>; }
export interface AdapterCheck { ok: boolean; detail?: string; code?: ConnectionFailureCode; assumed?: boolean; }
export interface DiscoveredAccount { account: string | null; metadata?: Record<string, unknown>; }
export type VerifyStepKey = 'credentials' | 'account' | 'outbound' | 'inbound' | 'health';
export type ConnectionFailureCode =
  | 'AUTH_FAILED' | 'INVALID_CREDENTIALS' | 'INSUFFICIENT_SCOPE' | 'ACCOUNT_NOT_FOUND'
  | 'CONNECTION_FAILED' | 'TEST_FAILED' | 'WEBHOOK_FAILED' | 'HEALTH_CHECK_FAILED'
  | 'EXPIRED' | 'REVOKED' | 'DEGRADED' | 'ERROR';
```

Registry: `ADAPTERS = new Map<string, SkillProviderAdapter>()` (`:144`), `registerProviderAdapter` (`:146`),
`getProviderAdapter` returns **`null`** for an unregistered key (`:151-155`), `adapterKeys()` (`:158-160`).
`runVerification` (`:170-283`) runs credentials → account → inbound → test, short-circuiting on the first
failure, and marks unrun stages `SKIPPED` (never `PASSED`).

**Adapters registered — exactly five** (`providers/index.ts:19-23`):

```ts
registerProviderAdapter(smtpAdapter);    // email
registerProviderAdapter(gmailAdapter);
registerProviderAdapter(calendarAdapter);
registerProviderAdapter(gdriveAdapter);
registerProviderAdapter(slackAdapter);
```

with the file's own rationale (`:8-18`): *"Importing THIS file is what turns a provider on… Only providers
with a REAL verification live here. A skill listed without a working `validateCredentials` would make the
§37 gate reject connections it has no way to check, which is worse than the permissive path it replaces."*
**No `whatsapp` adapter.** Confirmed.

### 3.2 The validation gate in `connectSkill` — exact lines

`apps/api/src/modules/skills/skills.service.ts:311-393`. The gate is `:338-361`:

```ts
    const adapter = getProviderAdapter(installed.skillKey);          // :338
    if (adapter) {                                                   // :339
      const check = await adapter.validateCredentials({ creds: mergedCreds, config: … });
      if (!check.ok) { …audit 'connector.connect_failed'…; throw new BadRequestException(…); }
    }                                                                // :361
    const row = await this.prisma.installedSkill.update({
      where: { id },
      data: {
        credentials: this.sealCredentials(mergedCreds),
        connectionType: def.connection.type,
        connectionStatus: 'CONNECTED',                               // :368  ← unconditional
        consecutiveErrors: 0, lastHealthError: null, disabledReason: null,
        tokenExpiresAt: this.parseExpiry(mergedCreds),
      },
    });
```

with the comment at `:335-337`: *"Skills WITHOUT an adapter keep the previous behaviour on purpose — see the
provider-adapter header. Only providers that can actually be checked are held to the gate."*
`assertNotSimulatedInProduction` (`:318` → `:576-584`) does not fire, because `whatsapp.executionSupport ===
'REAL'`. **So: `POST /skills/installed/:id/connect` with `{credentials:{apiKey:"anything"}}` writes
`connectionStatus: 'CONNECTED'` for `whatsapp` with zero validation. Confirmed.**

### 3.3 🔴 Correction to `03-skills-audit.md` §E4 — the *generic Skills page* does not take that route

The audit says the `/skills` page's connect form posts to `connectSkill`. It does not, any more. Traced:

`InstalledSkillList.tsx:225-234` mounts **`SkillSetupWizard`**, not `ConnectSkillControl`. In the wizard
(`SkillSetupWizard.tsx`):
* `needsOAuth = def.connection?.type === 'oauth' && !installed.credentialsSet` (`:61`) → **false** for `whatsapp`.
* `whatsapp` has 3 `configSchema` fields (`catalog.ts:857-861`), so `hasNoConfig` is false and the initial stage is `'details'` (`:82-93`).
* `'details'` + `!needsOAuth` renders **`ConfigureSkillForm`** (`:172-177`), which PATCHes **`/skills/installed/:id/config`** (`ConfigureSkillForm.tsx:56-59`) → `SkillsService.configureSkill` (`skills.service.ts:269-300`). That method writes `config` + encrypted `credentials` and **never touches `connectionStatus`**.
* `onDone` → stage `'verify'` → auto-runs `verifyConnection` (`:122-134`) → `skills.service.ts:1258-1277`: no adapter ⇒ returns a single **SKIPPED** step, `adapterAvailable: false`, and **leaves `connectionStatus` unchanged**.

So on the generic Skills page today the badge stays **`Not connected`** — the "green Connected badge" is
**not** what a user gets there. What they get instead is a **false readiness claim in words**
(`SkillSetupWizard.tsx:206-209` and `:272-277`):

```tsx
              <p className="text-sm text-app-ink-2">
                Orlixa can&apos;t automatically verify this provider yet — your settings
                are saved and this skill is ready to use.
              </p>
…
            <p className="text-sm text-app-ink-2">
              {def.name} is set up. Automatic verification isn&apos;t available for this
              provider yet.
            </p>
```

"**your settings are saved and this skill is ready to use**" is false for `whatsapp` in two independent ways:
the Twilio credentials were never checked, **and** they were written to a table
(`InstalledSkill.credentials`) that `RealSkillExecutor`'s whatsapp handlers never read.

**The `CONNECTED`-badge path still exists** — but only via the raw endpoint, because
`ConnectSkillControl`'s `api_key` branch (`:115-166`) is currently unreachable for `whatsapp` from both of
its two mount points: `SkillSetupWizard.tsx:170` mounts it only when `needsOAuth`, and
`EmployeeSkillPicker.tsx:73-77` filters `def.connection?.type === 'oauth'`. So the badge lie is an **API-level**
defect (any ADMIN with `skill:connect`, plus anything scripted), not a UI-level one. The plan should fix the
endpoint regardless — "hidden in the UI is not a control" is this codebase's own stated rule
(`oauth.service.ts:85-87`).

### 3.4 The real prerequisite + the correct connect path

Executor lookup (`real-skill-executor.ts:1471-1476`) — with a comment explaining the `orderBy`:

```ts
  private async findWhatsAppAccount(companyId: string) {
    return this.prisma.whatsAppAccount.findFirst({
      where: { companyId },
      orderBy: { createdAt: 'asc' },
    });
  }
```

Used at `:1518-1519` (`send_message`) and `:1558-1559` (`send_template`) →
`if (!account) return { ok: false, error: 'No WhatsAppAccount configured for this company' };`
The handlers read `account.twilioAccountSid` / `crypto.decrypt(account.twilioAuthToken)` /
`account.whatsappSenderNumber` — **never `ctx.credentials`**. Confirmed.

`WhatsappAccountsService.connect()` verification logic
(`apps/api/src/modules/engines/whatsapp/whatsapp-accounts.service.ts:48-147`):

```ts
    // The real credential check: fetch the Twilio account these credentials
    // claim to be. A bad SID or token throws (401/404) and nothing is written
    // as CONNECTED. Deliberately BEFORE the upsert — a failed verification
    // must not leave a half-written row behind.
    await this.verifyTwilioCredentials(companyId, dto);                        // :67

    const row = await this.prisma.whatsAppAccount.upsert({                     // :69
      where: { companyId_whatsappSenderNumber: { companyId, whatsappSenderNumber: dto.whatsappSenderNumber } },
      create: { companyId, employeeId, twilioAccountSid: dto.twilioAccountSid,
                twilioAuthToken: this.crypto.encrypt(dto.twilioAuthToken),
                whatsappSenderNumber: dto.whatsappSenderNumber, status: 'CONNECTED' },
      update: { employeeId, twilioAccountSid: dto.twilioAccountSid,
                twilioAuthToken: this.crypto.encrypt(dto.twilioAuthToken), status: 'CONNECTED' },
    });
    await this.audit.record({ companyId, action: 'connector.verified', … });   // :92
```

`verifyTwilioCredentials` (`:117-147`) calls `TwilioWhatsappClientService.verifyCredentials({companyId,
accountSid, authToken})`, and on failure audits `connector.verify_failed` and throws
`BadRequestException('Twilio rejected these credentials — the account was not connected. (…)')`.
Surface: `POST /engines/whatsapp/accounts` (`whatsapp-accounts.controller.ts:31-38`,
`@RequirePermission('skill:connect')`); UI at `apps/web/src/app/(app)/leads/whatsapp-connect/page.tsx` +
`apps/web/src/features/whatsapp/components/WhatsAppConnectForm.tsx`. This is the **only** writer of
`whatsAppAccount` (`whatsapp-accounts.service.ts:69`; the only other match repo-wide is its own spec).
Confirmed.

### 3.5 🆕 F3-N1 — a *new* defect: `AutoSkillExecutor` refuses WhatsApp when it is correctly connected

Not in either prior audit. `executors/auto-skill-executor.ts:49-71`:

```ts
    const connectionType = SkillCatalog.get(skillKey)?.connection.type;
    const credsPresent = Boolean(ctx.credentials && Object.keys(ctx.credentials).length > 0);
    const connected = ctx.connectionStatus === 'CONNECTED';
    const eligible = connectionType === 'none' || (connected && credsPresent);   // :55-56
    if (eligible) return this.real.execute(skillKey, tool, args, ctx);
    if (this.failClosed) {
      const status = ctx.connectionStatus ?? 'NOT_CONNECTED';
      return Promise.resolve({ ok: false, error:
        `${skillKey} is not connected (status: ${status}${credsPresent ? '' : ', no stored credentials'}), ` +
        `so ${skillKey}.${tool} was not executed. Reconnect the skill in Settings → Skills. ` +
        'Refusing to return a simulated result in production.' });
    }
    return this.mock.execute(skillKey, tool, args, ctx);
```

`connectionType` for `whatsapp` is `api_key`, and eligibility is decided **entirely from `InstalledSkill`**.
So under `SKILL_EXECUTOR=auto` in production, a company that did everything right — connected via
`/leads/whatsapp-connect`, real verified Twilio creds, a live `WhatsAppAccount` row — gets a hard refusal
telling them to *"Reconnect the skill in Settings → Skills"*, which cannot help, because that surface writes
a table the executor ignores. And the **inverse** holds too: a junk `POST /skills/installed/:id/connect`
makes it `eligible`, routing to the real executor, which then fails on `findWhatsAppAccount`. Under
`SKILL_EXECUTOR=real` the auto gate is bypassed and the correct path works. **The two connect surfaces are
wired to opposite halves of the same decision.** This alone makes option (b) below insufficient on its own.

### 3.6 Recommended fix and trade-offs

**Recommended: (b) + (c), with (a) as a later convergence. All three are needed to close F3-N1.**

**(b) Make the generic path refuse and redirect.** Add `connectPath` to the catalog `connection` (or read it
from `SKILL_PREREQUISITES`, per Fix 1) and have `connectSkill` throw when a skill has a dedicated surface:

```ts
// skills.service.ts, immediately after assertNotSimulatedInProduction(def) at :318
this.assertNoDedicatedConnectSurface(def);   // 400: "Connect WhatsApp on the WhatsApp page — this
                                             //       form cannot store Twilio credentials."
```

*Files:* `apps/api/src/modules/skills/skills.service.ts` (+ mirror in `configureSkill` `:269`, which is the
one the UI actually reaches), `apps/api/src/modules/skills/catalog.ts` or the new
`provisioning-support.ts`, `packages/types/src/index.ts` (`SkillConnectionDto.connectPath?`),
`apps/web/src/features/skills/components/SkillSetupWizard.tsx` (render a link instead of
`ConfigureSkillForm`/`verify`), `.../ConnectSkillControl.tsx`, `.../SkillCatalog.tsx` ("Connect on the
WhatsApp page" instead of "Install"), plus specs.
*Trade-off:* smallest, safest, immediately honest — but it fixes only the **input** half. On its own it
leaves F3-N1 (auto-executor eligibility) and leaves the requirements/readiness surfaces still reading
`InstalledSkill`.

**(c) Resolve readiness *and* execution eligibility from the row the executor reads.** This is Fix 1's
Recommendation B, extended one step: `AutoSkillExecutor`'s `eligible` must consult the same prerequisite
resolver, not `ctx.connectionStatus`. Cleanest seam: `SkillsService.resolveExecutorContext` (which already
builds `ctx`) sets a new `ctx.prerequisiteSatisfied?: boolean` for skills whose prerequisite lives
elsewhere, and `auto-skill-executor.ts:55` becomes
`connectionType === 'none' ? … : (ctx.prerequisiteSatisfied ?? (connected && credsPresent))`.
*Files:* `apps/api/src/modules/skills/executors/skill-executor.ts` (`ExecutorContext`),
`.../auto-skill-executor.ts`, `apps/api/src/modules/skills/skills.service.ts` (`resolveExecutorContext`,
~`:1091-1117`), the new `skill-prerequisite.service.ts`, `skill-requirements.service.ts`, plus
`auto-skill-executor` unit coverage.
*Trade-off:* touches the execution hot path, so it needs the both-engine-modes e2e run; but it is the only
option that makes "the badge", "the readiness gate" and "what actually runs" agree, which is the invariant
this whole class of bug violates.

**(a) A real `whatsapp` provider adapter — worth doing, but not first.** `validateCredentials` maps cleanly
onto `TwilioWhatsappClientService.verifyCredentials`, and `discoverAccount` onto the Twilio account friendly
name. What does **not** map: the adapter contract has **no hook that can create or link an external row** —
every method returns a check, and `connectSkill` is the only writer. So (a) alone would still leave a
verified-but-useless `InstalledSkill` row. Doing (a) properly means either a new optional contract method
(e.g. `linkExternalAccount?(input, ctx): Promise<void>`) or making `SkillsModule` depend on
`WhatsappModule` — real coupling that the provider-adapter header explicitly designed against ("the registry
never imports the skills module"). *Files:* **NEW** `providers/whatsapp.adapter.ts`, `providers/index.ts`,
`provider-adapter.ts` (contract change), `skills.module.ts` (module import), `skills.service.ts`,
`providers/provider-adapter.spec.ts`, **NEW** `providers/whatsapp.adapter.spec.ts`.
*Trade-off:* the "right" long-term shape (one wizard for every skill) at the cost of a contract change and a
new cross-module dependency. Sequence it after (b)+(c) have made the product honest.

**Also fix regardless of option:** `SkillSetupWizard.tsx:206-209` and `:272-277` must stop saying *"ready to
use"* / *"is set up"* when `adapterAvailable === false`. That sentence is wrong for **every** adapter-less
skill (`whatsapp`, `stripe`, `github`, `hubspot`, `jira`, and all `none` skills that reach the wizard), not
just WhatsApp. Honest wording: *"Saved. Orlixa can't check these credentials automatically yet, so this is
unverified — the first real run is the first proof it works."*

---

## Fix 4 — Gmail is PARTIAL and the UI must say so

### 4.1 Confirmed

* `gmail.send_email` — `REAL_EXECUTION_TOOLS` (`real-execution-support.ts:33`), switch label
  `real-skill-executor.ts:225-226`, handler `private async gmailSendEmail(...)` at
  `real-skill-executor.ts:542`.
* `gmail.read_inbox` — catalog tool at `catalog.ts:382-392`; **absent from `REAL_EXECUTION_TOOLS`**; **no
  `case 'gmail.read_inbox':` anywhere** in the switch (read in full, `real-skill-executor.ts:220-297`). It
  falls to `default:` (`:283-296`):
  * `failClosed` (production) → `ok:false` — *"gmail.read_inbox has no real integration in this build — it
    can only be simulated, so it was NOT executed. Nothing was sent to gmail…"*
  * otherwise → `this.fallback.execute(...)` = `MockSkillExecutor` (`mock-skill-executor.ts:33-47`), which
    returns `{ ok:true, result: { id: 'mock_read_inbox_<hash>', echoed: args, sandbox: true } }`.
  So **no environment ever really reads Gmail.** Confirmed exactly as §B1 said.

### 4.2 How `PARTIAL` is computed

```ts
// apps/api/src/modules/skills/executors/real-execution-support.ts:89-104
/**
 * Classify a skill for the catalog DTO.
 *
 * `toolNames` is the skill's full tool list, so PARTIAL is honest: `gmail` has a
 * real `send_email` and a mock `read_inbox`, and calling that skill "REAL"
 * would be the same over-claim this whole file exists to stop.
 */
export function executionSupportFor(skillKey: string, toolNames: readonly string[]): SkillExecutionSupport {
  if (toolNames.length === 0) return 'SIMULATED';
  const real = toolNames.filter((tool) => isRealExecutionSupported(skillKey, tool)).length;
  if (real === 0) return 'SIMULATED';
  return real === toolNames.length ? 'REAL' : 'PARTIAL';
}
```

Called from `catalog.ts:958-961` inside `decorate()`, which also stamps per-tool
`simulated: true` for every tool not in the registry (`:962-967`).

### 4.3 What the frontend actually shows — REAL vs PARTIAL vs SIMULATED

Repo-wide, **`executionSupport` is read in exactly two frontend files** (`grep -rn "executionSupport\|\.simulated"
apps/web/src`):

**(1) `apps/web/src/features/skills/components/SkillCatalog.tsx:125-149` — the pre-install catalog card,
the only place PARTIAL is ever mentioned:**

```tsx
      {/*
        Say it BEFORE the Install button, not after a customer has wired it into
        a workflow. `SIMULATED` means no tool here reaches a real provider — the
        state HubSpot, Jira, GitHub and Stripe are in today. `PARTIAL` means some
        tools do and some do not (Gmail: sending is real, reading the inbox is
        not), which is worth saying too rather than rounding up to "works".
      */}
      {skill.executionSupport !== 'REAL' && (
        <p className={`mt-2 rounded-lg px-2 py-1 text-[11px] ${
            skill.executionSupport === 'SIMULATED'
              ? 'bg-status-warning/10 text-sl-warning'
              : 'bg-app-raised text-app-ink-3'          // ← PARTIAL: grey, lowest-emphasis style
          }`}>
          {skill.executionSupport === 'SIMULATED'
            ? 'Demo only — actions are simulated and never reach ' + skill.name + '.'
            : 'Partly simulated: ' +
              skill.tools.filter((t) => t.simulated).map((t) => t.name).join(', ') +
              ' produce sample results, not real ones.'}
        </p>
      )}
```

Renders for Gmail as: **"Partly simulated: read_inbox produce sample results, not real ones."** (note the
grammar bug — `.join(', ')` + `" produce"`, so a single tool reads *"read_inbox produce"*). Also note the
band badge (`STATUS_LABEL`, `:37-43`) for a PARTIAL-but-uninstalled skill is `RECOMMENDED` or `AVAILABLE` —
nothing in the badge says "partial".

**(2) `apps/web/src/features/skills/components/ConnectSkillControl.tsx:53-80` — the connect control. It
branches on `SIMULATED` only:**

```tsx
  if (type === 'none') {
    return <span className="text-xs text-app-ink-3">No connection required</span>;
  }
  …
  if (def.executionSupport === 'SIMULATED') {
    return (
      <span className="text-xs text-sl-warning">
        Demo only — nothing to connect yet
      </span>
    );
  }
```

**There is no `PARTIAL` arm.** Gmail renders an ordinary "Connect Gmail" OAuth button with the subtitle
`OAuth` (`:95-113`) and nothing else.

**So, to answer the brief's question directly: no.** A user connecting Gmail *today* is told nothing about
`read_inbox`:
* `InstalledSkillList.tsx` (the installed-skill card) never reads `executionSupport` — it shows
  `formatConnectionStatus(skill.connectionStatus)`, i.e. a green **`Connected`** pill (`:154-158`).
* `SkillSetupWizard.tsx` never reads it — its terminal state is *"Gmail is connected as user@…"* with a green
  tick (`:268-270`).
* `SkillRequirementCard.tsx` never reads it — a connected Gmail row renders
  `'Connected'` + *"**Connected — nothing more to do here.**"* (`:212-221`), even when the workflow's node is
  the `read_inbox` one, and even though the card lists the capability as **"Read email"**
  (`CAPABILITY_LABEL.EMAIL_READ`, `:308`) — an unqualified claim that Orlixa can read the inbox.
* `WorkflowSkillRequirementDto` carries no `executionSupport` and no per-tool data at all
  (`packages/types/src/index.ts:1123-1155`), so the AI-Assist / builder surfaces **cannot** say it without a
  DTO change.
* The one place a *run* is honest is `apps/web/src/features/assist/components/TestResultPanel.tsx:47-56`,
  which renders a **`Simulated`** pill per step with the tooltip *"Nothing was really sent — this step was
  simulated because it was a test run."* — accurate for a dry run, but it attributes the simulation to *"it
  was a test run"*, which for `gmail.read_inbox` is the wrong reason.

The message only ever appears **before** install, in the lowest-emphasis grey style, on a card the user
leaves the moment they click Install — and never again at any point in the connect flow, the installed list,
the workflow builder, or the assist card.

### 4.4 Recommended minimal honest-labeling fix

1. **Carry the fact into the requirement DTO.** `packages/types/src/index.ts` — add to
   `WorkflowSkillRequirementDto`:
   ```ts
   /** REAL / PARTIAL / SIMULATED, from the catalog — so a card can qualify "Connected". */
   executionSupport: SkillExecutionSupport;
   /** Tools this workflow USES that cannot really run (simulated or not-implemented). */
   unsupportedTools: string[];
   ```
   Populate in `skill-requirements.service.ts:203-219` (`toRequirement`) — it already has
   `SkillCatalog.has(dep.skillKey)` and `dep.tools`, so `unsupportedTools` is
   `[...dep.tools].filter(t => !isRealExecutionSupported(skillKey, t))`. **This is strictly better than a
   skill-level flag**: for a workflow that only sends mail, Gmail's `read_inbox` gap is irrelevant and should
   stay silent; for one that reads the inbox it is a blocker-grade fact.
2. **One shared component, three mount points.** New `apps/web/src/features/skills/components/SkillLimitationNotice.tsx`
   (props: `executionSupport`, `simulatedTools`, `notImplementedTools`), mounted in
   `InstalledSkillList.tsx` (next to the status pill — it already has `def` from `useCatalog()`),
   `SkillSetupWizard.tsx` (the `done` stage, `:265-285`), and `SkillRequirementCard.tsx` (`SkillRow`'s
   `done` branch, `:217-221`, replacing the bare *"nothing more to do here"* when `unsupportedTools.length > 0`).
3. **Fix the wording and the grammar** in `SkillCatalog.tsx:142-147`: pluralise correctly, and split
   `simulated` from Fix 2's `notImplemented` ("produce sample results" vs "are not available yet and will
   fail if used").
4. **Consider a readiness WARNING** (not a blocker) in `workflow-readiness.ts` when a required skill's
   `unsupportedTools` intersect the tools the graph actually calls — `code: 'TOOL_NOT_REAL'`,
   `severity: 'WARNING'`, `fix: { kind: 'OPEN_NODE', target: nodeId }`. That is the surface a workflow author
   is actually looking at when they choose `read_inbox`, and `WorkflowReadinessIssueDto.code` is a free
   `string` so it costs no type change.

*Files (Fix 4):* `packages/types/src/index.ts`; `apps/api/src/modules/skills/skill-requirements.service.ts`;
`apps/api/src/modules/workflows/readiness/workflow-readiness.ts`; **NEW**
`apps/web/src/features/skills/components/SkillLimitationNotice.tsx`;
`apps/web/src/features/skills/components/{SkillCatalog,InstalledSkillList,SkillSetupWizard,ConnectSkillControl}.tsx`;
`apps/web/src/features/assist/components/SkillRequirementCard.tsx`.

---

## Undetermined / must be checked by running

Flagged rather than guessed:

1. **Whether promoting `chatwoot`/`plane` to publish blockers breaks any e2e.** `assertPublishable` no-ops in
   `SKILL_EXECUTOR=mock`, and `test/e2e/engines-support.e2e-spec.ts` overrides the *executor provider*, not
   `ConfigService` — so it *should* be unaffected. Not verified by execution.
2. **`workflow-ux-simplification.e2e-spec.ts`'s "readiness agrees with publish" invariant.** The readiness
   *endpoint* reports true state in every mode while *publish* is gated on `SKILL_EXECUTOR !== 'mock'`. The
   moment readiness reports a `CANNOT_CURRENTLY_BE_CONNECTED` blocker, that invariant is mode-dependent.
   Whether any fixture in that suite uses a `none`-connection engine skill was not checked.
3. **Whether any workflow template ships a `chatwoot`/`plane` TOOL_ACTION.** If a first-party template in
   `hr-workflow-templates.catalog.ts` / `marketing-workflow-templates.catalog.ts` does, its boot-time
   `validateManifest` (guarded by `workflow-templates.catalog.spec.ts`) may need the new status taken into
   account. Not audited here.
4. **Exact Prisma column names/nullability** for `ChatwootAccount` / `PlaneWorkspace` / `PlaneProject` /
   `SocialAccount` / `WhatsAppAccount` — inferred from executor reads, not read from `schema.prisma`.
   Confirm before writing the `count()` queries. (Cluster 10 §5 is the standing warning that this schema's
   own comments understate reality.)
5. **Whether `postiz` should block publish as `SUPPORTED_BUT_NOT_CONFIGURED`.** A product call, not a code
   fact: it makes a real customer's publish fail until support acts, which is honest but may be judged worse
   than a loud warning. The plan should name it as a decision.
6. **`SKILL_REQUIREMENT_STATUSES` has zero consumers today** — extending it is free, but if the plan wants
   runtime validation of the union (a zod enum on the web side), that is new work, not an edit.

---

## What the implementation plan must do

Ordered so that each step's tests can pass on their own commit.

### Step 0 — Correct the audit's arithmetic (docs only)
`docs/audit/2026-09-08-kill-critic-audit/03-skills-audit.md` §A: **43 tools (not 45), 31 real (not 30), 12
REAL skills (not 11), `leads` IS scored**. Also amend §E4 per Fix 3 §3.3: the generic Skills page reaches
`configureSkill` + `verifyConnection`, not `connectSkill`; the badge stays `Not connected`; the lie is the
wizard's *"ready to use"* sentence, and the `CONNECTED` badge is reachable only via the raw endpoint.

### Step 1 — Fix 2 (smallest, isolated, no behaviour change for customers)
1. `real-execution-support.ts`: remove `'chatwoot.resolve_conversation'` from `REAL_EXECUTION_TOOLS:53`;
   add `NOT_IMPLEMENTED_TOOLS` + `isNotImplemented()`.
2. `packages/types/src/index.ts`: `ToolDefinitionDto.notImplemented?: boolean` (sibling of `simulated`, `:920`).
3. `catalog.ts` `decorate()` (`:955-969`): stamp `notImplemented`, and **do not** stamp `simulated` for the
   same tool.
4. `real-execution-support.spec.ts`: exclude `NOT_IMPLEMENTED_TOOLS` from the "lists every case" filter
   (`:33-38`); add the 4 new assertions incl. the source-grep for `NOT YET IMPLEMENTED` in the handler body.
5. `SkillCatalog.tsx:142-147`: split simulated vs not-available, fix the pluralisation.
**Tests required:** `real-execution-support.spec.ts` (new: registry/not-implemented partition; catalog
membership; source contains `NOT YET IMPLEMENTED`; `chatwoot.executionSupport === 'PARTIAL'`;
`hasAnyRealExecution('chatwoot') === true`). Re-run `phase1-safety.e2e-spec.ts` (should be untouched) and
`real-skill-executor.spec.ts:892-959` (must still pass unchanged).

### Step 2 — Fix 1 types + the provisioning registry + its drift guard (no behaviour change yet)
1. `packages/types/src/index.ts`: `SkillProvisioningModel` + `SKILL_PROVISIONING_MODELS`; the 3 new
   `SkillRequirementStatus` members + `SKILL_REQUIREMENT_STATUSES` entries; `provisioning` / `connectPath` /
   `unavailableReason` on `SkillDefinitionDto`; the same three plus `executionSupport` + `unsupportedTools`
   on `WorkflowSkillRequirementDto`.
2. **NEW** `executors/provisioning-support.ts` with `SKILL_PREREQUISITES` covering all 17 keys.
3. **NEW** `executors/provisioning-support.spec.ts` — the 5 guards in Fix 1 §Recommendation C.
4. `catalog.ts` `decorate()` stamps the three new fields.
5. Rebuild `@vaep/types` (`pnpm --filter @vaep/types build`) before running api tests — `nest start`
   resolves it from `dist`.
**Tests required:** `provisioning-support.spec.ts` — every catalog key present and vice versa; `chatwoot`/`plane`
are `UNAVAILABLE` **and** a source grep finds no `chatwootAccount.create|upsert` / `planeWorkspace.create|upsert`
outside `*.spec.ts`; `postiz` is `OPERATOR_ASSISTED` and `socialAccount.create` **is** found
(`marketing.service.ts:156`); every `UNAVAILABLE` entry has an `unavailableReason`; every `SELF_SERVICE` entry
has a `connectPath`.

### Step 3 — Fix 1 behaviour: prerequisite resolution + the new statuses
1. **NEW** `skills/skill-prerequisite.service.ts` (PrismaService-only) with the explicit `switch`.
2. `skills.module.ts`: provide + export it.
3. `skill-requirements.service.ts`: inject it; `buildRequirements:94-105` awaits `isSatisfied`;
   `projectStatus:227-251` takes `provisioning` and implements the (A,B) table; `isBlocking:150-152` becomes
   the explicit two-value allowlist; `toRequirement:188-219` populates the new DTO fields.
4. `capabilities.ts`: add `provisioningFor`; leave `requiresConnection:133-136` unchanged.
5. `workflow-readiness.ts:192-205`: key on status, not `requiresConnection`; emit
   `SKILL_NOT_CONNECTABLE` / `SKILL_NEEDS_SETUP_ASSISTANCE` (BLOCKER, `fix: null`) and the optional
   `TOOL_NOT_REAL` WARNING.
6. `assist-agent.service.ts:338`: change the filter to `r.status !== 'NO_CONNECTION_REQUIRED'`.
7. `capability-resolver.ts:341-402` + `SkillStatus`: new `NOT_AVAILABLE_YET` band (the `rank` Record at
   `:392-398` will force it).
**Tests required (unit):** in `skill-requirements.service.spec.ts` — `http` → `NO_CONNECTION_REQUIRED`,
non-blocking (replaces the `'READY'` assertion at `:95-103`); `chatwoot` with no row →
`CANNOT_CURRENTLY_BE_CONNECTED`, **blocking**; `plane` same; `postiz` with no `SocialAccount` →
`SUPPORTED_BUT_NOT_CONFIGURED`, blocking; `postiz` with one → `READY`; `whatsapp` with a `WhatsAppAccount` →
`READY` even when `InstalledSkill` is `NOT_CONNECTED`; `whatsapp` with a CONNECTED `InstalledSkill` and **no**
`WhatsAppAccount` → **not** `READY` (the exact §E4 lie); `assertPublishable` throws for a chatwoot graph in
`auto` and still no-ops in `mock`. Plus `provisioning-support.spec.ts` guard #5 (switch covers every model).
**Tests required (e2e):** extend `test/workflow-skill-requirements.e2e-spec.ts` with a chatwoot-node workflow
asserting `status === 'CANNOT_CURRENTLY_BE_CONNECTED'`, `allRequiredReady === false`, and that
`GET /workflows/:id/readiness` returns a BLOCKER with the `unavailableReason` message.
**Regression to run explicitly:** `workflow-ux-simplification.e2e-spec.ts` (the readiness↔publish invariant,
§Undetermined #2) and the full suite in **both** engine modes.

### Step 4 — Fix 3: close both halves of the WhatsApp seam
1. `skills.service.ts`: `assertNoDedicatedConnectSurface(def)` called from **both** `connectSkill:318` and
   `configureSkill:274` — the second is the one the UI reaches.
2. `executors/skill-executor.ts`: `ExecutorContext.prerequisiteSatisfied?: boolean`.
3. `skills.service.ts` `resolveExecutorContext` (~`:1091-1117`): populate it via `SkillPrerequisiteService`.
4. `auto-skill-executor.ts:55-56`: eligibility consults `ctx.prerequisiteSatisfied` when the skill's
   prerequisite is not `installedSkill` — closes **F3-N1**.
5. `SkillSetupWizard.tsx:206-209` and `:272-277`: replace *"ready to use"* / *"is set up"* with the unverified
   wording; for a skill with a `connectPath`, render a link to it instead of `ConfigureSkillForm`.
6. `ConnectSkillControl.tsx:53-55`: branch on `provisioning`, not `type === 'none'`.
7. `SkillCatalog.tsx`: "Connect on the WhatsApp page" for a `connectPath` skill.
**Tests required:** unit — `auto-skill-executor` routes to real when `prerequisiteSatisfied === true` and
`connectionStatus === 'NOT_CONNECTED'`, and refuses when `connectionStatus === 'CONNECTED'` but
`prerequisiteSatisfied === false` (both directions of F3-N1); `connectSkill('whatsapp')` throws 400.
e2e — `POST /skills/installed/:id/connect` for `whatsapp` → 400 naming `/leads/whatsapp-connect`; the
`whatsapp-lead-pipeline.e2e-spec.ts` pipeline still passes end to end.

### Step 5 — Fix 4: honest labelling everywhere the user actually looks
1. Populate `executionSupport` + `unsupportedTools` in `toRequirement`.
2. **NEW** `SkillLimitationNotice.tsx`; mount in `InstalledSkillList.tsx`, `SkillSetupWizard.tsx` (`done`),
   `SkillRequirementCard.tsx` (`SkillRow` done branch).
3. `SkillRequirementCard.tsx:292-304`: extend `STATUS_META` with the 3 new statuses (compile-enforced) and
   add the no-action arm for `CANNOT_CURRENTLY_BE_CONNECTED`.
**Tests required:** `apps/web/src/features/assist/__tests__/skillRequirementCard.test.tsx` — a Gmail row with
`unsupportedTools: ['read_inbox']` shows the limitation, not a bare "nothing more to do here"; a chatwoot row
renders the unavailable reason and **no** Connect button. One browser check (Playwright) of `/skills` →
install Gmail → the connect wizard, confirming `read_inbox` is named at least once after install — the
prior audits' own lesson is that these render-path bugs are only caught in a real browser.

### Step 6 — Verification discipline (from CLAUDE.md, not optional here)
* Rebuild `@vaep/types` before running api tests.
* Pin providers explicitly, or expect ~78 configuration failures:
  `LLM_PROVIDER=mock EMBEDDINGS_PROVIDER=hash STORAGE_PROVIDER=local SKILL_EXECUTOR=mock BILLING_PROVIDER=mock ENCRYPTION_KEY=<64 hex> npx jest --config ./test/jest-e2e.json --forceExit`
* Run e2e in **both** engine modes (`WORKFLOW_ENGINE_MODE=state_machine` and `legacy_walk`).
* Run at least one pass with `SKILL_EXECUTOR=auto` — Steps 3 and 4 change behaviour that is **invisible in
  `mock`**, which is precisely how the chatwoot/plane readiness lie survived this long.
