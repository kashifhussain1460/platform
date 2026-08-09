# 28 — Marketing Employee · Production Workflow Specifications

**Date:** 2026-08-01 · **Employee:** Marketing (`EmployeeRole.MARKETING` — ⛔ **not shipped, gap G10**)
**Node identifiers:** frozen per `26-mvp-node-contract-freeze.md`.
**Skills:** only the 14 real catalog entries.

---

## 0. Read this before implementing

### 0.1 The inverse of HR

HR has the role but not the data models. **Marketing has the data models but not the role.** Verified
against `apps/api/prisma/schema.prisma`:

| Model | Shipped? |
|---|---|
| `SocialAccount`, `Campaign`, `ScheduledPost`, `PublishedPost` | ✅ yes |
| `MediaAsset`, `BrandAsset`, `MarketingAnalyticsSnapshot` | ✅ yes |
| `EmployeeRole.MARKETING` | ❌ **no — G10** |

**Every workflow here is data-ready and blocked only on G10** — a single enum value plus migration.
That makes Marketing the cheaper of the two employees to bring live, despite HR having three
buildable workflows today.

**Do not ship Marketing as `EmployeeRole.CUSTOM`.** It breaks role-scoped knowledge retrieval, so the
employee would silently retrieve HR or Sales knowledge when writing campaign copy.

### 0.2 Publishing is approval-gated by the platform, not by policy

Verified in the catalog: **`postiz.schedule_post` and `postiz.publish_now` are both `highRisk: true`.**

Because of the G25 fix (shipped), a `TOOL_ACTION` calling either one **automatically pauses the run**
and opens an approval — even if the workflow author forgot to add an `APPROVAL` node. The platform
enforces "nothing is published without a human" mechanically.

The explicit `APPROVAL` nodes below are still specified, because they carry richer context (the draft,
the brand check, the schedule) than a bare tool-gate prompt. But if one were omitted, the post still
would not go out silently. That is the safety property worth relying on.

### 0.3 Skills available to Marketing

`postiz` (list_connected_accounts, start_connect_account, schedule_post 🔴, publish_now 🔴,
get_post_status) · `hubspot` (create_contact, update_deal) · `gmail`/`email` (send_email) ·
`chatwoot` (list_open_conversations, get_conversation, reply_to_conversation, resolve_conversation) ·
`gdrive` (assets) · `slack` (internal) · `http` (request).

**No SEO tool, no ad-platform connector, no analytics connector exists.** MK-07 (SEO) and MK-10
(Analytics) therefore use `http.request` against customer-configured endpoints, or operate on
first-party data only. Do not invent connectors.

### 0.4 Approval tiering

| Tier | Meaning | Approval | Examples |
|---|---|---|---|
| **T0** | Internal, read-only | none | analytics rollups, monitoring |
| **T1** | Internal artefact | none, audit | draft generation, campaign plan draft |
| **T2** | Leaves the company | **`APPROVAL`** | any publish, any send to a prospect list |
| **T3** | Brand/legal/spend risk | **`APPROVAL` + brand check** | claims, regulated copy, paid spend |

**Nothing addressed to the public is autonomous.** Marketing's blast radius is reputational and
irreversible — a deleted tweet has already been screenshotted.

### 0.5 Graph notation

`NODE_TYPE[id]`; `-->` main port; `--(port)-->` a named port. 🔴 = platform-enforced highRisk gate.

---

## MK-01 · Campaign Planning
**Tier:** T1 · **Template:** ✅ reusable (`mkt.campaign-plan`)

