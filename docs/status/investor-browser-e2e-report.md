# Orlixa Investor Browser E2E Report

Date: 2026-08-15
Environment: **LOCAL developer stack — NOT production**
Production URL: **none exists** (see Blocker B1)
Browser: Chromium 1.62.1 (Playwright)

## Accounts

| Role | Account | Used? |
|---|---|---|
| Owner | `kashifhussain146@gmail.com` | **No — blocked** (B2) |
| Secondary member | `kashifhussain.jaipur@gmail.com` | **No — blocked** (B2) |
| HR mailbox | `hr@orlixa.io` | **No — blocked** (B3) |
| Support mailbox | `support@orlixa.io` | **No — blocked** (B3) |
| Info mailbox | `info@orlixa.io` | configured as the platform's SMTP sender only |

Every account-specific scenario below is reported **BLOCKED**, not PASS. Per §46, claiming
otherwise would be a hard fail.

---

## 1. Environment gate (§4) — result

| Gate item | Result | Evidence |
|---|---|---|
| Production web URL reachable | ❌ **MISSING** | No deployed URL exists in any config. `apps/web/.env.local` → `NEXT_PUBLIC_API_URL=http://localhost:4000`; `apps/api/.env` → `OAUTH_REDIRECT_BASE=http://localhost:4000`. The only domain in the repo is an instruction in a plan doc (`https://vaep-web.vercel.app`), not a deployment. |
| API reachable through web | ✅ local | `/health` → 200 |
| Postgres healthy | ✅ | used throughout |
| Redis / BullMQ healthy | ✅ | workflow runs executed |
| Workers running | ✅ | ingestion + workflow runs completed |
| Transactional email configured | ✅ | Hostinger SMTP, sender `info@orlixa.io` |
| Real email delivery working | ⚠️ **not verified end-to-end** | Verified only that the app switches to real random OTPs when mail is enabled. No delivery to a real inbox was confirmed, because no test inbox is reachable (B2). |
| Gmail accounts accessible | ❌ **MISSING** | No credentials available |
| Required OAuth configuration present | ⚠️ partial | Google client id/secret set, but redirect base is `localhost` — not a production OAuth app |
| Playwright Chromium installed | ✅ | 1.62.1, chromium-1234 |
| Test environment identified | ✅ | local |

**Gate verdict: FAILED.** Per §4 the correct action is STOP and report, which is what this document
does. No scenario requiring production, a real Gmail inbox, or Google OAuth consent is claimed.

---

## 2. Blockers (§48 format)

### B1 — no production environment exists
```
BLOCKED ACTION:  Every scenario in the runbook (it is defined as production browser E2E).
WHY:             There is no deployed Orlixa environment. All configuration points at
                 localhost; OAUTH_REDIRECT_BASE is localhost, so even OAuth could not
                 complete against a hosted app.
WHAT WAS VERIFIED: The full browser suite against the real local stack — see section 3.
WHAT IS NEEDED:  A deployed web + API with a public URL, its own database, its own
                 OAUTH_REDIRECT_BASE, and Google OAuth credentials registered for that domain.
HOW TESTING RESUMES: Set E2E_WEB_URL / E2E_API_URL to the deployed URLs and re-run; the
                 suite takes both from the environment already.
```

### B2 — no access to the real Gmail inboxes
```
BLOCKED ACTION:  Test 02 (real Gmail verification), Test 24/25 (real invitation + acceptance),
                 and every step of the Golden Journey that depends on reading a real inbox.
WHY:             Signing in as kashifhussain146@gmail.com / kashifhussain.jaipur@gmail.com
                 requires their passwords and 2FA. §2 forbids putting credentials anywhere
                 near this repo, and §48 lists secure credential entry as a human-only step.
WHAT WAS VERIFIED: The OTP is a real random 6-digit code the moment mail is enabled, and it is
                 stored HASHED — so it cannot be read out of the database. That is the correct
                 design and it is also exactly why a human must open the inbox.
WHAT IS NEEDED:  A human signs into those mailboxes in the Playwright browser profile, or
                 supplies an app-password/API-scoped inbox the harness may read.
HOW TESTING RESUMES: The verification helper reads the code from that inbox instead of using
                 the development OTP.
```

### B3 — Google OAuth consent for hr@orlixa.io / support@orlixa.io
```
BLOCKED ACTION:  Test 06 (real HR Gmail connection), Test 07 (connector isolation),
                 Test 20's "sender must be hr@orlixa.io".
WHY:             Completing Google OAuth needs an interactive consent screen signed in as those
                 mailboxes, against a production OAuth client. §13 explicitly forbids
                 substituting a mock to turn this into a PASS.
WHAT WAS VERIFIED: The connector framework verifies credentials before reporting CONNECTED,
                 and per-employee connector scoping exists and is covered by backend tests.
                 Neither is evidence of a real Gmail connection.
WHAT IS NEEDED:  A human completes the Google consent for each mailbox once.
HOW TESTING RESUMES: Connector isolation and the real-sender assertion can then be exercised.
```

---

## 3. What WAS executed: the browser suite

The runbook's own premise (line 47) is that browser Playwright E2E "was authored but not
executed". It has now been executed, in a real Chromium, against a real web + API + Postgres +
Redis stack.

**Final result: 8 passed, 0 failed.**

