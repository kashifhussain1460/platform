# Auth + Minimal Onboarding — Implementation Report (Phase 0 Discovery + Phase 1 Contracts)

**Date:** 2026-08-07
**Scope of this document:** the mandated discovery-first output — inspect the existing codebase, classify every relevant component (KEEP/EXTEND/REFACTOR/CREATE/REMOVE/MIGRATE), freeze the contracts and state machines, resolve the architecture conflicts, and lay the smallest-safe-change plan for Phases 2–8. It deliberately does **not** ship half-built auth code: a hard dependency (no transactional-email infrastructure exists) gates the email-based flows, and the task forbids fake/placeholder production behavior and forbids claiming readiness with unresolved items.
**Method:** three parallel read-only discovery passes (backend auth + email infra; DB models + onboarding; frontend auth + onboarding), each with `file:line` evidence.

---

## 1. Architecture discovered

Orlixa is a **B2B multi-tenant AI Employee OS** on a pnpm/Turborepo monorepo: `apps/api` (NestJS + Prisma + Postgres), `apps/web` (Next.js App Router, Tailwind, TanStack Query, Zustand, react-hook-form + zod), `packages/types` (shared zod DTOs).

**Canonical tenancy (settled, do not change):** `Company = tenant = organization = workspace`. `User` carries `companyId` + `role (OWNER/ADMIN/MEMBER)` directly. There is **no** `Organization`/`Membership`/`Workspace` table, by deliberate decision (reaffirmed in `platform/CLAUDE.md` and project memory).

**Auth (exists, works):** `POST /auth/register` (atomic Company+OWNER user in a `$transaction`, argon2 hash, issues access+refresh), `login` (multi-tenant candidate loop, per-request DB active check), `refresh` (httpOnly `vaep_refresh` cookie, DB re-check), `logout` (clears cookie), `me`. JWT is **stateless** (access 900s / refresh 7d); `JwtStrategy.validate` re-reads status+role per request (the kill-switch hardened in this session). Global `ThrottlerModule` (300/60s) + tenant-aware guard; `@Throttle(10/60s)` on register+login. `AuditLogService` is `@Global`.

**Onboarding (exists, minimal):** `GET /onboarding/status` (returns only `{completed}`), `GET /onboarding/catalog` (role templates incl. HR + MARKETING), `POST /onboarding/complete` (hires employees for missing roles + stamps `Company.onboardedAt`; idempotent top-up; **not** a single transaction). No per-step persistence, no resumable state, no goals storage.

**Frontend (exists):** `/register` + `/login` real and wired; `/forgot-password`, `/reset-password`, `/verify-email`, `/verify-otp`, `/two-factor` are **UI stubs with no backend**. Client-side route guards (no `middleware.ts`) branch solely on `company.onboardedAt`. A complete auth design-system kit exists (`AuthShell`, `PasswordInput` with visibility toggle, `OtpInput`, `SocialRow` (Google/Microsoft/GitHub — unwired), illustrations). Dark-only identity.

## 2. Existing functionality reused (KEEP — do not duplicate)
argon2 hashing (`JwtAuthProvider`), JWT issue/verify + httpOnly refresh cookie + kill-switch, `ThrottlerModule` + tenant guard + `@Throttle` pattern, `RolesGuard`/`@Roles`, `AuditLogService`, global `ValidationPipe`, register/login/logout/me/refresh, the multi-tenant email model (`@@unique([companyId, email])`) + app-layer `normalizeEmail` (lowercase+trim), `Company`/`Department`/`AiEmployee` models (HR + MARKETING roles + seat-limited advisory-locked hire), the whole web auth design-system kit, the session store + `AuthBootstrap` silent-refresh, and the two client route guards.

## 3. Component classification