| Field | Value |
|---|---|
| **Trigger** | `TRIGGER(MANUAL)` — a human always initiates a campaign |
| **Actors** | Marketing manager (**owns**), Marketing Employee (**drafts**) |
| **AI responsibility** | Draft objectives, audience, channel mix, calendar and KPIs from the brief |
| **Skills** | `gdrive.read_file` (brand/strategy docs), `slack.send_message` |
| **Knowledge** | `RETRIEVE` — brand guidelines, past campaign retrospectives, ICP definitions (category `MARKETING`) |
| **Memory** | What worked/failed in prior campaigns for this audience |
| **Input** | `{ objective, budget?, startDate, endDate, channels[], audience }` |
| **Conditions** | Budget within limit; channels connected (`postiz.list_connected_accounts`) |
| **Human approvals** | 🔴 **`APPROVAL` on the plan before any content work begins** — an unapproved plan wastes the whole downstream chain |
| **Output** | `Campaign` record, content calendar, KPI targets |
| **Failure** | No connected accounts for a requested channel → surface before planning, not after |
| **Retry** | ×2 on knowledge retrieval |
| **Escalation** | No approval in 5 days → manager reminder |
| **Audit** | `full` — plan, approver, budget |
| **KPIs** | Plan-to-launch time; plan revision count; forecast vs actual |
| **Security** | Budget figures are commercially sensitive — keep out of Slack channels |

```
TRIGGER[t1] --> RETRIEVE[brand_and_history] --> MEMORY_READ[prior_campaigns]
  --> TOOL_ACTION[list_connected_accounts]
  --> CONDITION[channels_ready]
    channels_ready --(false)--> TOOL_ACTION[slack_connect_needed] --> TERMINATE[blocked]
    channels_ready --(true)--> AI_EMPLOYEE_STEP[draft_plan]
      --> APPROVAL[manager_approves_plan]
        --(rejected)--> TERMINATE[revise]
        --(approved)--> SET_VARIABLE[campaign_id]
          --> MEMORY_WRITE[log] --> TERMINATE[done]
```

---

## MK-02 · Content Generation
**Tier:** T1 · **Template:** ✅ reusable (`mkt.content-generate`)

| Field | Value |
|---|---|
| **Trigger** | `TRIGGER(EVENT)` — campaign approved; or `TRIGGER(MANUAL)` |
| **Actors** | Content marketer (**edits**), Marketing Employee (**drafts**) |
| **AI responsibility** | Generate channel-appropriate variants against brand voice. Draft only |
| **Skills** | `gdrive.read_file` (brand assets), `gdrive.upload_file` |
| **Knowledge** | Brand voice guide, tone rules, banned-claims list, product facts |
| **Memory** | High-performing past copy for this audience |
| **Input** | `{ campaignId, contentType, channel, brief }` |
| **Conditions** | Length limits per channel; brand-voice check passes |
| **Human approvals** | None to *generate* (internal artefact). 🔴 Approval happens at MK-03 before publish |
| **Output** | Draft variants stored as `MediaAsset`/Drive files, linked to the campaign |
| **Failure** | Low-confidence output → flag rather than silently ship a weak draft |
| **Retry** | LLM ×3 |
| **Escalation** | 3 rejected drafts in a row → human takes over; the brief is likely wrong |
| **Audit** | `metadata` + prompt version |
| **KPIs** | Draft acceptance rate; edit distance; time-to-first-draft |
| **Security** | 🔴 **Never let the model state product claims not in the knowledge base.** Hallucinated claims are a legal exposure. Ground with `RETRIEVE` and cite |

```
TRIGGER[t1] --> RETRIEVE[brand_voice_and_facts] --> MEMORY_READ[top_performers]
  --> LOOP[per_channel]
      --(body)--> AI_EMPLOYEE_STEP[draft_variant]
          --> CONDITION[within_limits]
            within_limits --(false)--> TRANSFORM[truncate_or_reflow]
            within_limits --(true)--> NOOP[n1]
          --> TOOL_ACTION[store_draft]
      --(done)--> MEMORY_WRITE[log] --> TERMINATE[done]
```

---

## MK-03 · Content Approval
**Tier:** T2/T3 · **Template:** ✅ reusable (`mkt.content-approval`) — **the gate every publish path routes through**

