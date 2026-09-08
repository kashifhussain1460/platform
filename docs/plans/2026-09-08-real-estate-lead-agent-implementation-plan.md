# Real Estate Lead Agent Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add Real Estate lead qualification on top of the already-shipped WhatsApp Sales Agent — a new
`leads` skill (one tool, `record_site_visit`) and a new `realestate.whatsapp-lead-qualify` workflow
template. No new connector, no schema migration.

**Architecture:** Reuses the WhatsApp engine's webhook/Lead-creation pipeline as-is. The workflow
template runs `calendar.create_event` (already real) as its own TOOL_ACTION so it gets Calendar's own
OAuth credentials through the normal per-skillKey resolution path, then a new, credential-free
`leads.record_site_visit` tool links the resulting event to the `Lead` row. Status transitions reuse the
existing, already channel-agnostic `whatsapp.update_lead_status` tool.

**Tech Stack:** NestJS/Prisma (`apps/api`), the existing skill-catalog/`RealSkillExecutor`/
workflow-template infrastructure — no new dependencies.

**Spec:** `docs/plans/2026-09-08-real-estate-lead-agent-design.md` (read it first — §4 explains the
credential-mixing bug this plan's Task 2 design corrects for, and why `record_site_visit` never calls
the Calendar API itself).

## Global Constraints

- Frozen-17 node vocabulary only (AI_EMPLOYEE_STEP + TOOL_ACTION + CONDITION + TRIGGER + TERMINATE) — no
  APPROVAL, no LOOP.
- `AI_EMPLOYEE_STEP` nodes run with `disableTools: true` unconditionally (enforced in
  `ai-employee-step.handler.ts`, not a per-template setting) — "recommends only."