| Area | Component | Classification | Note |
|---|---|---|---|
| Tenancy | `User→Membership→Organization` (requested) | **REMOVE from spec** | Conflicts with canonical Company-as-tenant. Map Organization→`Company`, Membership→`User.companyId+role`. Do NOT add tables. |
| Auth | register/login/logout/me/refresh, argon2, JWT+cookie+kill-switch, throttler, RBAC, audit svc, session store, guards | **KEEP** | reuse as-is |
| Auth | register firstName/lastName + terms acceptance | **EXTEND** | add `User.firstName?/lastName?` + `termsAcceptedAt` (additive, keep `name`); collect on the form |
| Auth | auth audit events (register/login/logout/reset) | **EXTEND** | inject the global `AuditLogService`; currently zero auth rows |
| Auth | shared password-policy zod schema | **CREATE** | one source of truth; today register=min(8), reset page has its own unenforced rules |
| Auth | **transactional email sender (MailModule)** | **CREATE (blocking)** | none exists; §13 architecture |
| Auth | email verification (model + tokens + endpoints) | **CREATE** | needs MailModule + `emailVerifiedAt` + `PENDING_VERIFICATION` status + `VerificationToken` |
| Auth | forgot/reset password (tokens + endpoints) | **CREATE** | needs MailModule + `PasswordResetToken`, anti-enumeration |
| Auth | OAuth login (Google/Microsoft) | **CREATE (document first)** | §13; needs Passport strategies + `AuthIdentity(provider,providerId)`; `SocialRow` UI already present |
| Auth | verify-otp / two-factor pages | **REMOVE or defer** | pure UI, no backend, out of the minimal spec |
| Onboarding | `POST /onboarding/complete`, catalog, employee hire | **KEEP** | reuse |
| Onboarding | resumable server-side `onboardingStep` + saved partial selections | **CREATE** | additive `Company.onboardingStep` |
| Onboarding | per-step endpoints (company / ai-employees / goals) | **CREATE** | `PATCH /onboarding/{company,ai-employees,goals}` |
| Onboarding | business-goals storage | **CREATE** | `Company.businessGoals String[]` (tenant-denormalized, matches house style); NOT `AiEmployee.goals` (wrong scope) |
| Onboarding | goal reconciliation on AI-employee change | **CREATE** | deterministic add+prune (§8) |
| Onboarding | frontend 3-step (company/ai-employees/goals) + per-step routes + resume | **REFACTOR** | current single-page local-state wizard (has a departments step, no goals step) |
| Guards | deterministic EMAIL_UNVERIFIED → verify / ONBOARDING_INCOMPLETE → onboarding / else dashboard | **CREATE** | needs the unverified state to exist first |

## 4. Database change plan

| Model/Field | Classification | Change |
|---|---|---|
| `User.firstName?`, `User.lastName?` | CREATE (additive) | nullable; keep `name` (derived `"First Last"`) to avoid a high-ripple rename/MIGRATE |
| `User.termsAcceptedAt DateTime?` | CREATE | stamped at register |
| `User.emailVerifiedAt DateTime?` | CREATE | drives verification gating |
| `UserStatus` enum | EXTEND | add `PENDING_VERIFICATION` (keep ACTIVE/DISABLED) |
| `Company.onboardingStep String?` | CREATE | `NOT_STARTED\|COMPANY_SETUP\|AI_EMPLOYEE_SELECTION\|BUSINESS_GOALS\|COMPLETED` (null = legacy → derive from `onboardedAt`) |
| `Company.businessGoals String[]` | CREATE | `@default([])` |
| `VerificationToken` | CREATE | `{id, userId, tokenHash, expiresAt, usedAt?}`; store a **hash**, single-use, TTL |
| `PasswordResetToken` | CREATE | same shape; anti-replay |
| `AuthIdentity` (OAuth) | CREATE (with OAuth phase) | `{id, userId, provider, providerId}`, `@@unique([provider, providerId])` |
| Organization/Membership/Workspace | **DO NOT CREATE** | canonical conflict |

All additive → **safe, non-destructive migrations**. Author with `prisma:migrate:new` and (pgvector gotcha) strip any generated `DROP INDEX ..._embedding_idx` before applying with `prisma:migrate` (=`migrate deploy`).

## 5. Frozen contracts (Phase 1)