| Field | Value |
|---|---|
| **Trigger** | `TRIGGER(EVENT)` — draft ready |
| **Actors** | Content marketer, Brand/Legal reviewer (for T3), Marketing Employee |
| **AI responsibility** | Run automated brand + compliance checks and present findings **to** the approver |
| **Skills** | `slack.send_message`, `gdrive.read_file` |
| **Knowledge** | Brand guidelines, regulated-claims list, competitor-mention policy |
| **Memory** | Prior rejection reasons |
| **Input** | `{ draftId, channel, campaignId }` |
| **Conditions** | Contains a regulated claim → escalate to T3 |
| **Human approvals** | 🔴 **Always at least one.** Regulated/comparative claims require a **second**, legal approval |
| **Output** | Approved content ready to schedule, or rejection with reasons |
| **Failure** | Check inconclusive → treat as **needs review**, never as pass |
| **Retry** | ×2 |
| **Escalation** | No decision in 48h → marketing lead |
| **Audit** | `full` — what was approved, by whom, which version |
| **KPIs** | Approval turnaround; rejection rate by reason; escalation rate |
| **Security** | The approved artefact must be **immutable** — approving v1 then publishing v2 is the classic bypass. Hash the draft at approval and verify before publish |

```
TRIGGER[t1] --> RETRIEVE[brand_rules] --> AI_EMPLOYEE_STEP[brand_compliance_check]
  --> SWITCH[risk]
    --(standard)--> APPROVAL[marketer_approves]
    --(regulated)--> APPROVAL[marketer_approves]
        --(approved)--> APPROVAL[legal_approves]
    --(blocked)--> TOOL_ACTION[notify_rejected] --> TERMINATE[blocked]
  --> SET_VARIABLE[approved_hash]
  --> MEMORY_WRITE[log] --> TERMINATE[approved]
```

`approved_hash` is what MK-05 verifies. Without it, "approved" means nothing at publish time.

---

## MK-04 · Social Media Scheduling
**Tier:** T2 · **Template:** ✅ reusable (`mkt.social-schedule`)

| Field | Value |
|---|---|
| **Trigger** | `TRIGGER(EVENT)` — content approved |
| **Actors** | Marketing Employee, Marketing manager |
| **AI responsibility** | Pick optimal slots per channel, avoid collisions, queue the post |
| **Skills** | `postiz.schedule_post` 🔴, `postiz.list_connected_accounts` |
| **Knowledge** | Channel best-practice timing, posting cadence policy |
| **Memory** | Historical engagement by time-of-day per channel |
| **Input** | `{ approvedContentId, channels[], preferredWindow? }` |
| **Conditions** | Account connected and healthy; no collision within the cadence window |
| **Human approvals** | 🔴 **Platform-enforced** — `schedule_post` is `highRisk`, so the run pauses for approval automatically |
| **Output** | `ScheduledPost` rows per channel |
| **Failure** | Account `DISCONNECTED` → quarantine the step, notify, do not silently drop the post |
| **Retry** | `EXPONENTIAL ×3`; connector-unavailable is retryable, auth failure is not |
| **Escalation** | Account disconnected > 24h → marketing lead |
| **Audit** | `full` |
| **KPIs** | Scheduled-on-time rate; collision count; slot-optimality lift |
| **Security** | Verify the content hash from MK-03 before scheduling |

```
TRIGGER[t1] --> CONDITION[hash_matches_approved]
  hash_matches_approved --(false)--> TOOL_ACTION[alert_tamper] --> TERMINATE[blocked]
  hash_matches_approved --(true)--> TOOL_ACTION[list_connected_accounts]
    --> LOOP[per_channel]
        --(body)--> CONDITION[account_healthy]
            account_healthy --(false)--> TOOL_ACTION[notify_disconnected]
            account_healthy --(true)--> AI_EMPLOYEE_STEP[pick_slot]
                --> TOOL_ACTION[schedule_post]   # 🔴 highRisk → auto-approval gate
        --(done)--> MEMORY_WRITE[log] --> TERMINATE[done]
```

---

## MK-05 · Social Publishing
**Tier:** T2 · **Template:** ✅ reusable (`mkt.social-publish`)

