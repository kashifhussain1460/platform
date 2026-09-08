# Real Estate Lead Agent — Design

**Date:** 2026-09-08
**Status:** design document, approved section-by-section with the product owner during brainstorming.
**Scope:** the 3rd of the 3 new products approved in the V-AEP proposal (Section 9). Unlike the WhatsApp
Sales Agent, this is deliberately the "medium" lift — no new connector. It reuses the WhatsApp engine,
the shared `Lead` entity, and existing skills, adding only a qualification workflow and one small tool.

---

## 1. Intake channel: reuse WhatsApp as-is (confirmed with product owner)

**Decision:** Real Estate leads arrive through the SAME WhatsApp engine the Sales Agent already built
(`modules/engines/whatsapp/`) — the webhook, Twilio signature verification, and `Lead`/`Conversation`/
`Message` creation on inbound messages are untouched. No new intake channel, no new connector.

**How a company gets one workflow, not both:** a company installs either the Sales qualification
template (`sales.whatsapp-lead-qualify`) or the Real Estate one (`realestate.whatsapp-lead-qualify`) —
not both — matching the proposal's own framing of these as different verticals of the same underlying
WhatsApp Sales Agent capability. Both templates fire on the same `NEW_LEAD` canonical event; a company
with only one installed sees only that one run. (Multi-vertical companies running both at once is an
explicit non-goal for v1 — no discriminator is built for it.)

## 2. `Lead.phone` stays `NOT NULL` — no schema change needed

The earlier WhatsApp final-review flagged `Lead.phone NOT NULL` as a risk "if a Real Estate lead is
captured by web form (email, no phone)." Since intake stays WhatsApp-only (§1), every Real Estate lead
genuinely has a phone number, same as every Sales lead — the flagged risk does not apply, and no
migration is needed. `Lead.source` stays `WHATSAPP` for these rows too (it names the channel, not the
vertical); the vertical-specific qualification fields (budget/location/propertyType vs. budget/need/
timeline) live in the existing free-form `qualificationData` Json column, same pattern Sales already
uses.

## 3. `LeadStatus` stays as-is — no new status

**Decision (confirmed):** site-visit scheduling is tracked in `qualificationData` (`siteVisitAt`,
`siteVisitEventId`), not a new `LeadStatus` enum value. `QUALIFIED` still means "the AI assessed this
as a real prospect" for both verticals. No migration needed.

## 4. New skill: `leads` (channel-agnostic, one tool)

Site-visit booking doesn't belong under the `whatsapp` skill — it's not a WhatsApp action, it's a
Lead action that happens to be triggered by a WhatsApp conversation. A new, small `leads` skill (parallel
to `whatsapp`, not nested under it) keeps `Lead`-level actions available to any future channel, matching
the entity's own "shared, reusable" design goal from the WhatsApp plan.

- **`leads.schedule_site_visit(leadId, start, end)`** — wraps the existing, already-real
  `calendar.create_event` tool (no Google Meet link — this is an in-person visit) and, on success, writes
  `qualificationData.siteVisitAt`/`siteVisitEventId` onto the `Lead` row so the booking stays linked and
  visible on `/leads/:id`.
- **Status updates reuse the existing `whatsapp.update_lead_status` tool as-is** — its actual
  implementation is already channel-agnostic (a plain `companyId`-scoped `Lead.status` update, nothing
  WhatsApp-specific in the logic despite living in the `whatsapp` skill's catalog entry) — no new tool
  needed. A company running the Real Estate template already has `whatsapp` installed (leads arrive via
  it), so the tool is available.

## 5. Workflow template: `realestate.whatsapp-lead-qualify`

Follows the exact frozen-17-vocab shape `sales.whatsapp-lead-qualify` already established (AI_EMPLOYEE_STEP
+ TOOL_ACTION + CONDITION only, no APPROVAL/LOOP):

```
EVENT trigger (WhatsApp inbound message → NEW_LEAD canonical event, shared with Sales)
  → AI_EMPLOYEE_STEP (qualify: assess budget/location/property-type fit from the message; if the lead
     also stated a preferred visit day/time, extract it as an ISO-ish string, else empty string —
     disableTools:true, unconditional at the runtime layer, "recommends only")
  → CONDITION (interested?) — {{qualification.interested}} eq 'true'
     → TRUE:
        → CONDITION (preferred time given?) — {{qualification.preferredTime}} neq ''
           → TRUE:  TOOL_ACTION (leads.schedule_site_visit) → TOOL_ACTION (whatsapp.update_lead_status
                     → QUALIFIED) → TOOL_ACTION (notify agent, Slack)
           → FALSE: TOOL_ACTION (whatsapp.send_message — ask for a preferred visit day/time) →
                     TOOL_ACTION (notify agent, Slack, for manual follow-up)
     → FALSE: TOOL_ACTION (whatsapp.send_template — nurture follow-up)
```

`ConditionOp` (verified against `node-handler.ts`'s real `compare()` switch, not guessed) supports
`eq`/`neq`/`contains`/`gt`/`lt` — no `exists` operator, which is why "preferred time given?" is checked
via `neq ''` against an AI-instructed empty-string default, not a null-check.

**Auto-booking safety note:** `leads.schedule_site_visit` commits a real calendar slot without checking
the agent's actual availability beyond whatever `calendar.create_event` itself does — this is an accepted
v1 trade-off (matching the WhatsApp Sales Agent's own precedent of shipping the minimal real loop first),
not a gap to solve in this plan. A double-booking is visible and correctable by a human, not a permanent
or unrecoverable failure.

## 6. What this design deliberately does NOT cover

- Real HubSpot/CRM sync — HubSpot has no real executor in this codebase (confirmed: it's `SIMULATED`,
  `assertNotSimulatedInProduction` would reject a production connect). "CRM" for this feature is
  Orlixa's own `Lead` table, the same honest choice the WhatsApp Sales Agent already made for its own
  `update_lead_status` tool. Building a real HubSpot executor is out of scope — a separate, unrelated
  piece of work if ever wanted.
- Multi-vertical companies (both Sales and Real Estate templates active at once) — no discriminator
  built; a company runs one or the other.
- Property-listing data (no `Property` entity, no "which property is this about" tracking) — out of
  scope per the proposal's own listed capabilities (enquiry handling, qualification, site visits, CRM
  update — not inventory management).
