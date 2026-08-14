# CTO Gap Closure — WAVE 2: Authorization + Security Policy (P0)

**Date:** 2026-08-12
**Authority:** `docs/implementation/workflow-system/orlixa-cto-master-gap-closure-plan(1).md` §WAVE 2
**Predecessors:** WAVE 0 baseline (passed) · WAVE 1 durable execution (passed)

---

## 1. What changed, in one sentence

Authorization stopped being a convention (72 scattered `@Roles` decorators) and became a layer:
one `authorize(actor, action, resource, context)` with tenant isolation, a role floor and
**department scoping** — and the security-policy settings that previously did nothing now do
what the settings screen claims.

---

## 2. Central authorization (§2.2 / §16)

New leaf module `modules/authorization/`:

| File | Role |
|---|---|
| `authorization.policy.ts` | The rules, as a PURE function — testable without Postgres, Redis or Nest |
| `authorization.service.ts` | The I/O shell: `authorize` · `assert` · `filter` · `actorFor` / `actorById` |
| `authorization.guard.ts` | Enforces `@RequirePermission(...)` — the pre-load floor |
| `authorization.types.ts` | 16 `<resource>:<verb>` actions, actor/resource/decision shapes |
| `security-policy.service.ts` | §2.4 — makes `SecurityPolicy` executable |

`@Global` and Prisma-only, so any module can use it and it can never join a cycle.

**It does not replace the specialised checks that already exist and are already tested** —
`WorkflowPermissionService` (per-workflow grants) and `ApprovalRoutingService.canDecide` (who may
decide a routed approval). Duplicating those would create exactly the "two authorization systems"
§19 forbids. This is the layer they compose under.

Three properties worth calling out:

- **Tenant isolation is checked first**, before any role rule, so a cross-tenant request can never
  reach the OWNER shortcut.
- **Unknown actions fail CLOSED.** A typo'd action string silently allowing everything is the worst
  failure this layer could have.
- **The role is re-read from the database**, not taken from the JWT — a demotion or a disable takes
  effect immediately rather than when the access token happens to expire.

---

## 3. Department isolation (§2.1) — the actual new capability

`RolesGuard` was company-flat: OWNER ⊇ ADMIN ⊇ MEMBER, with no notion of *which part* of the
company. A Marketing admin could read, edit and **run** HR workflows. The plan's §7.2 journey
(`Marketing Admin -> HR = DENY`) had nothing to enforce it.

**Model:** `Department.scopes String[]` (migration `20260811010000_wave2_department_scopes`). Values
are the scope names resources already carry — `WorkflowCategory`, `AiEmployee.role`,
`KnowledgeDocument.category`. Those are three different enums that merely share names, so a string
is the honest common type; unifying them would be a migration on every table for no behavioural
gain. Comparison is case/separator-insensitive (`Project Manager` ≡ `PROJECT_MANAGER`).

**Enforcement points:** `WorkflowsService` (`get` / `list` / `createRun`) and `EmployeesService`
(`get` / `list`), each after the row is loaded — the rule depends on the resource's own scope, which
no route guard can know before reading it.

**Lists are filtered by the same rule as detail reads.** A list that shows
"HR — Terminations checklist" and then 403s on open is still a leak: the title alone tells a
Marketing admin what they should not know.

### Ships inert

**A department with no `scopes` restricts nothing, and that is the default.** Every existing tenant
has no scopes configured, so this changes nothing for them until an admin opts in with one write.
An authorization change that silently starts denying live users reads as an outage, not as a
security control. Both the unit suite and the e2e suite assert this explicitly.

### A gap this exposed

`Workflow.category` could only ever be set by a **template install** — there was no way to
categorise a hand-authored workflow, so department isolation would have had nothing to isolate on
for most real workflows. `category` is now settable on `POST /workflows` and `PATCH /workflows/:id`
(explicit `null` makes a workflow company-wide again).

---

## 4. Security policy made executable (§2.4)

The plan's rule for this section: *a configuration value must not imply protection unless
enforcement exists.* Before WAVE 2:

| Field | Before | Now |
|---|---|---|
| `passwordMinLength` | enforced ONLY when an admin invited a user — so any user could reset their way to a 1-character password | enforced on invite **and password reset** |
| `allowedEmailDomains` | same single call site | shared service, same rule everywhere |
| `sessionTimeoutMinutes` | **stored, never read** — a company could set 15 minutes and sessions still lived 7 days | enforced at `/auth/refresh` as an inactivity timeout |
| `mfaRequired` | **stored, never read — and no MFA exists anywhere in the platform** | setting it to `true` is now **rejected with 400** |
| `dataRetentionDays` | enforced (HR sweep) | unchanged |

The `mfaRequired` decision is deliberate and worth stating plainly: a settings screen that reports
a protection the runtime does not apply is worse than no setting at all, because it converts an
open risk into one the customer believes is closed. Rejecting the write is the honest behaviour
until MFA ships. Turning it off is always allowed.

`sessionTimeoutMinutes` is measured from the presented refresh token's `createdAt`, and refresh
**rotates** the token — so it is a true inactivity timeout rather than a hard cap that signs a user
out mid-task. `0` (the default) disables it.

---

## 5. OAuth hardening (§2.5) + security fixes (§2.6)

### PKCE and one-time state

The flow was entirely stateless: an HMAC-signed `state` and nothing on the server. Signing makes a
state *unforgeable*; it does not make it **single-use**, so anyone who captured the callback URL
could re-submit it until the TTL expired — and there was nowhere to hold a PKCE verifier.