| Field | Value |
|---|---|
| **Trigger** | `TRIGGER(SCHEDULE)` — the scheduled time; or `TRIGGER(MANUAL)` for publish-now |
| **Actors** | Marketing Employee, Marketing manager |
| **AI responsibility** | Execute the publish, confirm, record the result |
| **Skills** | `postiz.publish_now` 🔴, `postiz.get_post_status` |
| **Knowledge** | Channel-specific formatting rules |
| **Memory** | Publish failures by channel |
| **Input** | `{ scheduledPostId }` |
| **Conditions** | Still approved; still within the campaign window; account healthy |
| **Human approvals** | 🔴 **Platform-enforced** on `publish_now`. An explicit `APPROVAL` is added for publish-now (no prior scheduling review happened) |
| **Output** | `PublishedPost` with external id and permalink |
| **Failure** | 🔴 **Publishing is irreversible.** On ambiguous failure, `get_post_status` **before** any retry — a blind retry double-posts |
| **Retry** | ×2 **only after** a status check confirms nothing was published |
| **Escalation** | Any double-post → immediate marketing lead alert |
| **Audit** | `full` — the permalink is the evidence |
| **KPIs** | Publish success rate; double-post count (**target 0**); time-to-live |
| **Security** | A compromised social account is a brand crisis. Verify connector health; alert on unexpected auth changes |

```
TRIGGER[t1] --> CONDITION[still_approved]
  still_approved --(false)--> TERMINATE[cancelled]
  still_approved --(true)--> TOOL_ACTION[get_post_status]
    --> CONDITION[already_published]
      already_published --(true)--> MEMORY_WRITE[dedup_noted] --> TERMINATE[skipped]
      already_published --(false)--> TOOL_ACTION[publish_now]   # 🔴 highRisk gate
        --> TOOL_ACTION[confirm_status]
        --> CONDITION[confirmed]
          confirmed --(false)--> TOOL_ACTION[alert_lead] --> TERMINATE[uncertain]
          confirmed --(true)--> MEMORY_WRITE[log] --> TERMINATE[done]
```

The `get_post_status` check **before** publishing is what makes this safe under retry. It is the
workflow-level expression of doc 16 §6.5's `outcomeUnknown` rule.

---

## MK-06 · Email Marketing
**Tier:** T3 · **Template:** ✅ reusable (`mkt.email-campaign`)

| Field | Value |
|---|---|
| **Trigger** | `TRIGGER(MANUAL)` or `TRIGGER(SCHEDULE)` |
| **Actors** | Marketing manager (**approves**), Marketing Employee |
| **AI responsibility** | Draft, segment, personalise, schedule the send |
| **Skills** | `gmail.send_email` / `email.send_email`, `hubspot.create_contact` |
| **Knowledge** | Email policy, unsubscribe/consent rules, brand voice |
| **Memory** | Prior open/click rates by segment |
| **Input** | `{ campaignId, segmentQuery, subject, body }` |
| **Conditions** | Consent verified; suppression list applied; **send volume within limit** |
| **Human approvals** | 🔴 **`APPROVAL` on the final content AND the recipient count.** Both, because approving copy without seeing "42,000 recipients" is not informed consent |
| **Output** | Send record, per-recipient status |
| **Failure** | Partial send → record exactly who received it; never blind-resend the whole list |
| **Retry** | Per-recipient, idempotency-keyed. **Never retry a whole batch** |
| **Escalation** | Bounce rate > 5% → pause the send and alert |
| **Audit** | `full` — consent basis per recipient |
| **KPIs** | Delivery, open, click, unsubscribe, spam-complaint rate |
| **Security** | 🔴 **Consent and suppression are legal requirements** (GDPR/CAN-SPAM). Suppression check is mandatory and non-bypassable. A mis-sent bulk email cannot be recalled |

```
TRIGGER[t1] --> AI_EMPLOYEE_STEP[draft_email] --> TRANSFORM[resolve_segment]
  --> TRANSFORM[apply_suppression_list]
  --> CONDITION[consent_verified]
    consent_verified --(false)--> TERMINATE[blocked]
    consent_verified --(true)--> SET_VARIABLE[recipient_count]
      --> APPROVAL[approve_content_and_volume]
        --(rejected)--> TERMINATE[cancelled]
        --(approved)--> LOOP[per_recipient]
            --(body)--> TOOL_ACTION[send_email]      # idempotency-keyed per recipient
            --(done)--> CONDITION[bounce_rate_ok]
                bounce_rate_ok --(false)--> TOOL_ACTION[alert_pause]
                bounce_rate_ok --(true)--> MEMORY_WRITE[log] --> TERMINATE[done]
```

---

