# WhatsApp Sales Agent — Engine Integration Design

**Date:** 2026-09-06
**Status:** design document, approved section-by-section with the product owner during brainstorming.
**Scope:** the largest of the 3 new products approved in the V-AEP proposal (Section 9) — a genuinely
new connector (WhatsApp has no self-hosted option, unlike Postiz/Chatwoot/Plane). Real Estate Lead Agent
follows separately and reuses this design's `Lead` entity.

This document follows the same shape as `docs/plans/2026-07-20-chatwoot-support-engine-plan.md` and
`docs/plans/2026-07-20-plane-pm-engine-plan.md` — a new "engine" wired behind the existing `EngineAdapter`
contract (`apps/api/src/modules/engines/engine-adapter.ts`), not a new architecture pattern.

---

## 1. Provider choice: Twilio (not Meta Cloud API direct)

Twilio is a WhatsApp Business Solution Provider (BSP) — it absorbs Meta's business-verification and
embedded-signup complexity behind Twilio's own account/subaccount model, and this session has the
`twilio-developer-kit` skill set available (WhatsApp send/receive, webhook architecture, A2P/WhatsApp
compliance onboarding) to ground the implementation in Twilio's actual current API surface rather than
stale training-data knowledge. **Implementation must consult those skills for exact API shapes,
compliance requirements (opt-in/consent, template approval), and the 24-hour session-window rule** — this
document specifies the Orlixa-side architecture, not the full Twilio API contract.

## 2. Tenancy model: per-company Twilio credentials (Chatwoot pattern, not Postiz pattern)

**Decision (confirmed with product owner):** each Orlixa customer connects their **own** WhatsApp
Business number — leads see the customer's own business identity, not Orlixa's. This is the opposite
tenancy shape from Postiz (one shared Orlixa-owned instance/API key for every company) and matches
Chatwoot exactly (`ChatwootAccount`, per-company `agentBotToken`, per-company resource key so one
tenant's broken credentials never trip the circuit breaker for another tenant's independent account).

Rejected: a single shared Orlixa Twilio number with message-routing by tenant (loses per-business
branding, not what a B2B customer wants their own leads to see).

## 3. New Prisma models

```
Company (existing)
  │
  ├── WhatsAppAccount        companyId, twilioAccountSid, twilioAuthToken (encrypted, CryptoService,
  │                          same v1: envelope pattern as ChatwootAccount.agentBotToken),
  │                          whatsappSenderNumber, status (CONNECTED/DISCONNECTED/DEGRADED — mirrors
  │                          SkillConnectionStatus shape), employeeId? (per-employee connection,
  │                          reusing the per-employee-skill-connections pattern already shipped for
  │                          Gmail — a company MAY want one employee's number, or a shared one)
  │
  └── Lead                    companyId, source (WHATSAPP/REAL_ESTATE/... — enum, extensible),
                              phone, name?, email?, status (NEW/QUALIFIED/HOT/NURTURE/DISQUALIFIED/
                              CONVERTED), qualificationData (Json — budget/timeline/need, free-form per
                              source), conversationId? (FK to existing Conversation), assignedToUserId?
                              (sales rep), createdAt, lastContactedAt
      └── Conversation.leadId?  (FK added to the EXISTING Conversation model — nullable, so an
                                 internal-user chat and an external-lead chat share the same table;
                                 Message.role already has no User FK today, so no schema conflict)
```

**Why `Lead` is shared, not `WhatsAppLead`:** confirmed with the product owner — Real Estate Lead Agent
(the next product in the proposal's roadmap) needs an identical concept (external contact, qualification
status, conversation history). Building one entity now that both features share avoids a rename/migration
later. `source` discriminates without needing separate tables; `qualificationData` stays a free-form Json
bag exactly like `ScheduledPost.mediaRefs` does elsewhere in this codebase, since qualification fields
genuinely differ per source (WhatsApp: budget/timeline; Real Estate: budget/location/property-type).

**Conversation model fit:** verified `Conversation` (`schema.prisma:742`) has no `userId` FK today — it's
already `companyId + employeeId + title`, and `Message.role` is an enum, not a User relation. Adding a
nullable `leadId` is additive, not a redesign; an internal-user conversation simply leaves it null.

## 4. Backend module: `modules/engines/whatsapp/`

Mirrors `modules/engines/support/` (Chatwoot) file-for-file:

