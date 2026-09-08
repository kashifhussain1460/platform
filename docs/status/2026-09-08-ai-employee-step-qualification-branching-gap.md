# AI_EMPLOYEE_STEP qualification branching + template auto-trigger — known gap

**Found:** 2026-09-08, during the final whole-branch review of the Real Estate Lead Agent plan
(`docs/plans/2026-09-08-real-estate-lead-agent-implementation-plan.md`). Not introduced by that
plan — pre-existing, and equally affects the already-merged WhatsApp Sales Agent
(`sales.whatsapp-lead-qualify`). Real Estate was merged anyway (product owner decision,
2026-09-08) because its 5 tasks are individually correct and match the already-shipped WhatsApp
template's exact pattern — fixing this is separate, cross-cutting platform work, not a defect in
either template's own code.

## Bug 1 — `AI_EMPLOYEE_STEP` output never reaches `CONDITION` as structured data

`AiEmployeeStepNodeHandler.execute` returns `contextValue: text` — the raw LLM reply string
(`apps/api/src/modules/employees/runtime/ai-employee-step.handler.ts:212`). The engine binds that
verbatim to `context[outputKey]` with no JSON parsing
(`apps/api/src/modules/workflows/engine/workflow-engine.service.ts:791-792`). `template.ts`'s
`lookup()` bails to `undefined` the moment it hits a non-object in the path
(`apps/api/src/modules/workflows/engine/template.ts:19-20`).

Net effect: `{{qualification.hot}}` (`sales.whatsapp-lead-qualify`) and
`{{qualification.interested}}` / `{{qualification.preferredTime}}`
(`realestate.whatsapp-lead-qualify`) always resolve to an empty string, regardless of what JSON
the AI Employee actually writes in its reply. Every `CONDITION` node gated on an
`AI_EMPLOYEE_STEP`'s output always takes the "false" branch. In both templates this means the
entire "hot lead" / "interested + booked visit" path — including `leads.record_site_visit` — is
dead code in a real run; only the nurture fallback ever fires.

**Why CI/e2e didn't catch it:** the e2e suites run with `LLM_PROVIDER=mock` and never drive an
actual workflow run through a real `AI_EMPLOYEE_STEP → CONDITION` chain with model output: the
per-task tests exercise `leads.record_site_visit` directly via the `SKILL_EXECUTOR_TOKEN`, and the
template's own `validateManifest`/trigger-data-resolution tests check the graph and templating
mechanics against a hand-constructed `context.qualification` OBJECT (not the real string shape
`AI_EMPLOYEE_STEP` actually produces) — so nothing in the current test suite exercises the real
`text → context[outputKey] → lookup()` path end to end.

## Bug 2 — installed templates default to `MANUAL`, never auto-fire on `NEW_LEAD`

`WorkflowTemplateManifest` carries no trigger wiring into the install path — nothing in
`apps/api/src/modules/workflow-templates` ever sets `Workflow.triggerType`, so it keeps the Prisma
default (`schema.prisma:914`, `@default(MANUAL)`). A company installing either
`sales.whatsapp-lead-qualify` or `realestate.whatsapp-lead-qualify` gets a workflow that must be
run by hand — it does not react to an inbound WhatsApp message on its own, contradicting both
templates' entire premise ("fires on the shared `NEW_LEAD` canonical event").

## Scope of the fix (not done here — needs its own plan)

Both fixes are core engine changes shared by every `AI_EMPLOYEE_STEP`-based template in the
platform (24 first-party templates across HR/Marketing/Sales), not something scoped to one
template's manifest:

- Bug 1 needs a design decision: should `AI_EMPLOYEE_STEP` attempt to JSON-parse a reply that
  looks like JSON and bind the parsed object (with the raw string kept under a secondary key for
  templates that want the prose), or should there be an explicit "structured output" node config
  that changes how the runtime prompts and what it binds? Either affects every workflow author's
  mental model of what `{{outputKey.field}}` means.
- Bug 2 needs the install path to read the manifest's own `TRIGGER` node config (event type,
  conditions) and translate it into `Workflow.triggerType`/`triggerConfig` at install time, then
  presumably activate it — a change to `POST /workflow-templates/:id/install`, not the templates
  themselves.

**Recommendation:** scope a dedicated plan for this before relying on ANY qualification-branching
workflow template (Sales or Real Estate) in a real customer demo or production use — until then,
both templates function as "always nurture, always manual-run," not as advertised.