## MK-07 · SEO Content
**Tier:** T2 · **Template:** ⚠️ partial — depends on the customer's CMS/SEO stack

| Field | Value |
|---|---|
| **Trigger** | `TRIGGER(SCHEDULE)` or `TRIGGER(MANUAL)` |
| **Actors** | Content marketer, SEO owner, Marketing Employee |
| **AI responsibility** | Draft long-form content against a keyword brief; internal-link suggestions |
| **Skills** | `http.request` (customer SEO/CMS endpoint), `gdrive.upload_file` |
| **Knowledge** | Keyword strategy, content pillars, style guide |
| **Memory** | Which topics already rank; cannibalisation risk |
| **Input** | `{ keyword, intent, targetLength, pillarId }` |
| **Conditions** | No cannibalisation with existing content |
| **Human approvals** | 🔴 **`APPROVAL` before publication to the site** — public, indexed, and hard to fully retract |
| **Output** | Draft article, meta description, internal links |
| **Failure** | No SEO endpoint configured → operate on first-party data only and say so |
| **Retry** | ×2 |
| **Escalation** | Cannibalisation detected → SEO owner decides |
| **Audit** | `metadata` |
| **KPIs** | Publish cadence; ranking movement; organic sessions |
| **Security** | ⚠️ **No SEO connector exists.** This is `http.request` against a customer endpoint — validate through the SSRF guard, never accept an arbitrary URL from config |

```
TRIGGER[t1] --> RETRIEVE[content_pillars] --> MEMORY_READ[existing_topics]
  --> CONDITION[cannibalisation_risk]
    cannibalisation_risk --(true)--> APPROVAL[seo_owner_decides]
    cannibalisation_risk --(false)--> NOOP[n1]
  --> AI_EMPLOYEE_STEP[draft_article]
  --> APPROVAL[approve_publication]
    --(approved)--> TOOL_ACTION[push_to_cms]
      --> MEMORY_WRITE[log] --> TERMINATE[done]
```

---

## MK-08 · Lead Generation
**Tier:** T2 · **Template:** ✅ reusable (`mkt.lead-capture`)

| Field | Value |
|---|---|
| **Trigger** | `TRIGGER(WEBHOOK)` — form submission; or `TRIGGER(EVENT)` from Chatwoot |
| **Actors** | Prospect, Sales (**owns follow-up**), Marketing Employee |
| **AI responsibility** | Enrich, score, route. **Does not sell** |
| **Skills** | `hubspot.create_contact`, `hubspot.update_deal`, `chatwoot.get_conversation`, `slack.send_message` |
| **Knowledge** | ICP definition, lead-scoring rubric, routing rules |
| **Memory** | Prior touches from this company/domain |
| **Input** | `{ email, name?, company?, source, formData }` |
| **Conditions** | Valid email; not an existing customer; score band |
| **Human approvals** | Auto for CRM creation (internal). 🔴 **`APPROVAL` before any outbound message to the prospect** |
| **Output** | CRM contact, score, routed owner, Slack notification |
| **Failure** | CRM unavailable → queue locally, never drop a lead |
| **Retry** | `EXPONENTIAL ×3` |
| **Escalation** | High-value lead unactioned in 1h → sales lead |
| **Audit** | `full` — lead source and consent basis |
| **KPIs** | Lead-to-MQL rate; routing accuracy; time-to-first-touch |
| **Security** | 🔴 Consent basis must be captured **at the form**, not inferred. Enriching from third parties may itself need a lawful basis |

```
TRIGGER[t1] --> CONDITION[valid_email]
  valid_email --(false)--> TERMINATE[discard]
  valid_email --(true)--> MEMORY_READ[prior_touches]
    --> AI_EMPLOYEE_STEP[enrich_and_score]
    --> TOOL_ACTION[crm_create_contact]
    --> SWITCH[score_band]
        --(hot)-->  TOOL_ACTION[slack_sales_urgent]
        --(warm)--> TOOL_ACTION[slack_sales]
        --(cold)--> SET_VARIABLE[nurture_queue]
    --> CONDITION[outbound_wanted]
        outbound_wanted --(true)--> APPROVAL[approve_outreach]
            --(approved)--> TOOL_ACTION[send_outreach]
        outbound_wanted --(false)--> NOOP[n1]
    --> MEMORY_WRITE[log] --> TERMINATE[done]
```