**DTOs (extend the shared `packages/types` zod schemas — single source, backend authoritative):**
- `registerSchema`: `{ firstName, lastName, email, password(sharedPasswordSchema), termsAccepted: literal(true) }` (drop the frontend's synthesized `companyName` — company name moves to onboarding step 1, matching the minimal-onboarding goal).
- `sharedPasswordSchema`: min 8, at least one letter + one number (secure without friction); used by register + reset.
- `forgotPasswordSchema`: `{ email }`. `resetPasswordSchema`: `{ token, password, confirmPassword }` (refine match).
- `verifyEmailSchema`: `{ token }`. `resendVerificationSchema`: `{}` (identity from session/email).
- Onboarding: `onboardingCompanySchema { name, industry, size, website? }`, `onboardingAiEmployeesSchema { roles: ('HR'|'MARKETING')[] (1..2) }`, `onboardingGoalsSchema { goals: string[] }`.

**Canonical config (single source, no per-component hardcoding):** `INDUSTRIES` (Technology/Healthcare/Finance/Retail-Ecommerce/Education/Professional-Services/Real-Estate/Manufacturing/Hospitality/Other), `COMPANY_SIZES` (1–10 … 5,000+), and `EMPLOYEE_GOALS` keyed by role (HR: Recruitment/Candidate Screening/Interview Scheduling/Employee Onboarding/HR Operations/Performance Reviews/Employee Offboarding; MARKETING: Content Creation/Social Media/Campaign Management/Email Marketing/SEO/Lead Generation/Marketing Analytics) — live in `packages/types` or `apps/api` catalog, consumed by both step 2/3 UI and the reconciliation.

**API surface (create only what's missing; reuse existing where present):**
`POST /auth/verify-email`, `POST /auth/resend-verification`, `POST /auth/forgot-password`, `POST /auth/reset-password` (all CREATE, all `@Throttle`d). Onboarding: `PATCH /onboarding/company`, `PATCH /onboarding/ai-employees`, `PATCH /onboarding/goals` (CREATE), `GET /onboarding/status` (EXTEND to return `{ step, company, selectedRoles, goals, completed }`), `POST /onboarding/complete` (KEEP).

## 6. Auth state machine (contract)
```
UNAUTHENTICATED ──register──▶ PENDING_VERIFICATION ──verify-email──▶ ACTIVE
       │                                   │ resend (cooldown)
       └──login──▶ [account check]         └── (login while pending → routed to /verify-email)
ACTIVE + login ─▶ [onboarding check] ─▶ ONBOARDING_INCOMPLETE | READY
DISABLED / (future SUSPENDED/LOCKED) ─▶ deny (401/403, generic message)
```
Login decision (server derives; frontend never decides destination):
`authenticate → status==DISABLED? deny · emailVerifiedAt==null? → /verify-email · Company.onboardedAt==null? → /onboarding(resume step) · else → /ai-assistant`.

## 7. Onboarding state machine (contract)
```
NOT_STARTED ─PATCH company──▶ COMPANY_SETUP ─PATCH ai-employees──▶ AI_EMPLOYEE_SELECTION
   ─PATCH goals──▶ BUSINESS_GOALS ─POST complete──▶ COMPLETED (onboardedAt stamped)
```
- `onboardingStep` persists server-side after each PATCH → survives refresh/logout/device change (never localStorage-only).
- Back navigation allowed; a later PATCH overwrites the saved selection for that step.
- `GET /onboarding/status` returns the saved step + partial selections so the wizard resumes exactly.

## 8. Goal reconciliation (deterministic)
When `PATCH /onboarding/ai-employees` changes the selected roles: `businessGoals := businessGoals ∩ allowedGoals(newRoles)` where `allowedGoals` is the union of `EMPLOYEE_GOALS[role]` for the selected roles. Removing MARKETING drops all Marketing-only goals; adding a role does not auto-add goals (user re-picks in step 3). Pure function → unit-testable in isolation. (Business goals are preferences, **not** RBAC permissions — stored on `Company.businessGoals`, never consulted for authorization.)

## 9. Security controls (target)
Anti-enumeration on forgot-password (always "if an account exists…"), rate limits on register/login/forgot/reset/resend/verify (IP + identity aware, NAT-friendly), cryptographically-random single-use short-lived tokens **stored hashed**, argon2 (reuse), httpOnly+Secure+SameSite cookies (reuse), reset invalidates the token + writes an audit event + (per canonical policy) leaves stateless access tokens to expire (document: true "revoke all sessions" needs a session/refresh-token table — a documented CREATE, not faked). Never log/return credentials or tokens. All verified-safe controls from `workflow-security-review.md` (SSRF, IDOR, mass-assignment, raw-SQL, secrets-at-rest) carry over.

## 10. Tests planned (per phase, real — not written yet)
Unit: `sharedPasswordSchema`, goal-reconciliation, onboarding state transitions, token validity (expiry/used/replay). Integration (real DB/Redis, supertest): register→verify→login, forgot→reset, per-step onboarding + resume, `complete` provisioning. Security: account-enumeration, expired/used/invalid token, brute-force throttle, cross-tenant onboarding access, duplicate signup, concurrent onboarding PATCH. E2E (Playwright harness scaffolded in `e2e-readiness-report.md`): Journeys 1–5.

## 11. Known risks
- **No email infrastructure** — the single biggest blocker; verification + reset are unusable until a MailModule exists (§13).
- Stateless JWT → logout/reset can't hard-revoke an already-issued 15-min access token without a session table.
- `name → firstName/lastName` is a wide-ripple rename; mitigated by the additive-columns approach (keep `name`).
- `POST /onboarding/complete` is intentionally non-atomic (nested advisory-lock transaction constraint) — resumability + idempotency, not all-or-nothing.

## 12. Deferred functionality (designed here, implementation pending — NOT faked)
Email verification, forgot/reset password, OAuth login (Google/Microsoft), the frontend 3-step onboarding refactor + wired verify/forgot/reset pages, and the deterministic 3-way route guard. Each has its contract above; none is stubbed in code.

## 13. Required architecture for the CREATE items (document-before-implement)
**MailModule (blocking dependency):** a swappable `MAIL_PROVIDER` mirroring the codebase's existing `LLM_PROVIDER`/`BILLING_PROVIDER`/`STORAGE_PROVIDER` pattern — `MailProvider` interface with `console` default (dev/test: logs the link deterministically — a real dev implementation, like `SKILL_EXECUTOR=mock`, not fake), `smtp` (nodemailer, lazy), `ses`/`sendgrid` (lazy). Token flows generate a random token, store only its hash + TTL + single-use flag, and send via `MailProvider`. This is the prerequisite for verification + reset.
**OAuth login:** Passport `google`/`microsoft` strategies with `state` + `nonce`, callback validation, and an `AuthIdentity(provider, providerId, userId)` table with `@@unique([provider, providerId])`. Identity linking rule: match on verified provider email → link to existing user only if that email is already verified on a password account; otherwise create; **never** auto-merge on an unverified match. The `SocialRow` UI already exists (unwired).

## 14. Production environment requirements (for the deferred flows)
`MAIL_PROVIDER` + provider creds (SMTP/SES/SendGrid), `APP_BASE_URL` for link building, `GOOGLE_OAUTH_*` / `MICROSOFT_OAUTH_*` (client id/secret/redirect), token TTL config. Existing prod requirements unchanged (`ENCRYPTION_KEY`, JWT secrets, `DATABASE_URL`, `REDIS_URL`).

## 15. Migration & rollback
All planned schema changes are additive (nullable columns / new tables / an added enum value) → forward-safe, no data backfill needed (`onboardingStep` derived from `onboardedAt` when null). Rollback = `prisma migrate resolve --rolled-back` + drop the additive columns/tables; no destructive change to existing data. (No code was migrated in this discovery phase, so nothing to roll back yet.)

## 16. Production readiness score
**NOT PRODUCTION-READY — 0/‑ (design phase).** Per the task's rule ("do not claim production readiness if Critical/High issues remain"), the email-based auth flows are blocked on a missing MailModule (a High-severity CREATE), so no readiness can be claimed. What already exists and is production-grade today (register/login/logout/refresh/me, argon2, JWT+kill-switch, throttling, RBAC, multi-tenant isolation, the atomic register + idempotent onboarding-complete) is unchanged and remains solid. The next phase implements the plan above phase-by-phase (smallest safe change → typecheck → lint → unit → integration → verify tenant isolation + security), starting with the self-contained, no-email-dependency slice: the minimal 3-step onboarding backend (resumable state + per-step endpoints + goals + reconciliation + audit) and the register EXTEND + auth audit events.

---
**Discovery + contracts complete.** No code, schema, or tests were changed in this phase — deliberately, to satisfy "inspect before writing code," avoid duplicate architecture (Company-as-tenant kept), and avoid shipping unverified auth. Implementation proceeds from §16's ordered plan.
