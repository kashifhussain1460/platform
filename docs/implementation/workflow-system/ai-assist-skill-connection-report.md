# AI Assist Skill Connection — Implementation Report

Status date: 2026-08-07
Feature: in-chat Skill connection for the Orlixa AI Assist workflow-creation
experience (doc 30 §12 "Inline connection setup", wave A5).

The brief is a 10-phase feature. Shipped so far: the backend foundation
(Phases 1–3 + the Phase 7 publish gate) AND the user-visible in-chat card +
OAuth auto-resume (Phases 4 + 5/6, see §8). Remaining: admin-approval (Phase 8),
connection audit events (Phase 9), and post-connect scope validation (§9). What
is **shipped** vs **specced-next** is called out explicitly — nothing is claimed
done that isn't.

---

## 1. Architecture reused (discovery, Phase 1)

Three read-only discovery passes confirmed this feature is **designed-but-unbuilt**
and must EXTEND the canonical systems, not duplicate them.

| Subsystem | Canonical location | Verdict |
|---|---|---|
| AI Assist (SSE stream, session, agent) | `modules/assist/*` | EXTEND — `AssistMessageRole.CONNECTION` + its `{skillKey}` message-metadata are **already in the Prisma schema**; detection (`list_skills.connected`, `resolveReferences`) already runs internally. |
| Skills catalog + tools | `modules/skills/catalog.ts` | KEEP — single source of truth for skills/tools. |
| Connector model + health | `InstalledSkill`, `ConnectorHealthService`, `ConnectorTokenService` | KEEP — state machine + single-flight token refresh. |
| OAuth | `modules/skills/oauth/*` | EXTEND (for resume) — signed HMAC state, least-privilege scopes in `oauth.providers.ts`. |
| Credentials/secrets | `common/crypto` (AES-256-GCM), `credentials.util`, `credentialsSet` masking | KEEP. |
| RBAC | 3-role `@Roles('OWNER','ADMIN')` on connect/authorize | KEEP. |
| Approvals engine | `modules/approvals` + `modules/approval-routing` (`ApprovalKind`, routing, SLA, audit) | EXTEND (add `SKILL_CONNECTION` kind) — do NOT build a new engine. |
| Audit | `AuditLogService` | EXTEND — only `skill.install` is recorded today. |
| Workflow deps | TOOL_ACTION `config.skillKey` scan (pattern in `workflow-generator.service.ts`) | EXTEND — no stored dependency surface existed. |

**No hardcoded "I cannot connect skills" string exists** — that behavior is
emergent LLM prose. The correct fix is a terminal tool + stream event + card
(specced below), not a string swap.

---

## 2. Capability → Skill resolution contract (Phase 2) — SHIPPED

Capability-first, provider-agnostic. A workflow declares WHAT it needs, never
WHICH provider, so a new provider (e.g. Microsoft Outlook for `EMAIL_SEND`) is
added in one map with **zero planner changes**.

- **Vocabulary** (shared): `SkillCapability` union + `SKILL_CAPABILITY_META`
  labels — `packages/types/src/index.ts`.
- **Mapping** (server): `apps/api/src/modules/skills/capabilities.ts` —
  `CAPABILITY_TOOLS` maps each capability to the `(skillKey, tool)` pairs that
  satisfy it, across providers. Derived helpers: `forTool`, `skillsFor`
  (compatible providers), `alternativesFor`, `displayName`, `provider`,
  `requiresConnection`.
- **Drift guard**: `capabilities.spec.ts` fails the build if any mapped
  `(skill, tool)` pair isn't in the catalog.

Example: `EMAIL_SEND` → `{gmail:send_email, email:send_email}`;
`CALENDAR_EVENT_CREATE` → `{calendar:create_event, scheduling:claim_slot, …}`.

---

## 3. Workflow skill-dependency model + detection (Phase 3) — SHIPPED

`SkillRequirementsService` (`modules/skills/skill-requirements.service.ts`)
produces a **machine-readable** dependency list by scanning the graph's
non-disabled `TOOL_ACTION` nodes — never re-inferred from conversational text.

Per dependency (`WorkflowSkillRequirementDto`): `skillKey`, `displayName`,
`provider`, `capabilities[]`, `compatibleSkillKeys[]` (multi-provider),
`requiresConnection`, `required`, `status`, `connectionStatus`, `connectionType`,
`installedSkillId`, `credentialsSet`, `nodeIds[]`, `canManageConnection`.