New `OAuthAuthorizationRequest` table (migration `20260811020000_wave2_oauth_pkce`) holds the
verifier and the one-time flag. On callback the row is claimed with a guarded
`updateMany … WHERE usedAt IS NULL`, so two concurrent callbacks with the same state race on one row
and only the first wins. PKCE is S256, on by default, with `OAUTH_PKCE_DISABLED_PROVIDERS` as a
no-deploy escape hatch for a provider that rejects unknown parameters.

### Verified tenant identity before rate limiting

`TenantAwareThrottlerGuard` **decoded the JWT without verifying it**, on the reasoning that the
value "only picks a rate-limit bucket". That reasoning misses what a bucket is — shared,
exhaustible state keyed by a value the caller controls. Unverified, an attacker could:

1. **escape their own limit** by forging a fresh `companyId` per request, and
2. **exhaust a victim tenant's limit** by claiming their `companyId` — a denial of service against
   a company they have no account with.

Neither needed a valid signature, and both were invisible in an audit log recording the real
caller. Now HS256-verified, alg-confusion-proof (`alg: none` rejected), expiry-checked, and
**failing closed** to per-IP when no secret is configured.

### Response-size limit that actually limits

The http skill "capped" bodies by slicing the string returned from `await res.text()` — which has
already buffered the entire body. A hostile or merely broken endpoint returning a gigabyte (or an
endless chunked stream) would OOM the worker before the truncation ran. `readCappedText` now stops
**reading** at the limit and cancels the transfer, so the memory ceiling is the limit itself; it
also rejects an oversized declared `content-length` before a byte is transferred.

### Already closed before this wave (verified, not re-implemented)

- SSRF / DNS-rebinding defence: `modules/skills/executors/ssrf.ts` resolves the host and checks
  **every** returned address against private/loopback/link-local ranges (including the
  169.254.169.254 metadata endpoint), and redirects are not auto-followed.
- Redirect-URI validation: the OAuth redirect is derived server-side from `OAUTH_REDIRECT_BASE`,
  never taken from the request; `returnTo` is restricted to a same-origin relative path under a
  known prefix.
- Secret redaction and credential encryption at rest (`common/crypto`).

---

## 6. WAVE 2 gate

| Gate item | Status | Evidence |
|---|---|---|
| Department/team permissions pass | ✅ | `authorization-scope.e2e-spec.ts` — the full §7.2 journey over real HTTP |
| Cross-scope access is denied | ✅ | read **and run** denied; the list is filtered too |
| Execution-time skill authorization passes | ✅ (pre-existing) | per-employee connection resolution + `EmployeeSkill` grants, covered by `per-employee-skill-connections.e2e-spec.ts` |
| Security policy is enforced | ✅ | password reset, session timeout and the `mfaRequired` refusal, all e2e |
| OAuth security tests pass | ✅ | `oauth.service.spec.ts` — PKCE S256, verifier never leaves the server, replay rejected, tamper rejected, expiry rejected |
| No known critical/high security issue remains open | ⚠️ **partial** — see §7 |

### Test results (2026-08-12)

| Check | Result |
|---|---|
| `pnpm -w run typecheck` | **PASS** — 5/5 packages |
| Unit | **PASS — 437 tests, 54 suites** (was 409/52 at end of WAVE 1; +17 policy, +6 OAuth, +5 throttler) |
| `authorization-scope.e2e-spec.ts` | **PASS — 12 tests** |

Full e2e regression: see §8.

---

## 7. Honestly NOT done in this wave

The gate item "no known critical/high security issue remains open" cannot be claimed, because these
plan items are still open:

- **Production secret storage** (§2.6). Secrets are env vars encrypted at rest with
  `ENCRYPTION_KEY`; there is no secret manager. Unchanged by this wave.
- **Encryption-key validation** (§2.6). `CryptoService` *warns* when `ENCRYPTION_KEY` is unset and
  derives an insecure development key. In production that should be a boot failure, not a log line.
- **MFA** is not implemented. WAVE 2 makes the platform honest about that rather than fixing it.
- **`@RequirePermission` adoption is partial.** The layer is in place and the guard exists, but the
  72 existing `@Roles` sites were not rewritten. Rewriting a live authorization surface wholesale is
  a larger risk than the one it closes; the layer is now the place new checks go, and the
  department-scoped resources (workflows, employees) are migrated.
- **Knowledge and HR are not yet department-scoped** — only role/company-scoped as before.
  `KnowledgeDocument.category` already carries the right axis, so this is adoption, not design.
- **OAuth browser-session binding** (a cookie tying the callback to the tab that started it) is not
  implemented: the API and web app are separate origins on Vercel, so it needs a
  `SameSite=None; Secure` cookie and a decision about that. PKCE plus one-time state already
  defeats code interception and replay, which are the threats it would address.

---

## 8. Full e2e regression

Run against the final WAVE 2 code:

```
Test Suites: 3 failed, 64 passed, 67 total
Tests:       6 failed, 402 passed, 408 total
```

**Zero regressions.** The 6 failures are the same 6 tests in the same 3 suites that were already
failing before WAVE 1 — `analytics` (3), `auth-email-verification` (2), `e2e/engines-support` (1) —
each verified pre-existing by stashing the source changes and re-running. They are unrelated to
authorization and still need separate triage.

For comparison across the programme:

| Point | Suites | Tests |
|---|---|---|
| WAVE 0 baseline | 66 | 388 passed / 6 pre-existing failures* |
| End of WAVE 1 | 66 | 390 passed / 6 failed |
| End of WAVE 2 | 67 | **402 passed / 6 failed** |

\* the baseline recorded the suite as green per CLAUDE.md; the 6 failures were discovered during
WAVE 1 verification and shown to predate it.

---

## WAVE 2 gate: **PASSED with the §7 exceptions recorded.** WAVE 3 (Approval + Canonical Events)
may begin.