---

## MK-09 · Campaign Monitoring
**Tier:** T0 · **Template:** ✅ reusable (`mkt.campaign-monitor`)

| Field | Value |
|---|---|
| **Trigger** | `TRIGGER(SCHEDULE)` — hourly during an active campaign |
| **Actors** | Marketing Employee, Marketing manager |
| **AI responsibility** | Watch performance, detect anomalies, recommend. **Never changes spend or content** |
| **Skills** | `postiz.get_post_status`, `http.request`, `slack.send_message` |
| **Knowledge** | Campaign KPI targets, historical benchmarks |
| **Memory** | Baseline performance per channel |
| **Input** | `{ campaignId }` |
| **Conditions** | Metric deviates > threshold from forecast |
| **Human approvals** | None to observe/report. 🔴 **Any corrective action is a separate approved workflow** |
| **Output** | `MarketingAnalyticsSnapshot`, anomaly alerts, recommendations |
| **Failure** | Metrics unavailable → report the gap, never impute |
| **Retry** | ×3 then skip the interval |
| **Escalation** | Severe underperformance → manager within the hour |
| **Audit** | `metadata` |
| **KPIs** | Anomaly detection precision; alert-to-action time |
| **Security** | Performance data is commercially sensitive |

```
TRIGGER[t1] --> PARALLEL[collect]
    --> TOOL_ACTION[post_metrics]
    --> TOOL_ACTION[site_metrics]
  JOIN[j1] --> TRANSFORM[normalise] --> MEMORY_READ[baseline]
    --> AI_EMPLOYEE_STEP[detect_anomalies]
    --> CONDITION[anomaly]
      anomaly --(true)--> TOOL_ACTION[alert_manager]
      anomaly --(false)--> NOOP[n1]
    --> MEMORY_WRITE[snapshot] --> TERMINATE[done]
```

---

## MK-10 · Marketing Analytics
**Tier:** T0 · **Template:** ✅ reusable (`mkt.analytics-report`)

| Field | Value |
|---|---|
| **Trigger** | `TRIGGER(SCHEDULE)` — weekly/monthly |
| **Actors** | Marketing manager, Leadership, Marketing Employee |
| **AI responsibility** | Aggregate across campaigns, attribute, narrate results honestly |
| **Skills** | `http.request`, `gdrive.upload_file`, `slack.send_message`, `email.send_email` |
| **Knowledge** | Attribution model, KPI definitions |
| **Memory** | Prior period results for trend |
| **Input** | `{ period, scope }` |
| **Conditions** | Data completeness ≥ threshold |
| **Human approvals** | None for internal distribution. 🔴 **`APPROVAL` if the report goes to an external party (board, investor)** |
| **Output** | Report, trend analysis, recommendations |
| **Failure** | Incomplete data → **state the gap in the report**, do not silently omit |
| **Retry** | ×3 |
| **Escalation** | Data completeness < 80% → do not publish, alert ops |
| **Audit** | `metadata` |
| **KPIs** | Report timeliness; data completeness; recommendation adoption |
| **Security** | 🔴 **The model must never invent a number.** Every figure traces to a snapshot; unavailable metrics are reported as unavailable |

```
TRIGGER[t1] --> TOOL_ACTION[fetch_snapshots] --> CONDITION[completeness_ok]
  completeness_ok --(false)--> TOOL_ACTION[alert_ops] --> TERMINATE[blocked]
  completeness_ok --(true)--> TRANSFORM[aggregate] --> MEMORY_READ[prior_period]
    --> AI_EMPLOYEE_STEP[narrate_results]
    --> CONDITION[external_audience]
      external_audience --(true)--> APPROVAL[approve_external]
          --(approved)--> TOOL_ACTION[send_report]
      external_audience --(false)--> TOOL_ACTION[post_internal]
    --> MEMORY_WRITE[log] --> TERMINATE[done]
```

---

## MK-11 · Brand Compliance
**Tier:** T2 · **Template:** ✅ reusable (`mkt.brand-audit`) — **also embedded as a sub-check in MK-03**