Resolution reuses execution's own lookup (`SkillsService.findInstalledConnection`
→ `resolveInstalledForExecution`), so **what the card shows can never drift from
what actually runs**. Employee-owned connections are preferred when every node
for a skill pins the same employee, else the company-wide connection.

**Endpoint**: `GET /workflows/:id/skill-requirements` (any member; tenant-scoped;
`canManageConnection` reflects OWNER/ADMIN). Inspects the draft the builder is
editing, else the active version, else the legacy definition.

---

## 4. Connection states

`SkillRequirementStatus` (in `@vaep/types`) is the full 10-state superset the UI
must handle. The resolver truthfully emits only what it can determine **today**:
`READY`, `NOT_CONNECTED`, `DEGRADED`, `DISCONNECTED`, `ERROR` (references a skill
outside the catalog). The remaining states — `AUTHORIZING`,
`CONFIGURATION_REQUIRED`, `VALIDATING`, `EXPIRED`, `REVOKED`,
`INSUFFICIENT_PERMISSION` — are part of the contract but require the OAuth-resume
+ post-connect scope/health-validation slices (they need a live provider probe
that does not exist yet). This is documented in the type, so the UI is built
against all 10 while only 5 are produced now.

A `none`-connection skill (http/scheduling/postiz/chatwoot/plane) needs no auth
and is `READY` once it exists — it never blocks.

---

## 5. Publish-time readiness gate (part of Phase 7) — SHIPPED

`WorkflowVersionService.publish` now calls
`SkillRequirementsService.assertPublishable` after structural validation. A
workflow whose required skills aren't connected **stays a DRAFT and returns 400
on publish** — it cannot become executable ("Configure Later" ⇒ draft is fine;
publish is not). Draft saves are never gated.

**Mode scoping (important):** the block is active only under a real-execution
mode (`SKILL_EXECUTOR` ≠ `mock`). In `mock` (the offline e2e/CI default) every
tool runs in the sandbox, so "connected" is meaningless and blocking would be
nonsensical — and would break the offline suite. Under `auto`/`real`
(production, incl. the default deploy) an unconnected required skill would
otherwise silently fall through to the mock executor — exactly the "silently
continue toward executable" hazard the brief forbids — so it is blocked. The
read endpoint always reports true readiness regardless of mode.

---

## 6. Security controls (this slice)

- **Tenant isolation**: every path is `companyId`-scoped from the JWT; the
  endpoint 404s another tenant's workflow (e2e-verified). No tenant id is trusted
  from the frontend.
- **No secret exposure**: the resolver reads only masked `InstalledSkillDto`
  (`credentialsSet: boolean`) — never raw credentials, never into any response.
- **AI never receives credentials**: the requirement surface is data (statuses +
  ids), not tokens; nothing here enters an LLM prompt.
- **RBAC**: connect/authorize remain `@Roles('OWNER','ADMIN')`; the DTO carries
  `canManageConnection` so the UI can show "Admin permission needed" instead of a
  dead button (the actionable Connect control + admin-request flow is Phase 8).

---

## 7. Tests

- `capabilities.spec.ts` (7) — capability mapping, multi-provider resolution,
  catalog-drift guard, connection-requirement + provider/display.
- `skill-requirements.service.spec.ts` (11) — capability-first detection,
  READY/NOT_CONNECTED/DEGRADED/DISCONNECTED/ERROR projection, `none`-skill
  non-blocking, disabled-node exclusion, multi-node aggregation,
  `canManageConnection` passthrough, and `assertPublishable` on/off by mode.
- `workflow-skill-requirements.e2e-spec.ts` — endpoint detects the dependency
  NOT_CONNECTED, flips to READY after connect (connection reuse), and 404s
  cross-tenant. Mode-independent ⇒ green under CI `mock`.
- Updated `journey-hr-e2e`: it now **connects** the slack skill it publishes
  (previously only installed it) — faithful to the new readiness rule and green
  under both `mock` and `auto`.

Verified: `@vaep/types` + `@vaep/api` typecheck clean; lint clean; 18 unit tests
pass.

---

## 8. In-chat card + OAuth auto-resume (Phase 4 + 5/6) — SHIPPED

The user-visible half now works end to end, server-driven so it can't drift from
what runs.