- EVENT-triggered workflow trigger-data paths are `{{trigger.data.*}}`, never the flat `{{trigger.*}}`
  form (confirmed real, `sales-workflow-templates.catalog.ts`'s own doc comment; the flat form was a
  real bug fixed in the WhatsApp plan's final review).
- `CONDITION` node `op` is one of `eq | neq | contains | gt | lt` (verified against
  `node-handler.ts`'s `compare()`) — there is no `exists` operator.
- `leads.record_site_visit` must never call an external API itself (see Architecture above) — it only
  reads/writes the `Lead` row.
- TypeScript strict, no `any`, no disabled lint rules.

---

### Task 1: `leads` skill catalog entry

**Files:**
- Modify: `apps/api/src/modules/skills/catalog.ts`

**Interfaces:**
- Produces: a new catalog entry `key: 'leads'` with one tool, `record_site_visit` — its name combines
  with the `leads` key to form `leads.record_site_visit`, the exact string Task 2's `RealSkillExecutor`
  switch case and Task 3's `REAL_EXECUTION_TOOLS` entry must match.

- [ ] **Step 1: Add the catalog entry**

Add to the exported catalog array in `apps/api/src/modules/skills/catalog.ts`. `connection: { type: 'none' }`
is a real, already-used value in this file (confirmed at 3 existing entries, e.g. the `scheduling` skill's
comment: "provisioned once per company... not per-employee OAuth") — use it here, since this tool needs
no external credentials at all:

```typescript
{
  key: 'leads',
  name: 'Leads',
  description: 'Record actions taken on a Lead (e.g. a scheduled site visit) — channel-agnostic, works for any Lead regardless of how it arrived.',
  category: 'crm',
  connection: { type: 'none' },
  configSchema: [],
  tools: [
    {
      name: 'record_site_visit',
      description: 'Link an already-scheduled calendar event to a Lead as its site visit. Does not create the calendar event itself — call calendar.create_event first and pass its returned id here.',
      parameters: {
        type: 'object',
        properties: {
          leadId: { type: 'string', description: 'The Lead id.' },
          eventId: { type: 'string', description: 'The calendar event id returned by calendar.create_event.' },
          start: { type: 'string', description: 'ISO start datetime of the visit (for display on the Leads screen).' },
        },
        required: ['leadId', 'eventId', 'start'],
      },
    },
  ],
},
```

- [ ] **Step 2: Verify the catalog is still valid**

Run: `npx jest --config ./test/jest-unit.json capabilities` (from `apps/api` — the same catalog-validation
spec Task 9 of the WhatsApp plan used; find its exact filename with
`find apps/api/src/modules/skills -iname "*catalog*spec*" -o -iname "capabilities.spec.ts"` if this
doesn't match)
Expected: PASS — no duplicate `key`, no malformed `parameters` schema.

- [ ] **Step 3: Commit**

```bash
git add apps/api/src/modules/skills/catalog.ts
git commit -m "feat(real-estate): add leads skill (record_site_visit tool)"
```

---

### Task 2: `RealSkillExecutor` — wire `leads.record_site_visit`

**Files:**
- Modify: `apps/api/src/modules/skills/executors/real-skill-executor.ts`
- Modify: `apps/api/src/modules/skills/executors/real-skill-executor.spec.ts`

**Interfaces:**
- Consumes: `PrismaService` (already a constructor dependency — no new dependency needed, this tool only
  touches `prisma.lead`).
- Produces: `case 'leads.record_site_visit'` in the executor's switch — consumed by Task 4's workflow
  template's TOOL_ACTION node.

- [ ] **Step 1: Write the failing tests**

Add to `real-skill-executor.spec.ts`, following the exact setup pattern the existing
`describe('whatsapp.send_message', ...)` blocks use:

```typescript
describe('RealSkillExecutor — leads.*', () => {
  describe('leads.record_site_visit', () => {
    it('merges the site-visit fields into the Lead\'s existing qualificationData', async () => {
      const prisma = {
        lead: {
          findFirst: jest.fn().mockResolvedValue({
            id: 'lead_1',
            companyId: 'c_1',
            qualificationData: { budget: '500k-700k' },
          }),
          update: jest.fn().mockResolvedValue({}),
        },
      };
      const executor = new RealSkillExecutor(
        configMock, fallbackMock, schedulingMock, {} as any, prisma as any,
        chatwootClientMock, cryptoMock, planeClientMock, idempotencyMock,
        suppressionMock, false, {} as any,
      );

      const result = await executor.execute(
        'leads', 'record_site_visit',
        { leadId: 'lead_1', eventId: 'evt_abc', start: '2026-09-15T10:00:00.000Z' },
        ctx,
      );

      expect(result.ok).toBe(true);
      expect(prisma.lead.update).toHaveBeenCalledWith({
        where: { id: 'lead_1' },
        data: {
          qualificationData: {
            budget: '500k-700k',
            siteVisitAt: '2026-09-15T10:00:00.000Z',
            siteVisitEventId: 'evt_abc',
          },
        },
      });
    });

    it('fails without writing when the lead is not found for this company', async () => {
      const prisma = { lead: { findFirst: jest.fn().mockResolvedValue(null), update: jest.fn() } };
      const executor = new RealSkillExecutor(
        configMock, fallbackMock, schedulingMock, {} as any, prisma as any,
        chatwootClientMock, cryptoMock, planeClientMock, idempotencyMock,
        suppressionMock, false, {} as any,
      );

      const result = await executor.execute(
        'leads', 'record_site_visit',
        { leadId: 'lead_other_company', eventId: 'evt_abc', start: '2026-09-15T10:00:00.000Z' },
        ctx,
      );

      expect(result).toEqual({ ok: false, error: expect.any(String) });
      expect(prisma.lead.update).not.toHaveBeenCalled();
      expect(prisma.lead.findFirst).toHaveBeenCalledWith({
        where: { id: 'lead_other_company', companyId: 'c_1' },
      });
    });
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx jest --config ./test/jest-unit.json real-skill-executor.spec.ts -t "leads.record_site_visit"`
(from `apps/api`)
Expected: FAIL — `case 'leads.record_site_visit'` does not exist, falls through to the mock/error path.

- [ ] **Step 3: Add the switch case and implementation**

Add to the tool switch (alongside the existing `case 'whatsapp.update_lead_status'`):

```typescript
        case 'leads.record_site_visit':
          return await this.leadsRecordSiteVisit(args, ctx);
```

Add the private method (near `whatsappUpdateLeadStatus`):

```typescript
  // --- leads.* (channel-agnostic Lead actions; no external credentials) ---

  private async leadsRecordSiteVisit(
    args: Record<string, unknown>,
    ctx: ExecutorContext,
  ): Promise<SkillExecutionResult> {
    const leadId = str(args.leadId);
    const eventId = str(args.eventId);
    const start = str(args.start);
    if (!leadId || !eventId || !start) {
      return { ok: false, error: 'record_site_visit requires leadId, eventId and start' };
    }
    const lead = await this.prisma.lead.findFirst({
      where: { id: leadId, companyId: ctx.companyId },
    });
    if (!lead) return { ok: false, error: 'Lead not found for this company' };

    // Merge, not overwrite — qualificationData is a free-form bag other steps
    // may already have written to (e.g. budget/location captured during
    // qualification); a plain `data: { qualificationData: {...} }` would
    // silently drop those fields, the same class of bug this codebase's own
    // JSON-column conventions elsewhere are careful to avoid.
    const existing = (lead.qualificationData as Record<string, unknown> | null) ?? {};
    await this.prisma.lead.update({
      where: { id: lead.id },
      data: {
        qualificationData: { ...existing, siteVisitAt: start, siteVisitEventId: eventId },
      },
    });
    return { ok: true, result: { leadId, eventId, start } };
  }
```

**Note for the implementer:** the test's constructor call adds a 12th argument (`{} as any`) for
whatever the constructor's final parameter is (the `TwilioWhatsappClientService` from the WhatsApp
plan) — this task does not touch the constructor signature itself, only reuses it. If the actual current
constructor parameter count/order differs from what's shown here (check the file directly first), adjust
the test's call to match — do not guess.

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx jest --config ./test/jest-unit.json real-skill-executor.spec.ts -v`
Expected: PASS, including every pre-existing test in this file (your addition must not break any of
them).

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/modules/skills/executors/real-skill-executor.ts apps/api/src/modules/skills/executors/real-skill-executor.spec.ts
git commit -m "feat(real-estate): wire leads.record_site_visit into RealSkillExecutor"
```

---

### Task 3: Register `leads.record_site_visit` as a real (not simulated) tool

**Files:**
- Modify: `apps/api/src/modules/skills/executors/real-execution-support.ts`
- Modify: `apps/api/src/modules/skills/executors/real-execution-support.spec.ts` (if it hardcodes any
  per-skill list that would now be wrong — check first, following the exact same pattern the WhatsApp
  plan's final review found and fixed for the `whatsapp` skill)

**Interfaces:**
- Consumes: nothing new.
- Produces: `isRealExecutionSupported('leads', 'record_site_visit') === true` — consumed by the
  `/skills` catalog UI (so it does NOT show "Demo only" for this real tool) and
  `SkillsService.assertNotSimulatedInProduction`.

- [ ] **Step 1: Add the entry**

In `REAL_EXECUTION_TOOLS` (`real-execution-support.ts`), add:

```
'leads.record_site_visit',
```

- [ ] **Step 2: Check the spec file for a stale "these skills are simulated" list**

Read `real-execution-support.spec.ts` in full. If it has a hardcoded list of skill keys asserted to have
`skillsWithNoRealExecution`/be SIMULATED (the WhatsApp plan's final review found and fixed exactly this
kind of drift for the `whatsapp` skill — grep for any occurrence of `'leads'` or a full skill-key list),
update it to reflect that `leads` now has real execution. If no such list exists yet for `leads` (it's a
brand-new skill key, so it may not be hardcoded anywhere), this step may be a no-op — confirm by running
the tests in Step 3 rather than assuming.

- [ ] **Step 3: Run tests**

Run: `npx jest --config ./test/jest-unit.json real-execution-support.spec.ts -v` (from `apps/api`)
Expected: PASS — the file's own drift-guard tests (every `REAL_EXECUTION_TOOLS` entry has a matching
`case` in `real-skill-executor.ts`, and vice versa) must hold for the new entry.

- [ ] **Step 4: Commit**

```bash
git add apps/api/src/modules/skills/executors/real-execution-support.ts apps/api/src/modules/skills/executors/real-execution-support.spec.ts
git commit -m "feat(real-estate): register leads.record_site_visit as a real (non-simulated) tool"
```

---

### Task 4: Workflow template — `realestate.whatsapp-lead-qualify`

**Files:**
- Modify: `apps/api/src/modules/workflow-templates/sales-workflow-templates.catalog.ts` (add a second
  manifest to the existing `SALES_WORKFLOW_TEMPLATES` array — this file already holds the Sales domain's
  templates, following the same one-file-per-domain pattern as `hr-workflow-templates.catalog.ts`)
- Modify: `apps/api/src/modules/workflow-templates/workflow-templates.catalog.spec.ts` (the boot-seed
  count assertion will need updating — the WhatsApp plan's own Task 11 found and fixed a stale hardcoded
  count exactly like this; check for one here too rather than assuming it's fine)

**Interfaces:**
- Consumes: `leads.record_site_visit` (Task 2/3), `whatsapp.update_lead_status` (already exists),
  `calendar.create_event` (already exists, real).
- Produces: `realestate.whatsapp-lead-qualify`, registered in the boot-seeded aggregator (no separate
  aggregator change needed — `SALES_WORKFLOW_TEMPLATES` is already spread into
  `workflow-templates.catalog.ts`'s aggregated array from the WhatsApp plan).

- [ ] **Step 1: Add the template manifest**

Add to the `SALES_WORKFLOW_TEMPLATES` array in `sales-workflow-templates.catalog.ts`, after the existing
`sales.whatsapp-lead-qualify` entry:

```typescript
  {
    key: 'realestate.whatsapp-lead-qualify',
    version: 1,
    name: 'Real Estate: WhatsApp lead qualification',
    description:
      'A Sales AI Employee qualifies an inbound WhatsApp property enquiry (budget/location/property-type). If interested and a preferred visit time was given, it books the site visit and notifies the agent; if interested with no time given, it asks for one; otherwise it sends a nurture follow-up.',
    category: 'SALES',
    parameters: [
      { key: 'salesEmployee', label: 'Sales AI Employee', type: 'string', required: true, binds: 'employee', help: 'AI Employee (role SALES) that qualifies the lead.' },
      { key: 'nurtureTemplateId', label: 'Nurture template (Twilio Content SID)', type: 'string', required: true, help: 'Pre-approved WhatsApp template to send a lead that is not yet hot.' },
      { key: 'askTimeTemplateId', label: 'Ask-for-a-time template (Twilio Content SID)', type: 'string', required: true, help: 'Pre-approved WhatsApp template asking an interested lead for their preferred site-visit day/time.' },
      { key: 'defaultVisitDurationMinutes', label: 'Default visit duration (minutes)', type: 'number', required: true, help: 'How long to block on the calendar for a site visit, e.g. 45.' },
    ],
    requires: { skills: ['whatsapp', 'calendar', 'leads', 'slack'], employeeRoles: ['SALES'], minPlan: 'BUSINESS' },
    definition: {
      nodes: [
        { id: 'trigger', type: 'TRIGGER', name: 'New WhatsApp property enquiry', config: {} },
        { id: 'qualify', type: 'AI_EMPLOYEE_STEP', name: 'Qualify the enquiry', config: { employeeId: '{{param.salesEmployee}}', instruction: 'A new WhatsApp property enquiry: "{{trigger.data.body}}". Assess budget, preferred location and property type from this message. If the message also states a preferred site-visit day/time, extract it as a plain ISO-ish string (e.g. "2026-09-15T10:00:00"); if none was stated, use an empty string. Output a JSON object {"interested": true|false, "reason": string, "preferredTime": string}.', outputKey: 'qualification' } },
        { id: 'isInterested', type: 'CONDITION', name: 'Interested?', config: { left: '{{qualification.interested}}', op: 'eq', right: 'true' } },
        { id: 'hasTime', type: 'CONDITION', name: 'Preferred time given?', config: { left: '{{qualification.preferredTime}}', op: 'neq', right: '' } },
        { id: 'bookVisit', type: 'TOOL_ACTION', name: 'Book the site visit', config: { skillKey: 'calendar', tool: 'create_event', args: { title: 'Property site visit — {{trigger.data.phone}}', start: '{{qualification.preferredTime}}' }, outputKey: 'visitEvent' } },
        { id: 'recordVisit', type: 'TOOL_ACTION', name: 'Link the visit to the lead', config: { skillKey: 'leads', tool: 'record_site_visit', args: { leadId: '{{trigger.data.leadId}}', eventId: '{{visitEvent.result.id}}', start: '{{qualification.preferredTime}}' } } },
        { id: 'markQualifiedWithVisit', type: 'TOOL_ACTION', name: 'Mark the lead qualified', config: { skillKey: 'whatsapp', tool: 'update_lead_status', args: { leadId: '{{trigger.data.leadId}}', status: 'QUALIFIED' } } },
        { id: 'notifyAgentVisit', type: 'TOOL_ACTION', name: 'Notify the agent — visit booked', config: { skillKey: 'slack', tool: 'send_message', args: { channel: 'sales', text: 'Site visit booked for {{trigger.data.phone}}: {{qualification.reason}}' } } },
        { id: 'askTime', type: 'TOOL_ACTION', name: 'Ask for a preferred time', config: { skillKey: 'whatsapp', tool: 'send_template', args: { leadId: '{{trigger.data.leadId}}', templateId: '{{param.askTimeTemplateId}}' } } },
        { id: 'notifyAgentFollowUp', type: 'TOOL_ACTION', name: 'Notify the agent — follow up', config: { skillKey: 'slack', tool: 'send_message', args: { channel: 'sales', text: 'Interested lead, no time yet: {{trigger.data.phone}} — {{qualification.reason}}' } } },
        { id: 'nurture', type: 'TOOL_ACTION', name: 'Send nurture follow-up', config: { skillKey: 'whatsapp', tool: 'send_template', args: { leadId: '{{trigger.data.leadId}}', templateId: '{{param.nurtureTemplateId}}' } } },
        { id: 'doneVisit', type: 'TERMINATE', name: 'Visit booked', config: { status: 'COMPLETED', reason: 'Site visit booked and agent notified.' } },
        { id: 'doneAskTime', type: 'TERMINATE', name: 'Asked for a time', config: { status: 'COMPLETED', reason: 'Asked the lead for a preferred visit time; agent notified to follow up.' } },
        { id: 'doneNurture', type: 'TERMINATE', name: 'Nurture sent', config: { status: 'COMPLETED', reason: 'Nurture follow-up sent.' } },
      ],
      edges: [
        { from: 'trigger', to: 'qualify' },
        { from: 'qualify', to: 'isInterested' },
        { from: 'isInterested', to: 'hasTime', branch: 'true' },
        { from: 'isInterested', to: 'nurture', branch: 'false' },
        { from: 'hasTime', to: 'bookVisit', branch: 'true' },
        { from: 'hasTime', to: 'askTime', branch: 'false' },
        { from: 'bookVisit', to: 'recordVisit' },
        { from: 'recordVisit', to: 'markQualifiedWithVisit' },
        { from: 'markQualifiedWithVisit', to: 'notifyAgentVisit' },
        { from: 'notifyAgentVisit', to: 'doneVisit' },
        { from: 'askTime', to: 'notifyAgentFollowUp' },
        { from: 'notifyAgentFollowUp', to: 'doneAskTime' },
        { from: 'nurture', to: 'doneNurture' },
      ],
    },
  },
```

**Note on `defaultVisitDurationMinutes`:** this parameter is declared but `calendar.create_event`'s
`args` above only pass `start`, not `end` — the real executor already defaults a missing `end` to
"30 minutes after start" (`real-skill-executor.ts`'s `calendarCreateEvent`, confirmed during this plan's
research). If a configurable duration is wanted instead of that 30-minute default, compute
`end: '{{...}}'` from `preferredTime` + the parameter — but template expressions in this engine are a
`{{a.b.c}}` resolver with no arithmetic (confirmed: "no eval" per the workflow builder's own docs), so
duration math cannot happen in the template string itself. **Decide and implement one of:** (a) accept
the real executor's fixed 30-minute default and drop the unused `defaultVisitDurationMinutes` parameter
from this template (simplest, matches YAGNI), or (b) keep the parameter and compute `end` inside a
change to `calendarCreateEvent` itself (a bigger, cross-cutting change to a tool other templates also
use — do not do this without flagging it for review first). Recommend (a) unless the reviewer disagrees;
implement whichever is chosen and remove the other option's leftover parameter/config if not used.

- [ ] **Step 2: Check for a stale template-count assertion**

Read `workflow-templates.catalog.spec.ts`. If it asserts an exact total count of registered templates
(the WhatsApp plan's Task 11 found and fixed exactly this — a hardcoded `toHaveLength(N)` that breaks
whenever a template is added), update the count and add/extend a per-domain assertion for `SALES`
(there should already be one from the WhatsApp plan asserting `SALES_WORKFLOW_TEMPLATES` has length 1 —
update it to 2, following whatever assertion style is already there for `HR`/`MARKETING`).

- [ ] **Step 3: Run the boot-seed validation test**

Run: `npx jest --config ./test/jest-unit.json workflow-templates.catalog.spec.ts -v` (from `apps/api`)
Expected: PASS — `validateManifest` accepts `realestate.whatsapp-lead-qualify` (frozen-17 vocab, no
`DB_QUERY`, no inline secrets, no `APPROVAL` inside a `LOOP` — none of which this template has).

- [ ] **Step 4: Add a trigger-data resolution test**

Following the exact pattern the WhatsApp plan's final-review fix added for `sales.whatsapp-lead-qualify`
(a `resolveTemplate`-against-real-payload test proving `{{trigger.data.*}}` actually resolves, not just
that the manifest validates structurally) — add an equivalent block for
`realestate.whatsapp-lead-qualify` in `workflow-templates.catalog.spec.ts`: resolve the template against
a realistic canonical-event payload (`{ data: { phone: '+15550002222', body: '...', leadId: 'lead_1' } }`)
and a plausible `qualification`/`visitEvent` context object, and assert the qualify instruction and the
`bookVisit`/`recordVisit`/`notifyAgentVisit` node args all resolve to real values with no unresolved
`{{` left anywhere in the definition.

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/modules/workflow-templates/sales-workflow-templates.catalog.ts apps/api/src/modules/workflow-templates/workflow-templates.catalog.spec.ts
git commit -m "feat(real-estate): add realestate.whatsapp-lead-qualify workflow template"
```

---

### Task 5: Verify the full loop against the live pipeline

**Files:**
- Modify: `apps/api/test/whatsapp-lead-pipeline.e2e-spec.ts` (extend, do not replace — this suite already
  proves webhook → Lead → `/leads` works; this task adds one focused case proving a Real-Estate-flavored
  qualificationData round-trip through `GET /leads/:id`)

**Interfaces:**
- Consumes: everything from Tasks 1-4, plus the existing e2e infrastructure from the WhatsApp plan
  (`describeIfDb`, the signed-webhook-request helper already in this file).

- [ ] **Step 1: Add one new e2e case**

Read the existing file first to match its exact helper functions (the signed-POST helper, the
`GET /leads/:id` assertion shape) rather than reinventing them. Add a test that:
1. Sends one signed inbound WhatsApp delivery (reusing the existing helper) to create a `Lead`.
2. Directly calls `leads.record_site_visit` through the same `SKILL_EXECUTOR_TOKEN`-resolved executor
   pattern Task 5/6 of the WhatsApp plan's own live-idempotency test used (`app.get<SkillExecutor>
   (SKILL_EXECUTOR_TOKEN)`, then `.execute('leads', 'record_site_visit', {...}, { companyId })`) —
   this is the deterministic, non-LLM way to exercise the tool without needing a full AI-qualification
   run.
3. Asserts `GET /leads/:id` now returns `qualificationData.siteVisitAt`/`siteVisitEventId` matching what
   was recorded, alongside the conversation/messages the base pipeline test already proves.

- [ ] **Step 2: Run it**

Run (from `apps/api`, with a local Postgres/Redis available per `platform/CLAUDE.md`'s "Run locally"
section):
```
LLM_PROVIDER=mock EMBEDDINGS_PROVIDER=hash STORAGE_PROVIDER=local SKILL_EXECUTOR=mock BILLING_PROVIDER=mock ENCRYPTION_KEY=<64 hex> WORKFLOW_ENGINE_MODE=state_machine npx jest --config ./test/jest-e2e.json whatsapp-lead-pipeline --forceExit
```
Expected: all cases in the file pass, including the new one.

- [ ] **Step 3: Commit**

```bash
git add apps/api/test/whatsapp-lead-pipeline.e2e-spec.ts
git commit -m "test(real-estate): verify site-visit recording through the live pipeline"
```

## Self-review notes (spec coverage)

- Spec §1 (WhatsApp intake reuse) → no task needed, nothing to build (confirmed by the whole plan
  touching zero files under `modules/engines/whatsapp/`).
- Spec §2 (`Lead.phone` stays `NOT NULL`, no migration) → confirmed by this plan having no migration
  task.
- Spec §3 (`LeadStatus` unchanged) → confirmed by Task 2 writing to `qualificationData`, not a new enum
  value.
- Spec §4 (`leads` skill + corrected `record_site_visit` design) → Tasks 1, 2, 3.
- Spec §5 (workflow template) → Task 4.
- Spec §6 (explicitly out of scope: HubSpot, multi-vertical, property inventory) → no task, correctly
  absent.
- One open implementation decision flagged inline rather than guessed at (Task 4's
  `defaultVisitDurationMinutes` parameter vs. the template engine's no-arithmetic constraint) — the
  recommended resolution is stated, but the actual call is left to whoever implements Task 4, with the
  reasoning needed to make it.
