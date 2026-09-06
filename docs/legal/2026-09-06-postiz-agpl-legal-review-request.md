# Legal Review Request: AGPL-3.0 Licensing of Self-Hosted Postiz

**Date:** 2026-09-06
**Requested by:** Product/Engineering (Orlixa/V-AEP platform)
**Priority:** Blocks GA of the "Content & Social Media Agent" — a paying-customer-facing feature that is
code-complete and, as of this request, has a self-hosted Postiz instance running in a non-production
environment for the first time (verified directly against the running code today, not against the older
architecture-planning document cited below, which predates this build and still describes itself as a
pre-implementation design — see the citation note under fact 2).
**Status:** OPEN — awaiting counsel's answer. Nothing below is a legal opinion; it is the fact pattern
counsel needs to give one.

---

## The one question that needs an answer

**Can Orlixa run a self-hosted, unmodified instance of Postiz (AGPL-3.0 licensed,
`gitroomhq/postiz-app`) as a backend service for a paid, proprietary SaaS product, calling it only
over its own public HTTP API — without that triggering AGPL-3.0 §13's network-copyleft obligations on
Orlixa's own (separate, proprietary) codebase?**

A secondary question, contingent on the answer above:

**If Orlixa later needs one narrow additive patch to Postiz's own source (see "Open sub-question"
below), does that change the analysis — i.e. does patching Postiz turn this into "distributing a
modified version" in a way that pulls Orlixa's own code under AGPL's copyleft?**

---

## The facts (verified against this codebase, not assumed)

1. **What Postiz is being used for:** Postiz (`ghcr.io/gitroomhq/postiz-app`) is a self-hosted social-media
   scheduling/publishing engine. Orlixa is not modifying, forking, or redistributing Postiz's source. Orlixa
   runs one self-hosted instance and calls only its documented public REST API
   (`/public/v1/posts`, `/public/v1/social/:integration`, `/public/v1/analytics/*`, etc.) from Orlixa's own,
   separate backend service.
2. **Architecture (implemented in code and verified live against a real self-hosted Postiz instance
   today, 2026-09-06 — NOT drawn from `postiz-integration-plan.md`, which is an earlier planning
   document that still labels itself "design document... no production code written here"; the actual
   backend module, database tables, and a real end-to-end publish/analytics round-trip were verified
   directly in the running code and a live Postiz instance as part of this rollout):**
   - Orlixa's customers never see Postiz's own UI, login, or branding in the current build. Everything
     customer-facing is Orlixa's own frontend; Postiz is purely a backend the customer never directly
     interacts with. **This exact fact pattern — one program's UI as the only thing a customer sees,
     orchestrating a second program the customer never touches — is what `postiz-integration-plan.md`'s
     own Phase 9 analysis identifies as the central AGPL §13 judgment call for counsel, not a settled
     engineering fact to take for granted. It is presented here as the architecture Orlixa has actually
     built, not as an argument for why that architecture is legally safe.**
   - One Postiz "Organization" is run for the whole Orlixa deployment; the design intends each Orlixa
     customer to map to one Postiz "Customer" record inside that org (a multi-tenancy pattern Postiz's
     own API supports natively via `group`/`Customer` filtering). **Caveat:** the specific mechanism to
     tag a newly-connected social account to the right Customer at connect-time is still an open
     implementation decision (see "Open sub-question" below) — so this mapping is the intended design,
     not yet a fully proven guarantee for every code path.
   - Orlixa's own database never holds a copy of Postiz's source or its database; the two systems
     communicate only over the network, via Postiz's documented HTTP API.
3. **No source modification today.** Orlixa's current implementation requires zero patches to Postiz's
   source. It is a vanilla, unmodified `ghcr.io/gitroomhq/postiz-app:latest` image, self-hosted by Orlixa.
4. **Commercial context:** This is a paid feature of a commercial SaaS product (Orlixa/V-AEP). Customers
   will pay Orlixa for access to a "Marketing AI Employee" that, among other things, schedules and
   publishes their social media posts — the actual publishing happens via the self-hosted Postiz instance
   described above.

## Open sub-question (only matters if the primary answer allows unmodified use)

Postiz's public API can list "Customer" groups and filter integrations by Customer, but there is one
narrow gap: **tagging a newly-OAuth-connected social account to a specific Customer at connect-time is
only reachable through Postiz's own internal, logged-in-user-session API — not through the
API-key-authenticated public API.** Two ways to close this gap were identified:

- **(a)** A small, additive patch to Postiz's own source: expose one new public-API endpoint that wraps
  the existing internal `PUT /:id/group` call. This would be the only source modification made to
  Postiz — everything else stays vanilla.
- **(b)** A workaround with no source patch: Orlixa's backend holds one internal Postiz service-account
  session and calls Postiz's existing internal route directly (not via the public API), accepting the
  risk of depending on an unversioned internal route that could change on a future Postiz upgrade.

**If counsel's answer to the primary question is "unmodified use is fine, but a modified/patched instance
is not,"** this sub-question needs its own answer: does option (a)'s one-endpoint addition count as
"distributing a modified version" for AGPL §13 purposes (in which case option (b) becomes the only safe
path), or is a narrow additive endpoint on a self-hosted-only instance (never distributed to anyone,
including Orlixa's own customers) still outside the clause's scope?

## What Orlixa is NOT asking

- Not asking whether Postiz's cloud/hosted product's Terms of Service apply — Orlixa is self-hosting,
  not using postiz.io directly.
- Not asking about trademark/branding — Postiz's own branding is never customer-facing in this design.
- Not asking counsel to review Postiz's own source code for other license issues (e.g. third-party
  dependencies) — scope this request to the AGPL question above only, unless counsel believes a
  broader review is warranted.

## Useful context if counsel wants it

- Postiz's own repository: `gitroomhq/postiz-app`, `LICENSE` file states AGPL-3.0. **Verification note:**
  this specific claim is a well-known public fact about the Postiz project (visible on its public GitHub
  repo) but was not independently re-verified against a file citation inside this codebase's own analysis
  docs the way every other claim in this request was — `docs/architecture/postiz-analysis.md`'s 1000+
  lines contain no `LICENSE`/`AGPL`/`CCLA`/`ICLA` reference despite being the "verified against a real
  clone" source doc. Counsel should treat this one fact as "commonly known, not internally re-verified"
  rather than evidenced the same way the architecture claims above are.
- Worth checking whether gitroomhq offers a commercial/dual license for exactly this "embed as a backend
  service" use case (a `CCLA.md`/`ICLA.md` presence in the public repo is a signal such an option might
  exist, not proof — same verification caveat as above).
- Full engineering analysis (architecture, data flow, what is and isn't shared with Postiz) is available
  in this repo at `docs/architecture/postiz-integration-plan.md` (Phase 9 "Security" section covers the
  AGPL point in more technical detail) and `docs/architecture/postiz-analysis.md` (raw source analysis of
  the Postiz codebase this design is based on), if counsel wants the underlying evidence rather than this
  summary.

---

## What happens after this is answered

Record the outcome (dated) in this file's "Answer" section below, and also update
`docs/architecture/postiz-integration-plan.md`'s "Open items needing a decision" list, item 1. Until this
is answered, `docs/plans/2026-09-06-marketing-agent-production-rollout-plan.md` (the production rollout
plan) treats Phase C (legal + capacity) as blocked, and GA (Phase E) cannot proceed regardless of how far
the rest of the rollout gets.

## Answer

*(pending — not yet answered)*