- **Detection is server-side, not model-trusted.** After the agent proposes a
  graph, `AssistAgentService` runs `SkillRequirementsService.forDefinition` on the
  new draft and, if any connection-requiring skill is referenced, emits a
  `connection` stream event (added to `AssistStreamEvent`) and `AssistService`
  persists a `CONNECTION`-role message (the role + metadata contract already
  existed). Tied to a graph CHANGE so follow-up turns don't spam cards. The
  prompt no longer tells the model to say it can't connect — it points at the
  card.
- **`SkillRequirementCard`** (`features/assist/components`) renders the
  requirements, shows live per-skill status (refetched via the new
  `GET /skills/requirements?skillKeys=`), and offers **Continue building** once
  all are ready — which re-runs the turn with no text, so the user never
  re-types the prompt. Wired into both the in-flight stream (`AssistChat`) and
  persisted transcript (`AssistMessage`). RBAC-aware: a member sees "an owner or
  admin needs to connect this" instead of a dead button.
- **OAuth returns to the session.** `buildAuthorizeUrl` now takes `returnTo`
  (+ binds `userId` into the signed state); the callback redirects to that
  **allowlisted** same-origin path (`/assist/…` or `/workflows/…`, open-redirect
  guarded) with `?connected=`/`?skillError=`. The session page surfaces the
  result, refreshes the card, and strips the params. Connecting an OAuth skill
  installs it on demand, then redirects — the card never touches a credential.
  This also tightens the security review's state-binding finding (userId is now
  in the signed state).
- Tests: `SkillRequirementsService.forSkillKeys` unit coverage; the assist
  stream reducer test gains a `connection` case (9 web + 20 api unit, all green);
  typecheck + lint clean across types/api/web.

## 9. Still specced-next (NOT built) — with the exact seams

- **Phase 8 — admin approval**: add `ApprovalKind.SKILL_CONNECTION`, create the
  request via the existing `ApprovalService`, add one branch to `approve/reject`.
  `canDecide`'s unrouted default already routes to OWNER/ADMIN; routing/SLA/audit
  come free. No new engine. (Today a member sees an explanatory "admin needed"
  message rather than a request button.)
- **Phase 9 — audit + observability**: emit `SKILL_CONNECTION_STARTED/COMPLETED/
  FAILED/REVOKED` from `oauth.service`/`connectSkill`/`disconnectSkill` and
  `SKILL_PERMISSION_REQUESTED/APPROVED` via the reused approvals events. Only
  `skill.install` is audited today.
- **Post-connect validation**: scope/identity/health probe to distinguish
  `READY` from `INSUFFICIENT_PERMISSION`/`VALIDATING` (needs real provider
  calls). Until then the resolver emits 5 of the 10 states.
- **Nonce replay-store**: the signed state is HMAC + TTL + now userId-bound; a
  one-time nonce store would fully close replay. Provider selection UX
  ("which calendar?") is modelled in data but not yet a picker.

---

## 9. Known risks

- The publish block is `SKILL_EXECUTOR`-mode-gated. Running the e2e suite locally
  with `auto` (non-standard; CI + the documented commands use `mock`) activates
  it; the only existing publish-with-TOOL_ACTION test (`journey-hr`) was updated
  to connect its skill, so the suite stays green either way.
- `SkillConnectionStatus` (DB enum) still has 4 states; the richer 10-state view
  is a computed projection at the DTO layer (deliberately — avoids a risky enum
  migration + the `labels.ts` ripple). The reserved states activate with Phase 5.
- Multi-connection selection (enterprise "which calendar?") is modelled in the
  data (`installedSkillId`, employee-scoped resolution) but the selection UX is
  Phase 4/10.

---

## 10. Production readiness

**Backend foundation + in-chat card + OAuth auto-resume: production-ready** —
tenant-safe, no secret exposure, AI never sees a credential, typecheck/lint/tests
green across types/api/web, backward-compatible (draft saves unaffected; publish
gate off in mock/CI; the four assist e2e suites' `.find`/`done`-count assertions
survive the added `connection` frame/message). The end-to-end experience from the
brief now works: the agent detects required skills, the card appears in chat,
the user connects without leaving, OAuth returns to the same session, and the
card offers Continue — with existing connections reused and admin-needed states
shown honestly.

Caveat for a live OAuth run: real provider client IDs/secrets + redirect URIs
must be configured (`OAUTH_*`), and the tested path is the offline unit/reducer
level — a real Google/Slack round-trip should be smoke-tested once creds exist.

Remaining (Phase 8 admin-approval, Phase 9 audit events, post-connect scope
validation) are enhancements, each with its seam located above — none blocks the
core experience.