- **`TwilioWhatsappClientService`** (extends `ResilientClientBase`, per-company resource key —
  `engine:whatsapp:${companyId}`, the Chatwoot shape, not Postiz's single global key) — thin typed
  wrapper around Twilio's WhatsApp messaging API (send message, send template, fetch conversation).
- **`WhatsappEngineAdapter implements EngineAdapter`** — `connect()` (Twilio account-SID/token entry,
  not OAuth — Twilio issues API credentials directly, no browser redirect needed), `healthCheck()`,
  `capabilities()`, `tools()`.
- **`whatsapp-webhook.controller.ts`** — public inbound ingress for Twilio's message-received webhook.
  **Non-negotiable ordering** (the exact lesson `support-webhook.controller.ts`'s own doc comment
  states was learned the hard way from Postiz's webhook shipping unauthenticated and needing a
  final-review fix): **Twilio signature verification (`X-Twilio-Signature` HMAC) must complete
  successfully BEFORE any `Lead`/`Conversation`/`Message` row is read or written**, and any failure
  returns 401 without touching those tables. Feeds verified events into the existing
  `CanonicalIngestService` (RawEvent → dedup → CanonicalEvent → `fireEvent`), the same pipeline Gmail/
  GitHub already use — no new event-ingestion mechanism.
- **`whatsapp.constants.ts`** — env var names, resource-key helper, matching `support.constants.ts`'s
  shape.

## 5. Skill catalog: new `whatsapp` skill

Tools (JSON-schema shape, same as every other skill's `tools[]`):

- **`whatsapp.send_message(leadId, content)`** — free-form reply. **Must check the 24-hour customer
  service window before sending** (WhatsApp platform rule, not an Orlixa approval gate): if the lead's
  last inbound message is older than 24 hours, this tool returns `{ ok: false, error: 'outside 24h
  window, use send_template' }` rather than attempting a send Twilio would reject. This is a hard
  platform constraint the tool itself must enforce, the same way `postiz.publish_now` enforces its own
  idempotency window — not something a workflow APPROVAL node can route around.
- **`whatsapp.send_template(leadId, templateId, params)`** — pre-approved template message, the only
  way to contact a lead outside the 24-hour window. Template approval itself happens in Twilio/Meta's
  console, outside Orlixa (out of scope for this design — implementation must consult
  `twilio-content-template-builder` for the actual template-registration flow).
- **`whatsapp.get_conversation(leadId)`** — read-only, full message history for a Lead.

## 6. Workflow template: `sales.whatsapp-lead-qualify`

Follows the frozen-17 vocab (AI_EMPLOYEE_STEP + TOOL_ACTION only — the same constraint the 22 existing
HR/Marketing templates are locked to by `workflow-templates.catalog.spec.ts`):

```
EVENT trigger (WhatsApp inbound message → CanonicalEvent, via §4's webhook pipeline)
  → AI_EMPLOYEE_STEP (qualify: ask budget/need/timeline — disableTools:true, "recommends only",
     the exact M1-defect-avoidance pattern Marketing's AI_EMPLOYEE_STEP already uses so the reasoning
     step itself can never take an autonomous action)
  → CONDITION (qualification score meets hot-lead threshold?)
     → TRUE:  TOOL_ACTION (NOTIFY sales team — real delivery, not the old log-only stub) +
               Lead.status → QUALIFIED
     → FALSE: TOOL_ACTION (whatsapp.send_template — nurture follow-up) or terminate
```

Registered in the existing `workflow-templates.catalog.ts` aggregator alongside `hr-workflow-templates`
and `marketing-workflow-templates` — no new catalog mechanism.

## 7. Frontend

New route group `apps/web/src/app/(app)/sales/` (or nested under an existing area — implementer's call
at plan time, following whatever the current sidebar IA suggests), mirrored `features/sales/`
(`api.ts`/`hooks.ts`/`schemas.ts`/`components/`) shape, matching every existing feature:

- **Leads** — list/detail, qualification status, conversation view.
- **WhatsApp Accounts** — connect/disconnect per company or per employee (API-key-style form, no OAuth
  popup needed).
- Reuses the existing `/approvals` and chat surfaces wherever the workflow pauses — no new UI pattern
  needed beyond the Leads screens themselves.

## 8. Security

- Twilio webhook signature verification before any DB touch (§4) — the Chatwoot/Postiz lesson applied
  up front, not discovered at final review this time.
- `WhatsAppAccount`/`Lead` tables `companyId`-scoped per the existing manual-filtering convention — no
  new tenancy mechanism.
- Credentials encrypted via the existing `CryptoService` (AES-GCM, `v1:` envelope) — no new crypto.
- Twilio compliance (A2P 10DLC / WhatsApp Business verification, consent/opt-in rules, template
  approval) is a real, non-optional prerequisite before any real number can send messages — implementation
  must work through `twilio-compliance-onboarding` and `twilio-whatsapp-manage-senders` skills as part of
  the connect flow design, not bolt it on after.

## 9. What this design deliberately does NOT cover (defer to implementation planning)

- Exact Twilio API request/response shapes (per-skill lookup at implementation time, not frozen here —
  Twilio's API can change and this document shouldn't go stale the way an earlier draft of
  `postiz-integration-plan.md` did on a similar point).
- Exact qualification-scoring logic inside the AI_EMPLOYEE_STEP (a prompt/criteria design question, not
  an architecture question).
- Multi-employee routing (e.g. round-robin hot leads across a sales team) — first version: NOTIFY the
  team, human picks it up manually, matching how Marketing's approval-needed alerts already work.