| Field | Value |
|---|---|
| **Trigger** | `TRIGGER(SCHEDULE)` — weekly audit; or `TRIGGER(EVENT)` per asset |
| **Actors** | Brand owner (**decides**), Marketing Employee |
| **AI responsibility** | Check published and pending assets against brand rules; flag drift |
| **Skills** | `gdrive.list_files`, `gdrive.read_file`, `postiz.get_post_status`, `slack.send_message` |
| **Knowledge** | Brand guidelines, logo/colour/tone rules, banned claims, trademark usage |
| **Memory** | Prior violations and resolutions |
| **Input** | `{ scope, period }` |
| **Conditions** | Violation severity band |
| **Human approvals** | 🔴 **`APPROVAL` before requesting removal of anything already published** — takedowns are themselves visible events |
| **Output** | Findings, severity, remediation actions |
| **Failure** | Ambiguous → flag for human review, never auto-clear |
| **Retry** | ×2 |
| **Escalation** | Trademark or regulated-claim violation → brand owner + legal immediately |
| **Audit** | `full` |
| **KPIs** | Violation rate; time-to-remediate; repeat-violation count |
| **Security** | Brand rules may include unreleased product names — restrict knowledge access to the `MARKETING` category |

```
TRIGGER[t1] --> TOOL_ACTION[collect_assets] --> RETRIEVE[brand_rules]
  --> LOOP[per_asset]
      --(body)--> AI_EMPLOYEE_STEP[check_compliance]
          --> SWITCH[severity]
              --(clean)--> NOOP[n1]
              --(minor)--> TOOL_ACTION[notify_owner]
              --(major)--> APPROVAL[brand_owner_decides]
                  --(approved)--> TOOL_ACTION[request_takedown]
      --(done)--> MEMORY_WRITE[findings] --> TERMINATE[done]
```

---

## Summary

| # | Workflow | Tier | Approvals | Template | Blocked by |
|---|---|---|---|---|---|
| MK-01 | Campaign Planning | T1 | **1** | ✅ | G10 |
| MK-02 | Content Generation | T1 | 0 (gated at MK-03) | ✅ | G10 |
| MK-03 | Content Approval | T2/T3 | **1–2** | ✅ | G10 |
| MK-04 | Social Scheduling | T2 | **1** (platform-enforced) | ✅ | G10 |
| MK-05 | Social Publishing | T2 | **1** (platform-enforced) | ✅ | G10 |
| MK-06 | Email Marketing | T3 | **1** (content + volume) | ✅ | G10 |
| MK-07 | SEO Content | T2 | **1–2** | ⚠️ | G10 + no SEO connector |
| MK-08 | Lead Generation | T2 | **1** (outbound only) | ✅ | G10 |
| MK-09 | Campaign Monitoring | T0 | 0 | ✅ | G10 |
| MK-10 | Marketing Analytics | T0 | 0–**1** | ✅ | G10 |
| MK-11 | Brand Compliance | T2 | **1** (takedowns) | ✅ | G10 |

**9 of 11 have at least one mandatory human approval.** The two that don't (MK-09, MK-10) are
read-only. **Nothing public is autonomous** — and for `schedule_post`/`publish_now` that is enforced by
the platform's `highRisk` flag, not merely by workflow design.

**Templates:** 10 fully reusable, 1 partial (MK-07 depends on the customer's CMS).

---

## Cross-cutting: what unblocks both employees

| Blocker | Unblocks | Effort |
|---|---|---|
| **G10** — add `MARKETING` to `EmployeeRole` | **All 11 Marketing workflows** | One enum value + migration |
| **Doc-12 HR schema** — 6 models | HR-04 … HR-11 (8 workflows) | Substantial migration |
| One-Gmail-trigger conflict (§0.4 in doc 27) | HR-01 + HR-02 running together | Design decision |
| No SEO/ads/analytics connectors | MK-07, parts of MK-09/MK-10 | Customer-configured `http` or new connectors |

**Recommended order:** close **G10** first. It is a single enum value that unblocks eleven
production workflows against data models that already exist — by a wide margin the highest
value-per-unit-effort item in either document.