```
01-auth-journey     a visitor can sign up, and lands authenticated              PASS
01-auth-journey     a registered user can log out and log back in               PASS
01-auth-journey     a wrong password is rejected and does not authenticate      PASS
01-auth-journey     an unauthenticated visitor cannot reach an app route        PASS
02-security-journey department isolation holds in the browser, both directions  PASS
02-security-journey a DISABLED user cannot use the app at all                   PASS
02-security-journey a MEMBER cannot reach the HR area                           PASS
03-golden-journey   signup → employee → skill → knowledge → workflow →
                    approval → execution → audit                                PASS
```

First execution was **5 failed / 3 passed**. Three defects were found and fixed to get here.

---

## 4. Defects found and fixed

### D-E2E-1 — the suite silently ran against live SMTP · P1 · FIXED
```
Expected: the suite uses the fixed development OTP, and no test address is ever emailed.
Actual:   5 of 8 journeys died at /verify-email after a 30-second timeout whose message
          ("unexpected value http://localhost:3200/verify-email") named nothing that was wrong.
Root cause: playwright.config.ts starts the API with MAIL_ENABLED=false for exactly this
          reason, and documents the hazard in a comment — but `reuseExistingServer` means that
          env block is SKIPPED whenever a developer already has `pnpm dev` running, and
          apps/api/.env carries live SMTP credentials. The guard existed and was bypassed.
Second consequence, worse than the first: had verification succeeded, the run would have
          delivered live mail from the company domain to every address the tests invent.
Fix:      global-setup now proves the development OTP is active before a single test runs, by
          registering a throwaway account and verifying it. If real codes are being sent it
          aborts in seconds with the cause and the two ways to fix it.
Verification: reproduced the abort against the mail-enabled API; suite runs clean against a
          mail-disabled one.
```

### D-E2E-2 — golden journey could not upload knowledge · P2 · FIXED
```
Expected: the journey uploads a document and sees the row.
Actual:   the row never appeared.
Root cause: NOT a harness bug. The /knowledge page now REQUIRES the uploader to choose who can
          read a document before uploading — a deliberate change made earlier the same day,
          because the page used to default to "Shared (everyone)", so an HR document uploaded
          by someone who never opened the dropdown became readable by every AI Employee. The
          journey never made that choice, so the upload was correctly blocked.
Fix:      the journey now makes the choice, because that is the real journey.
```

### D-E2E-3 — golden journey's payment step was missing a required argument · P2 · FIXED
```
Actual:   run FAILED — 'Step "charge" is missing required information: "description" is empty.'
Root cause: the fixture set only amount + currency; the catalog marks description required. The
          mock executor used to accept it. TOOL_ACTION now refuses to call a provider with a
          required argument that resolved to nothing, so an incomplete fixture surfaces.
Fix:      completed the fixture with the arguments a customer would really set.
```

---

## 5. Scenario matrix

| Test | Status | Note |
|---|---|---|
| 01 Real signup | **BLOCKED** (B1,B2) | signup itself proven in-browser with a synthetic address |
| 02 Real Gmail verification | **BLOCKED** (B2) | |
| 03 Real login | **PARTIAL** | login/logout/relogin proven in-browser, synthetic account |
| 04 Onboarding | **NOT RUN** | needs B1/B2 for the specified accounts |
| 05 AI Employee check | **PARTIAL** | employee creation covered by the golden journey |
| 06 Real HR Gmail connection | **BLOCKED** (B3) | |
| 07 Connector isolation | **BLOCKED** (B3) | |
| 08–10 Knowledge + retrieval + scope | **PASS (equivalent)** | proven against the same 8 documents in the NovaByte QA pack — see `QA/RESULTS.md` QA-08 |
| 11–12 AI Assist generation + safety | **PASS (equivalent)** | `QA/RESULTS.md` QA-01/02 |
| 13–17 Manual workflow → publish → activate → run | **PASS** | golden journey, in-browser |
| 18–20 Approval / reject / approve | **PASS** | golden journey + `QA/RESULTS.md` |
| 21 Scheduling | **NOT RUN** | |
| 22–23 Department / team | **PARTIAL** | department isolation proven in-browser (02-security) |
| 24–25 Real invitation + acceptance | **BLOCKED** (B2) | |
| 26 Permission security | **PASS** | 02-security: MEMBER cannot reach HR, isolation both directions |
| 27 Disabled user | **PASS** | 02-security, in-browser |
| 28 Prompt injection | **PASS (equivalent)** | `QA/RESULTS.md` QA-02 |
| 29 Missing data | **PASS (equivalent)** | `QA/RESULTS.md` QA-10 |
| 30 Duplicate event | **PASS after a fix** | `QA/RESULTS.md` QA-09 — a provider retry ran the workflow twice; fixed |
| 31 Approval survives refresh/relogin | **NOT RUN** | |

"PASS (equivalent)" means the behaviour was proven this week against a real stack with a real
LLM, but through the QA pack rather than this runbook's accounts. It is **not** a substitute for
the production browser run the runbook demands.

---

## Final verdict

**BLOCKED — not PASS, not FAIL.**

The investor acceptance gate cannot be evaluated: it is defined as real production + real Gmail +
real OAuth, and none of the three exists or is reachable. Reporting anything else would trip §46
("fake verification success", "mock email reported as real email").

What can be said with evidence: the browser journey harness now runs, and **8 of 8 browser
journeys pass** against a real stack, including department isolation, disabled-user denial,
member-vs-HR permission denial, and a full signup → employee → skill → knowledge → workflow →
approval → execution → audit journey. Three real defects were found and fixed in getting there,
one of which was quietly sending live email from the company domain to invented addresses.

To lift the blockers, a human needs to: deploy an environment, sign into the two Gmail accounts
once in the test browser, and complete Google OAuth consent for `hr@orlixa.io` and
`support@orlixa.io`.
