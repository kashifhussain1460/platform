# Verify-03 — AI Assist trigger wiring + AI Assist credit metering

Read-only verification pass, 2026-09-09. Nothing was modified. Every claim below was re-derived from the
files named; the two prior findings
(`07-ai-assist-and-agent-architecture.md` §A.2 Q2 / Top-5 #1 and `10-billing-credits-and-integrations.md` §A.6)
were treated as hypotheses.

**Verdict up front: both prior findings are CONFIRMED, exactly as written.** Two corrections/additions worth
having before planning:

1. Gap A is *smaller than it looks* on the write side (`PATCH /workflows/:id` already accepts and validates
   both trigger fields, and `TriggerConfig` is a tiny 5-key shape) but *bigger than stated* on the readiness
   side — see §A.4.2: readiness cannot detect the fallback at all today, because a workflow that was never
   *given* a trigger is byte-identical to one the user deliberately wants manual.
2. Gap B needs **no migration**. `CreditLedger.conversationId` / `CreditReservation.conversationId` are plain
   `String?` columns with **no foreign key and no back-relation** (§B.3) — but overloading them is the wrong
   call, and there is a cleaner no-migration option. Recommendation in §B.3.

---

# GAP A — AI Assist never wires the trigger the user asked for

## A.1 `AssistService.accept()` — exact current shape

`apps/api/src/modules/assist/assist.service.ts:134-191` (method body `:138-191`).

```ts
  /**
   * Turn the draft into a REAL workflow. The one place a conversation becomes
   * something that can run — deliberately explicit, human and role-gated.
   */
  async accept(
    companyId: string,
    user: AuthenticatedUser,
    id: string,
    dto: AcceptAssistSessionDto,
  ): Promise<WorkflowDto> {
    if (user.role !== 'OWNER' && user.role !== 'ADMIN') {
      throw new ForbiddenException(
        'Only owners and admins can create workflows',
      );
    }

    const session = await this.get(companyId, user, id);
    const definition = session.draftDefinition;
    if (!definition || definition.nodes.length === 0) {
      throw new NotFoundException(
        'This session has no workflow to create yet — describe what you want built first.',
      );
    }

    // Goes through the ORDINARY create path: same validation, same audit, same
    // ownership. There is no assist-specific bypass, so a workflow built by the
    // agent is indistinguishable from a hand-built one (doc 30 AD-30-10).
    const workflow = await this.workflows.create(
      companyId,
      {
        name: dto.name,
        description: dto.description,
        definition: definition as WorkflowDefinition,
      },
      user.userId,
    );

    await this.prisma.assistSession.update({
      where: { id },
      data: { createdWorkflowId: workflow.id, status: 'COMPLETED' },
    });
    // Provenance: answers "who built this and how" long after the chat is gone.
    await this.prisma.workflow.update({
      where: { id: workflow.id },
      data: { assistSessionId: id },
    });

    await this.auditLog.record({ /* action: 'assist.session.accept' */ });

    return workflow;
  }
```

Confirmed: the object handed to `create()` is exactly `{ name, description, definition }`
(`assist.service.ts:161-169`). No `triggerType`, no `triggerConfig`, no `category`. No `PATCH`/`update()` call
follows.

The request DTO also has nowhere to put a trigger — `AcceptAssistSessionDto`
(`apps/api/src/modules/assist/dto/assist.dto.ts:66-76`) is `{ name!: string; description?: string }` only.
The controller route is `apps/api/src/modules/assist/assist.controller.ts:165-174` (role gate is in the
service, not a decorator — deliberate, per the class doc at `assist.service.ts:44-50`).

## A.2 `WorkflowsService.create()` signature and `CreateWorkflowDto`

`apps/api/src/modules/workflows/workflows.service.ts:198-228`:

```ts
  async create(
    companyId: string,
    dto: CreateWorkflowDto,
    actorUserId?: string,
  ): Promise<WorkflowDto> {
    this.validateStorable(dto.definition);
    const workflow = await this.prisma.workflow.create({
      data: {
        companyId,
        name: dto.name,
        description: dto.description ?? null,
        definition: (dto.definition ?? STARTER_DEFINITION) as unknown as Prisma.InputJsonObject,
        ownerUserId: actorUserId ?? null,
        category: dto.category ?? null,
      },
    });
    …
    return toWorkflowDto(workflow);
  }
```

`create()` **never reads or writes `triggerType`/`triggerConfig`** — confirmed by reading the whole method.

### `CreateWorkflowDto` does NOT accept trigger fields

- Server class-validator DTO: `apps/api/src/modules/workflows/dto/create-workflow.dto.ts:15-37` —
  fields are exactly `name` (`@IsString @MinLength(1) @MaxLength(160)`), `description?`
  (`@IsOptional @IsString @MaxLength(2000)`), `definition?`
  (`@IsOptional @ValidateNested @Type(() => WorkflowDefinitionDto)`), `category?`
  (`@IsOptional @IsIn(WORKFLOW_CATEGORIES)`).
- Shared zod contract: `packages/types/src/index.ts:1953-1962` (`createWorkflowSchema`) — same four fields.

So **`create()` cannot be "just passed through"** without a change. Two things must change together
(the class-validator DTO **and** the zod schema in `@vaep/types`), plus the Prisma `data` block.

### What `PATCH /workflows/:id` accepts instead (the existing, working write surface)

`apps/api/src/modules/workflows/dto/update-workflow.dto.ts`:

| Field | Decorators | Line |
|---|---|---|
| `triggerType?: TriggerType` | `@IsOptional() @IsIn(TRIGGER_TYPES)` | `:107-109` |
| `triggerConfig?: TriggerConfigDto` | `@IsOptional() @ValidateNested() @Type(() => TriggerConfigDto)` | `:111-114` |

`TriggerConfigDto` (`:49-81`):

| Key | Decorators | Line |
|---|---|---|
| `everyMs?: number` | `@IsOptional() @IsInt() @Min(15000)` | `:50-53` |
| `cron?: string` | `@IsOptional() @IsString() @MaxLength(120)` | `:55-58` |
| `eventType?: string` | `@IsOptional() @IsString() @MaxLength(120)` | `:60-63` |
| `conditions?: ConditionDto[]` | `@IsOptional() @IsArray() @ArrayMaxSize(25) @ValidateNested({each:true}) @Type(() => ConditionDto)` | `:65-71` |
| `connectorId?: string` | `@IsOptional() @IsString() @MinLength(1)` | `:73-80` |

`ConditionDto` (`:35-46`): `path!: string` (`@IsString @MaxLength(200)`), `op!: EventConditionOp`
(`@IsIn(EVENT_CONDITION_OPS)`), `value?: unknown` (`@IsOptional() @Allow()` — `@Allow` is required so the
global `whitelist: true` ValidationPipe doesn't strip it).

`WorkflowsService.update()` (`workflows.service.ts:296-355`) then:
- validates the trigger shape whenever **either** field is present (`:317-323`), calling
  `this.validateTrigger(type, config)` with `type = dto.triggerType ?? existing.triggerType`;
- writes `triggerType: dto.triggerType` and `triggerConfig` (`undefined` → leave alone) at `:332-336`.

⚠️ **Schema drift to be aware of:** the shared zod `triggerConfigSchema`
(`packages/types/src/shared-schemas.ts:97-102`) has only `everyMs`/`cron`/`eventType`/`conditions` —
**`connectorId` is missing from the zod schema** but present in the server class-validator DTO. The PATCH body
is validated by class-validator, so `connectorId` works over HTTP today; any new code path that validates a
trigger config with the *zod* schema would silently drop it.

## A.3 ⭐ The exact set of trigger types the engine supports, and each one's exact `triggerConfig` shape

### The enum (4 values, nothing more)

- Prisma: `apps/api/prisma/schema.prisma:114-119`
  ```prisma
  enum TriggerType {
    MANUAL
    SCHEDULE
    WEBHOOK
    EVENT
  }
  ```
- Shared type: `packages/types/src/index.ts:1479-1487` — `type TriggerType = 'MANUAL' | 'SCHEDULE' | 'WEBHOOK' | 'EVENT'`
  and `TRIGGER_TYPES` in that order.
- Column: `schema.prisma:914` — `triggerType TriggerType @default(MANUAL)`; `:916` — `triggerConfig Json?`
  (schema comment at `:915`: *"SCHEDULE: { everyMs?, cron? } · EVENT: { eventType } · WEBHOOK/MANUAL: none."*).

### The whole `TriggerConfig` shape (`packages/types/src/index.ts:1534-1557`)

```ts
export interface TriggerConfig {
  /** SCHEDULE: repeat interval in ms (min 15000). */
  everyMs?: number;
  /** SCHEDULE: cron expression (alternative to everyMs). */
  cron?: string;
  /** EVENT: the internal event name this workflow listens for. */
  eventType?: string;
  conditions?: Condition[];   // EVENT only
  connectorId?: string;       // EVENT only — an InstalledSkill.id
}
```

Every key is optional at the type level; the per-type requirements are enforced in the **service**, not the
type. There are **no other keys** — no `timezone`, no `startAt`, no `endAt`, no per-workflow zone anywhere.

### Per-type requirements (authoritative: `WorkflowsService.validateTrigger`, `workflows.service.ts:1247-1270`)

```ts
  /** Validate a trigger's config shape (SCHEDULE/EVENT); 400 otherwise. */
  private validateTrigger(type: TriggerType, config: TriggerConfig | null): void {
    if (type === 'SCHEDULE') {
      const everyMs = Number(config?.everyMs);
      const hasEvery = Number.isFinite(everyMs) && everyMs >= MIN_SCHEDULE_MS;
      const hasCron = typeof config?.cron === 'string' && config.cron.trim().length > 0;
      if (!hasEvery && !hasCron) {
        throw new BadRequestException(
          `SCHEDULE trigger needs everyMs >= ${MIN_SCHEDULE_MS} or a cron expression`,
        );
      }
    }
    if (type === 'EVENT') {
      const eventType = typeof config?.eventType === 'string' ? config.eventType.trim() : '';
      if (!eventType) {
        throw new BadRequestException('EVENT trigger needs a non-empty eventType');
      }
    }
  }
```

`MIN_SCHEDULE_MS = 15_000` — `apps/api/src/modules/workflows/workflows.constants.ts:85`.

| Trigger type | `triggerConfig` REQUIRED | OPTIONAL | Must be absent / ignored | Enforced at |
|---|---|---|---|---|
| **MANUAL** | *(nothing — `triggerConfig` may be `null`)* | — | all keys ignored | nowhere (no validation at all) |
| **SCHEDULE** | **exactly one of** `cron: string` (non-empty, ≤120 chars) **or** `everyMs: number` (int, ≥ 15000) | the other of the pair (both may be set; `cron` **wins** — see `addSchedule` below) | `eventType`, `conditions`, `connectorId` | `validateTrigger` on PATCH + on `activate()`; `@Min(15000)`/`@MaxLength(120)` on the DTO |
| **WEBHOOK** | *(nothing)* | — | all keys | — (`activate()` mints `webhookToken = randomBytes(24).toString('hex')`, `workflows.service.ts:480-484`) |
| **EVENT** | `eventType: string` (non-empty, trimmed, ≤120 chars) | `conditions?: Condition[]` (≤25), `connectorId?: string` (an `InstalledSkill.id`) | `cron`, `everyMs` | `validateTrigger` + `assertNoConflictingEventTrigger` at activate |

#### SCHEDULE — every read of the config

1. `addSchedule` (`workflows.service.ts:1273-1298`) — turns the config into a BullMQ repeat spec. **`cron`
   takes precedence over `everyMs`:**
   ```ts
   const repeat =
     typeof config?.cron === 'string' && config.cron.trim().length > 0
       ? { pattern: config.cron.trim() }
       : { every: Number(config?.everyMs) };
   ```
   No-ops entirely when `isInlineExecution()` (the double-fire bug documented at `:1278-1287`).
2. `fireSchedule` (`workflows.service.ts:1110-1159`) — the canonical SCHEDULE entry point. Reads
   `triggerConfig` only to build an idempotency key: `scheduleSlotKey(workflow.id, workflow.triggerConfig as { everyMs?: unknown } | null, Date.now())`
   (`:1141-1145`). Note it types the config as `{ everyMs?: unknown }` — the slot key is interval-derived.
3. `remove()` (`:399-401`) and `deactivate()` (`:505-507`) call `removeSchedule` when `triggerType === 'SCHEDULE'`.
4. Frontend codec `apps/web/src/features/workflows/schedule.ts` — the *only* place a friendly schedule is
   turned into a config. `toTriggerConfig` (`:65-82`) emits **exactly one of two shapes**:
   - `{ cron: "<min> <hour> <dom> <month> <dow>" }` — 5-field cron, for HOURLY / DAILY / WEEKDAYS / WEEKLY /
     MONTHLY / CUSTOM;
   - `{ everyMs: Math.max(15_000, n) }` — for INTERVAL.

   Concrete cron strings it writes (`:67-81`):
   | Frequency | cron |
   |---|---|
   | HOURLY | `${minute} * * * *` |
   | DAILY | `${minute} ${hour} * * *` |
   | WEEKDAYS | `${minute} ${hour} * * 1-5` |
   | WEEKLY | `${minute} ${hour} * * ${weekday}` (weekday 0=Sunday … 6=Saturday, `WEEKDAY_NAMES` `:25-33`) |
   | MONTHLY | `${minute} ${hour} ${day} * *` |
   | CUSTOM | verbatim user string |

   `fromTriggerConfig`/`parseCron` (`:91-138`) only recognises those exact shapes; anything else decodes to
   `{ frequency: 'CUSTOM', cron }` and `nextRunAt` returns `null` (`:198-200`) — deliberate, no cron library
   (`:10-16`).

   🔴 **Timezone honesty (`schedule.ts:18-22`):** *"The scheduler evaluates cron in the SERVER's timezone;
   there is no per-workflow timezone column."* A generated schedule therefore has **no timezone key to set** —
   any "9am Dubai time" intent must either be converted to the server zone by the generator or stated to the
   user as server-zone. Do not invent a `timezone` key; nothing reads one.

#### EVENT — every read of the config

1. `validateTrigger` — requires non-empty `eventType` (above).
2. `assertNoConflictingEventTrigger` (`workflows.service.ts:522-556`) — called from `activate()` only
   (`:476-478`). Queries `triggerConfig: { path: ['eventType'], equals: eventType }` among other ACTIVE EVENT
   workflows and 409s unless **both** sides are pinned to *different* `connectorId`s:
   ```ts
   const overlaps = myConnector == null || otherConnector == null || myConnector === otherConnector;
   ```
   → **An assist-built EVENT workflow can fail activation** if the tenant already has one live on the same
   event type. This must be surfaced, not swallowed (publish+activate is already non-atomic; the DTO carries
   `activated:false` + `activationError`).
3. `fireEvent` (`workflows.service.ts:571-615`) — matches on
   `{ status: 'ACTIVE', triggerType: 'EVENT', triggerConfig: { path: ['eventType'], equals: eventType } }`
   (`:577-584`), then per workflow: skips when `cfg.connectorId && cfg.connectorId !== connectorId`
   (`:595-598`), then `evaluateConditions(this.extractConditions(wf.triggerConfig), safePayload)` (`:601-604`).
   `extractConditions` (`:618-621`) returns `[]` when `conditions` is absent → always fire.
4. `fireWebhook` (`:627-647`) — WEBHOOK only; looks the workflow up by `webhookToken` and requires
   `status === 'ACTIVE' && triggerType === 'WEBHOOK'`. Reads **no** `triggerConfig` at all.
5. Inbound-email gating — `apps/api/src/modules/events/inbound/gmail-inbound.service.ts:262-299`:
   ```ts
   where: {
     status: 'ACTIVE',
     triggerType: 'EVENT',
     OR: GMAIL_EVENT_TYPES.map((eventType) => ({
       triggerConfig: { path: ['eventType'], equals: eventType },
     })),
   },
   ```
   with `GMAIL_EVENT_TYPES = ['NEW_EMAIL', 'NEW_EMAIL_REPLY']` (`:123`). If no such workflow exists the sweep
   *never touches Gmail* (`:271-274`). Same shape in `imap-inbound.service.ts:31`
   (`EMAIL_EVENT_TYPES = ['NEW_EMAIL','NEW_EMAIL_REPLY']`). **So `{ triggerType:'EVENT', triggerConfig:{ eventType:'NEW_EMAIL' } }`
   is literally what switches inbound email polling on for a tenant.**

#### The real `eventType` vocabulary

`eventType` is a free string (validated only as non-empty, ≤120). The set that anything actually **fires** is
`CanonicalEventType` — `packages/types/src/index.ts:2851-2875`:

```
NEW_EMAIL · EMAIL_REPLIED · NEW_LEAD · LEAD_STAGE_CHANGED · NEW_PAYMENT · PAYMENT_FAILED ·
NEW_JIRA_ISSUE · JIRA_ISSUE_UPDATED · NEW_GITHUB_PR · NEW_GITHUB_ISSUE · NEW_TICKET ·
TICKET_REPLIED · ASSIGNMENT_CHANGED · STATUS_CHANGED · NEW_PROJECT_ISSUE ·
PROJECT_ISSUE_UPDATED · NEW_DOCUMENT · NEW_CANDIDATE · UNKNOWN
```

⚠️ **Undetermined / inconsistency, flagged not guessed:** both inbound drivers fire the literal string
`'NEW_EMAIL_REPLY'` (`gmail-inbound.service.ts:123,456`; `imap-inbound.service.ts:31,436`) which is **NOT** in
`CANONICAL_EVENT_TYPES` (that list has `EMAIL_REPLIED` instead). Both strings are therefore "real" in
different senses. A trigger generator must use `NEW_EMAIL_REPLY` (what fires) if the intent is "a candidate
replied", and must NOT use `EMAIL_REPLIED` (nothing fires it). This should be decided by the plan, not
inferred.

Also: of the 19 canonical types, only a subset has a live producer. Confirmed producers found:
`NEW_EMAIL`/`NEW_EMAIL_REPLY` (gmail + imap inbound), `NEW_GITHUB_PR`/`NEW_GITHUB_ISSUE`
(`events/normalization/event-mapper.ts:85,97`), `NEW_TICKET`/`TICKET_REPLIED`/`ASSIGNMENT_CHANGED`/`STATUS_CHANGED`
(chatwoot mapper, `event-mapper.ts:239-254`), plus anything a caller pushes through
`POST /workflows/events` (`workflows.controller.ts:100-104`) or the generic mapper (`event-mapper.ts:121-126`,
which accepts any declared type that is in `CANONICAL_SET`). **A generator that emits an EVENT trigger for a
type with no producer builds a workflow that will never fire** — this is the same silent-success class as the
bug being fixed and must be guarded against.

### The frozen `TRIGGER` node carries zero trigger information — confirmed

`apps/api/src/modules/workflows/engine/nodes/node-catalog.ts:99-111`:

```ts
  TRIGGER: {
    type: 'TRIGGER',
    category: 'TRIGGER',
    label: 'Trigger',
    description:
      'Entry point. The run trigger payload is available to later nodes as {{trigger.*}}.',
    inputs: 0,
    outputs: [{ label: 'Start' }],
    configSchema: [],
    hasSideEffects: false,
    canPauseForApproval: false,
  },
```

`configSchema: []` — so `list_node_types` (`assist-read-tools.ts:64-89`, which maps
`d.configSchema.map(...)`) reports the TRIGGER node as having **no configurable fields at all**. The agent is
structurally unable to express trigger intent through the graph.

## A.4 How `evaluateReadiness` treats each trigger type

`apps/api/src/modules/workflows/readiness/workflow-readiness.ts`.

### A.4.1 The trigger check — exact lines `:158-186`

```ts
  // ── 3. Trigger configuration ──────────────────────────────────────────────
  let triggerFailed = false;
  if (triggerType === 'SCHEDULE') {
    const hasCron =
      typeof triggerConfig?.cron === 'string' && triggerConfig.cron.trim() !== '';
    const everyMs = Number(triggerConfig?.everyMs);
    const hasInterval = Number.isFinite(everyMs) && everyMs >= MIN_INTERVAL_MS;
    if (!hasCron && !hasInterval) {
      triggerFailed = true;
      add('TRIGGER_INCOMPLETE', 'BLOCKER',
        'Choose when this workflow should run — pick a frequency and time in the trigger.',
        null, { kind: 'OPEN_TRIGGER' });
    }
  } else if (triggerType === 'EVENT') {
    if (!triggerConfig?.eventType) {
      triggerFailed = true;
      add('TRIGGER_INCOMPLETE', 'BLOCKER',
        'Choose which event should start this workflow.',
        null, { kind: 'OPEN_TRIGGER' });
    }
  }
```

- `MANUAL` and `WEBHOOK` fall through both branches with **no check whatsoever** — `triggerFailed` stays
  `false`. The `TRIGGER` check row is then emitted unconditionally as PASS at `:265-269`:
  ```ts
  { key: 'TRIGGER', label: 'Trigger', status: triggerFailed ? 'FAIL' : 'PASS' },
  ```
- The `SCHEDULE` extra check row is pushed only for SCHEDULE (`:291-297`).
- `describeTrigger` (`:57-80`) renders MANUAL via the `default:` case at `:77-78` →
  `'Manual — someone starts it'`, which lands in `summary.triggerSummary` (`:315`).
- `ready = issues.every(i => i.severity !== 'BLOCKER')` (`:245`).

`MIN_INTERVAL_MS = 15_000` (`workflow-readiness.ts:47`) — deliberately duplicated from
`workflows.constants.ts:85`.

The caller is `WorkflowReadinessService.forWorkflow`
(`apps/api/src/modules/workflows/readiness/workflow-readiness.service.ts:26-70`) which reads
`workflow.triggerType` / `workflow.triggerConfig` straight off the row (`:63-64`) and the `definition`
**column** (not the draft version — `:39-49` explains why).

### A.4.2 🔴 The structural problem the fix must solve (this is the important part)

`MANUAL` is not "unconditionally PASS by oversight" — it is unconditionally PASS *because MANUAL is a
legitimate, complete configuration*. `Workflow.triggerType` has `@default(MANUAL)` (`schema.prisma:914`), so
**a workflow whose trigger silently fell back and a workflow the user genuinely wants manual are byte-identical
rows.** Readiness is a pure function of the row (`workflow-readiness.ts:34-44` — `ReadinessInput` has no
provenance field), so it *cannot* tell them apart no matter how the check is worded.

Therefore readiness cannot be fixed in isolation: the fix must first make the fallback **representable** —
i.e. persist "the author asked for X but it wasn't applied" somewhere readiness can read. Options, in order of
invasiveness:

- (a) `Workflow.assistSessionId` already exists (`schema.prisma:958`, set by `accept()` at
  `assist.service.ts:176-179`). If the session persists the *intended* trigger (see §A.6), readiness could
  join on it. Costs a query in a currently-pure evaluator — `ReadinessInput` would gain a field, populated by
  `WorkflowReadinessService`, keeping the evaluator pure.
- (b) The narrower, cheaper rule that needs no new state at all: **a MANUAL workflow whose graph references
  `{{trigger.*}}` is contradictory** — nothing populates `trigger.*` on a manual run unless the user types a
  payload. That is a genuine, provenance-free BLOCKER/WARNING and it catches the exact failure mode (the
  prompt at `assist-prompt.ts:73` teaches the agent to write `{{trigger.email}}`, so a CV-by-email workflow
  that fell back to MANUAL will almost always contain such a reference).
- (c) Do nothing in readiness and rely on the accept-time translation always succeeding. Not recommended —
  it re-creates a silent path the moment the mapping can't resolve an intent.

**Recommended: (b) as the safety net + (a) only if the plan already adds a session column.** (b) is pure,
testable without a DB, and independently useful for hand-built workflows.

## A.5 The AI Assist agent's tool surface, and where trigger extraction belongs

### Tool contract

`apps/api/src/modules/assist/agent/assist-tool-registry.ts`:

```ts
export interface AssistTool<TArgs = unknown> {
  name: string;
  description: string;                 // prompt surface
  schema: z.ZodType<TArgs>;            // validated BEFORE run(); failure → tool RESULT, never a throw
  parameters: ToolParametersDto;       // flat JSON-schema projection for the provider
  terminal?: boolean;
  run(ctx: AssistToolContext, args: TArgs): Promise<AssistToolOutcome>;
}
export interface AssistToolContext { companyId: string; userId: string; sessionId: string; }
export interface AssistToolOutcome { ok: boolean; result: unknown; summary: string; terminal?: boolean; }
```
(`:22-49`; registry `:55-120`; `params()` helper `:133-138`, `noParams()` `:140`.)

🔴 **Hard constraint documented at `assist-tool-registry.ts:9-15`:** `ToolParametersDto` is **one level deep,
primitives only** (doc 00 §0.7). Any structured tool input must arrive as a **JSON string** and be parsed
server-side. This is why `propose_graph.definition` and `patch_graph.ops` are `z.string()`.

### Full tool inventory (10 tools, registered at `assist-agent.service.ts:93-98`)

**READ — `makeReadTools(prisma)`, `assist-read-tools.ts:35-43`**

| Tool | zod schema | `parameters` | Line |
|---|---|---|---|
| `list_node_types` | `{ category?: string }` | `params({ category: {type:'string'} })` | `:51-91` |
| `list_skills` | `{ query?: string }` | `params({ query: {type:'string'} })` | `:99-168` |
| `list_employees` | `{ role?: string }` | `params({ role: {type:'string'} })` | `:176-222` |
| `list_templates` | `{ query?: string }` | `params({ query: {type:'string'} })` | `:230-274` |
| `inspect_graph` | `z.object({}).strict()` | `noParams()` | `:278-320` |

**WRITE — `makeWriteTools(prisma)`, `assist-write-tools.ts:27-33` → `[proposeGraph, requestConnection, finish]`**

| Tool | zod schema | Required params | Terminal | Line |
|---|---|---|---|---|
| `request_connection` | `{ skillKeys: z.string().trim().min(1) }` (comma-separated) | `['skillKeys']` | no | `:37-100` |
| `propose_graph` | `{ definition: z.string().min(2), rationale: z.string().trim().min(1).max(1000) }` | `['definition','rationale']` | no | `:220-448` |
| `finish` | `{ summary: z.string().trim().min(1).max(2000) }` | `['summary']` | **yes** (`terminal: true`, `:463`) | `:452-496` |

**TEST — `makeTestTools(prisma, workflows)`, `assist-test-tool.ts:36-41`**

| Tool | zod schema | Required params | Line |
|---|---|---|---|
| `patch_graph` | `{ ops: z.string().min(2), rationale: z.string().trim().min(1).max(500) }` | `['ops','rationale']` | `:45-147` |
| `dry_run_test` | `{ sampleTrigger?: z.string() }` | *(none)* | `:151-262` |

Nothing in this surface touches `AiEmployee`, and nothing touches `Workflow.triggerType`.

### The trigger-relevant prompt lines (verbatim, `assist-prompt.ts`)

```
:53  `Only these: ${FROZEN_NODE_TYPES.join(', ')}.`
:59  '- Exactly one `TRIGGER`, and it is the first step with nothing pointing into it.',
:73  '- **Trigger data:** whatever started the run lives under `trigger`. Reference it as
      `{{trigger.<field>}}` — e.g. `{{trigger.email}}`, `{{trigger.name}}`. Never reach for it
      through the trigger step\'s id.',
```

Plus the comment block at `:68-72` explaining why `:73` exists (a real generated workflow wrote
`{{trigger_new_application.email}}` and sent an acknowledgement email with an empty recipient).

**That is the entirety of the prompt's trigger content.** The agent is told a TRIGGER node must exist and be
first, and how to *read* the payload — and is told **nothing** about *what makes the workflow start*. It has no
vocabulary for it because no tool accepts it. This is the root cause, and it is a prompt+tool gap, not a
model failure.

Also note `dry_run_test` (`assist-test-tool.ts:171-236`) calls `workflows.createAssistScratch(...)` then
`workflows.createRun(..., dryRun: true)`. `createAssistScratch` (`workflows.service.ts:1174-1191`) creates the
scratch row with **no trigger fields** and `status: 'ACTIVE'` — so testing gives zero signal about the trigger,
confirming the prior finding.

### Recommendation: where trigger extraction should live

**Recommended: a new required field on `propose_graph`'s schema (`trigger`, a JSON string), validated by a new
pure `resolveTriggerIntent()` function, persisted onto the session, and applied by `accept()`.** Not a new
dedicated tool, and not pure post-processing in `accept()`.

Reasoning, grounded in how this code is actually built:

1. **`propose_graph` is already *the* single "save your design" choke point, and it already rejects-and-teaches.**
   It runs five gates in sequence and returns `ok:false` with a corrective sentence rather than throwing
   (misplaced config `:301-332`, node-id refs `:344-357`, untestable conditions `:359-374`, frozen-17
   `:378-389`, `collectDefinitionIssues` `:393-417`). A bad/unsupported trigger is exactly that shape of
   problem, and the self-correction loop already documented at `assist-tool-registry.ts:16-18` is the cheapest
   correction available. A separate tool can be *skipped* — `propose_graph`'s `required` array cannot be.
2. **A dedicated tool would be skippable and would need its own "did you call it?" enforcement.** There is
   precedent for that failure: the prompt has instructed the agent about outputKeys "for a long time and
   models still write `{{prepareRejection.rejectionEmail}}`" (`assist-write-tools.ts:335-343`) — the fix was a
   *code gate on the write path*, not more prompt. Same lesson applies.
3. **Post-processing in `accept()` alone is wrong** because `accept()` is OWNER/ADMIN-gated, runs long after
   the conversation, has no LLM, and — critically — cannot *tell the user* or let the agent self-correct. It
   also cannot honour the `finish` summary honesty rule (`assist-prompt.ts:50`): the agent must be able to say
   "this starts when an email arrives" *and be right*.
4. `accept()` still needs a small change — it must *apply* the persisted trigger — but that becomes a
   mechanical read-and-pass, not an inference step.

**Concrete shape.** Add to `proposeGraphSchema` (`assist-write-tools.ts:220-225`):

```ts
const proposeGraphSchema = z.object({
  definition: z.string().min(2),
  rationale: z.string().trim().min(1).max(1000),
  // NEW — flat/primitive per doc 00 §0.7, so a JSON string like:
  //   {"type":"EVENT","eventType":"NEW_EMAIL"}
  //   {"type":"SCHEDULE","cron":"0 9 * * 1"}
  //   {"type":"MANUAL"}
  trigger: z.string().min(2),
});
```
…with a matching `params({ …, trigger: { type: 'string', description: … } }, ['definition','rationale','trigger'])`.

**The exact validation function the new data must pass through — two layers, both mandatory:**

1. **A new pure resolver** (recommendation: `apps/api/src/modules/workflows/readiness/`… no — put it in
   `apps/api/src/modules/workflows/engine/trigger-intent.ts` so both assist and any future generator share it),
   signature:
   ```ts
   export type TriggerIntentResult =
     | { ok: true; triggerType: TriggerType; triggerConfig: TriggerConfig | null }
     | { ok: false; error: string };
   export function resolveTriggerIntent(raw: unknown): TriggerIntentResult;
   ```
   It must (i) accept only the 4 `TRIGGER_TYPES`, (ii) reject an `eventType` that is not a real, *produced*
   event (see the producer list in §A.3 — this is a decision the plan must fix, not a guess), (iii) reject a
   cron string `fromTriggerConfig`/`parseCron` would classify as `CUSTOM` **or** accept it while stating that
   "Next run" cannot be predicted, (iv) drop EVENT-only keys on SCHEDULE and vice versa.
2. **`WorkflowsService.validateTrigger(type, config)`** (`workflows.service.ts:1248-1270`) — the existing
   server rule. It is `private`, so either promote it to `public`/`static`, or (preferred, and consistent with
   how `collectDefinitionIssues` is shared across assist/publish/readiness) extract it into the same pure
   module as `resolveTriggerIntent` and have `validateTrigger` delegate to it. **The assist path must run the
   same function publish/activate runs**, exactly as `propose_graph:393` reuses `collectDefinitionIssues`.
   Not running it is how a `triggerConfig` the UI can't decode gets persisted.

Both `propose_graph` **and** `patch_graph` should route through (1)+(2) — `patch_graph` runs the same
`collectDefinitionIssues` gate today (`assist-test-tool.ts:108`) precisely so no dialect can creep in via the
edit path. Trigger changes need a `patch_graph` op (or a `trigger` field on it) for the same reason.

The prompt must also gain a "Rules that matter" bullet naming the four types and the exact keys — put it
beside `:59` and `:73` so all trigger knowledge is in one place.

## A.6 Does `AssistSession` have anywhere to persist a proposed trigger?

**No. A migration is required.** `schema.prisma:2734-2767`:

```prisma
model AssistSession {
  id        String              @id @default(cuid())
  companyId String
  company   Company             @relation(fields: [companyId], references: [id], onDelete: Cascade)
  userId    String
  title     String
  status    AssistSessionStatus @default(ACTIVE)

  /// The in-progress graph. NOT a Workflow until accepted.
  draftDefinition Json?
  /// Bumped on every mutation; powers optimistic UI + stale-patch rejection.
  draftVersion    Int   @default(0)

  targetWorkflowId  String?
  createdWorkflowId String?
  originRunId       String?

  promptTokens     Int @default(0)
  completionTokens Int @default(0)

  messages AssistMessage[]
  createdAt DateTime @default(now())
  updatedAt DateTime @updatedAt

  @@index([companyId, userId, updatedAt])
  @@index([companyId, status])
}
```

There is **no** trigger column and no free-form metadata column on the session. (`AssistMessage.metadata` is
`Json?` — `:2780` — but that is per-message UI payload, cleared/appended per turn, and `accept()` never reads
messages; using it would mean scanning the transcript for the latest trigger, which is exactly the fragile
pattern `draftDefinition` exists to avoid.)

**Minimal migration — 2 nullable columns on `AssistSession`:**

```prisma
  /// The trigger the agent resolved from the user's words, applied at accept().
  /// Null until propose_graph runs. NOT the live workflow's trigger.
  draftTriggerType   TriggerType?
  /// Shape matches TriggerConfig: SCHEDULE {everyMs?|cron} · EVENT {eventType, conditions?, connectorId?}.
  draftTriggerConfig Json?
```

`draftTriggerType` as the existing `TriggerType?` enum (not a String) so an unsupported value is impossible at
the DB level. Both nullable with no default, so existing rows are untouched and `null` means "the agent never
proposed one" — which is the distinction readiness option (a) needs.

Follow the repo's Prisma gotchas: author with `prisma:migrate:new` (= `migrate dev`), then **delete any
`DROP INDEX ..._embedding_idx` line** from the generated SQL before applying with `prisma:migrate`
(= `migrate deploy`) — per platform `CLAUDE.md`.

DTO/mapper changes needed alongside: `AssistSessionDto` (`packages/types/src/index.ts:3742-3749`) and
`toAssistSessionDto` (`apps/api/src/modules/assist/assist.mapper.ts:48-60`). The summary DTO
(`toAssistSessionSummaryDto`, `:31-46`) does not need it.

## A.7 `accept()` non-idempotency — confirmed, with the minimal guard

**Confirmed: there is no `createdWorkflowId` check.** `accept()` (`assist.service.ts:138-191`) runs, in order:
role check (`:144-148`) → `this.get(...)` (`:150`) → empty-draft check (`:152-156`) → `workflows.create(...)`
(`:161-169`) → `assistSession.update({ data: { createdWorkflowId, status:'COMPLETED' } })` (`:171-174`) →
`workflow.update({ data: { assistSessionId } })` (`:176-179`) → audit (`:181-188`). `session.createdWorkflowId`
is read **nowhere** in the method.

The only protection is client-side: `apps/web/src/app/(app)/assist/[sessionId]/page.tsx` — `streamedRef` +
`autoCreateRef` + a `createdWorkflowId` guard inside the effect (`:92-122`; the doc comment at `:74-90`
explicitly states *"`accept` is NOT idempotent server-side"*). Two tabs, a retried request, or any caller that
doesn't replicate the refs each creates a real, separate `Workflow` row; the earlier one is orphaned (still
live in the tenant's list, but no longer pointed at by the session).

**Minimal server-side guard** — insert immediately after `const session = await this.get(companyId, user, id);`
(`assist.service.ts:150`), before the empty-draft check:

```ts
    // Idempotent by the session's own pointer: a second accept for one session
    // returns the workflow the first one made rather than creating a rival row.
    if (session.createdWorkflowId) {
      return this.workflows.get(companyId, session.createdWorkflowId, user.userId);
    }
```

`WorkflowsService.get(companyId, id, actorUserId?)` exists at `workflows.service.ts:261-269` and returns
`WorkflowDto`, so the return type is unchanged and the department-scope check (`assertScope`, `:279-294`) still
applies. Two caveats the plan must handle:

- This is a read-then-write and therefore still racy under true concurrency. To make it airtight, the guard
  must be paired with a conditional claim — e.g. wrap the create in a transaction that first does
  `assistSession.updateMany({ where: { id, createdWorkflowId: null }, data: { status: 'COMPLETED' } })` and
  bails if `count === 0`. That is the same guarded-`updateMany` idiom used throughout the approvals/credits
  code (e.g. `credit-reservation.service.ts:246-253`).
- The `session` here is an `AssistSessionDto` (from `this.get`), and `createdWorkflowId` **is** on the summary
  DTO (`assist.mapper.ts:39`), so no extra query is needed.

**Test to pin it:** `apps/api/test/assist-sessions.e2e-spec.ts` already has the happy-path accept at `:220-276`
(asserts `createdWorkflowId` round-trips at `:273`). Add a case that POSTs `/accept` twice and asserts the
same workflow id both times **and** `prisma.workflow.count({ where: { assistSessionId: session.id } }) === 1`.

---

# GAP B — AI Assist LLM usage bypasses the credit ledger

**Confirmed.** `apps/api/src/modules/assist/agent/assist-agent.service.ts` imports `UsageService`
(`:18`) and calls it once (`:353-358`). It imports **neither** `CreditReservationService`,
`CreditLimitsService`, `CreditCostCalculatorService` nor `creditLedgerEnabled` — the import block is
`:1-33` and contains none of them. Its constructor (`:86-92`) is
`(prisma, @Inject(LLM_PROVIDER_TOKEN) llm, usage, workflows, skillRequirements)`.

## B.1 How the CHAT path meters and enforces credits

`apps/api/src/modules/employees/runtime/agent-runtime.service.ts`. The exact sequence:

**Step 0 — flag gate (`:393`):** `if (creditLedgerEnabled())` — `process.env.CREDIT_LEDGER_ENABLED === 'true'`
(`apps/api/src/common/config/credit-config.ts:17-19`, default false ⇒ the whole block is a no-op).

**Step 1 — resolve enforcement (`:398-402`):**
```ts
const companyRow = await this.prisma.company.findUnique({
  where: { id: companyId }, select: { creditEnforcementEnabledAt: true },
});
const enforcementActive = companyRow ? companyEnforcementActive(companyRow) : false;
```
`companyEnforcementActive` (`credit-config.ts:82-86`) = `CREDIT_ENFORCEMENT_ENABLED === 'true' && company.creditEnforcementEnabledAt != null`.

**Step 2 — resolve the model ONCE (`:386`):** `const model = modelForCall(this.router.forTask('act'), employee.model ?? undefined);`
Used for both the request and every price lookup (the comment at `:380-385` documents the mispricing bug this fixed).

**Step 3 — price a pessimistic upper bound (`:405-412`):**
```ts
const priced = await this.costCalculator.priceLlmCall({
  provider: this.router.providerName,
  model,
  promptTokens: CHAT_TURN_PROMPT_TOKEN_CEILING_ESTIMATE,
  completionTokens: CHAT_TURN_COMPLETION_TOKEN_CEILING,
});
reservationRateId = priced.modelCostRateId;
estimatedCredits = priced.credits;
```
`priceLlmCall(input): Promise<{ credits: number; modelCostRateId: string }>` —
`apps/api/src/modules/credits/credit-cost-calculator.service.ts:43-56`.

**Step 4 — Layer 2, per-employee budget (`:420-437`), only when `enforcementActive`:**
```ts
await this.creditLimits.checkAndReserveEmployeeBudget({
  employeeId: employee.id, companyId, cost: priced.credits, costKind: 'EXECUTION',
});
```
Signature: `checkAndReserveEmployeeBudget(input: { employeeId: string; companyId: string; cost: number; costKind: 'EXECUTION' | 'TASK' }): Promise<void>`
(`credit-limits.service.ts:96-108`). Throws `EmployeeBudgetExceededError` (`:19-30`),
`EmployeeExecutionCeilingExceededError` (`:50-61`) or `EmployeeTaskCeilingExceededError` (`:64-75`); chat wraps
all three as `new ConflictException(\`${employee.name} ${err.message}\`)` (`:434`).

**Step 5 — Layer 3, per-run cap (`:447-460`), only when `options?.workflowRunId`:**
```ts
await this.creditLimits.checkAndReserveWorkflowLimit({
  workflowRunId: options.workflowRunId, companyId, cost: priced.credits,
});
```
Signature `(input: { workflowRunId: string; companyId: string; cost: number }): Promise<void>`
(`credit-limits.service.ts:183-187`); returns early when `run.creditLimit == null` (`:192-193`); throws
`WorkflowLimitExceededError` → wrapped as `ConflictException` (`:456`).

**Step 6 — reserve (`:463-475`):**
```ts
const { reservation: res } = await this.reservations.reserve({
  companyId,
  employeeId: employee.id,
  workflowRunId: options?.workflowRunId ?? null,
  workflowStepRunId: options?.workflowStepRunId ?? null,
  conversationId: conversation.id,
  messageIdempotencyKey: options?.workflowStepRunId ? null : userTurnId,
  resourceType: 'LLM_CALL',
  estimatedCredits: priced.credits,
  modelCostRateId: priced.modelCostRateId,
  reason: `Chat turn for ${employee.name}`,
});
reservation = res;
```

**Step 7 — the catch (`:476-500`) — three distinct outcomes, in order:**
- `enforcementActive && err instanceof InsufficientCreditsError` → `ConflictException('This company has run
  out of credits. An owner or admin needs to add more credits before this can continue.')` (`:481-485`).
  `InsufficientCreditsError` is exported from `credit-ledger.service.ts:397-404`.
- `err instanceof ConflictException` → rethrown as-is (`:489-491`) — a Layer-2 rejection must never be
  swallowed as a "hiccup".
- anything else → `logger.warn('credit reservation failed (shadow mode, ignored): …')` and the turn proceeds
  (`:495-499`).

**Step 8 — the LLM calls + `UsageService.record()` alongside.** Inside the ACT loop, after every completion:
`await this.recordUsage(companyId, employee.id, draft.usage, options)` (`:523` and again on the forced final
answer at `:580`). `recordUsage` (`:899-917`):
```ts
await this.usage.record({
  companyId, employeeId,
  source: options?.source ?? 'chat',
  promptTokens: usage.promptTokens, completionTokens: usage.completionTokens,
  workflowRunId: options?.workflowRunId, workflowStepRunId: options?.workflowStepRunId,
});
```
Token totals are accumulated separately into `totalPromptTokens`/`totalCompletionTokens` (`:524-527`,
`:581-584`) for settlement. Note: **`UsageService.record` and the reservation are independent** — one turn
produces N usage rows (one per completion) and exactly 1 reservation.

**Step 9 — settle on success (`:652-661`):**
```ts
const creditsCharged = reservation
  ? await this.settleTurnReservation(reservation, companyId, totalPromptTokens,
      totalCompletionTokens, reservationRateId, model)
  : null;
```
`settleTurnReservation` (`:686-717`) re-prices from **real** tokens then:
```ts
await this.reservations.settle({
  reservationId: reservation.id, companyId,
  actualCredits: actual.credits,
  modelCostRateId: actual.modelCostRateId ?? fallbackRateId,
});
```
Never throws (shadow-mode contract); returns `actual.credits` or `null`.

**Step 10 — release on failure (`:673-678`):**
```ts
} catch (err) {
  if (reservation) { await this.releaseTurnReservation(reservation, companyId); }
  throw err;
}
```
`releaseTurnReservation` (`:720-737`) calls
`this.reservations.release({ reservationId, companyId, reason: 'Chat turn failed before producing a response' })`,
also never throwing.

**Idempotency key derivation** — `CreditReservationService.deriveKey` (`credit-reservation.service.ts:457-462`):
```ts
  private deriveKey(input: ReserveInput): string {
    const raw = input.workflowStepRunId
      ? `${input.companyId}:${input.workflowStepRunId}`
      : `${input.companyId}:${input.conversationId}:${input.messageIdempotencyKey}`;
    return createHash('sha256').update(raw).digest('hex');
  }
```
For chat: `sha256(companyId:conversationId:userTurnId)` where `userTurnId` is the just-persisted USER
`Message.id` (rationale at `agent-runtime.service.ts:363-379`).

**Return shapes:** `reserve(): Promise<ReserveResult>` = `{ outcome: 'created'|'settled'|'duplicateInFlight'|'resumable'; reservation: CreditReservationDto }`
(`credit-reservation.service.ts:33-57`); `settle()` and `release()` both return `Promise<CreditReservationDto>`.

## B.2 The workflow `AI_STEP` path

`apps/api/src/modules/workflows/engine/nodes/ai-step.handler.ts`.

- **Gate (`:146`):** `if (creditLedgerEnabled() && stepRunId)` — note the extra `stepRunId` condition; the
  comment at `:137-143` explains `stepRunId` is optional on `NodeExecContext` only for hand-built unit tests.
- Enforcement resolution `:147-151` (identical to chat).
- Price `:154-159` with `AI_STEP_PROMPT_TOKEN_CEILING_ESTIMATE` / `AI_STEP_COMPLETION_TOKEN_CEILING`.
- Layer 2 only `if (employeeId)` (`:169-176`); Layer 3 unconditionally (`:177-181`) with `workflowRunId: runId`.
- **Reserve (`:184-193`):**
  ```ts
  const { reservation } = await this.reservations.reserve({
    companyId,
    employeeId: employeeId || null,
    workflowRunId: runId,
    workflowStepRunId: stepRunId,
    resourceType: 'LLM_CALL',
    estimatedCredits: priced.credits,
    modelCostRateId: priced.modelCostRateId,
    reason: `AI_STEP node "${node.id}"`,
  });
  ```
  **No `conversationId`, no `messageIdempotencyKey`** ⇒ `deriveKey` takes the first branch:
  `sha256(companyId:workflowStepRunId)`. Confirmed as believed.
- **Error handling differs from chat and this matters:** typed limit errors are **rethrown unwrapped**
  (`:200-207`) so `RetryPolicyService.classify` can `instanceof` them; `InsufficientCreditsError` has its
  `.message` **mutated in place** rather than being wrapped, with an explicit comment (`:208-226`) that a new
  `Error` would lose the `instanceof` and let a non-retryable failure fall into the retryable `NODE_ERROR`
  class.
- Usage recorded separately at `:253-263` with `source: 'workflow_ai_step'`, `workflowRunId: runId`,
  `workflowStepRunId: stepRunId`.
- Release on LLM throw `:247-252`; settle from real usage `:264-273`.

Also confirmed present but separate: the legacy dollar-based monthly budget check at `:106-117`
(`usage.totalCostForEmployee(...) >= employee.budgetLimit` → plain `Error`), which runs regardless of the
credit flags.

## B.3 ⭐ The hard part — attributing Assist spend with no `WorkflowStepRun` and no `Conversation`

### What `reserve()` actually requires — `ReserveInput`, field by field (`credit-reservation.service.ts:15-31`)

```ts
export interface ReserveInput {
  companyId: string;                        // REQUIRED
  employeeId?: string | null;               // optional
  workflowRunId?: string | null;            // optional
  workflowStepRunId?: string | null;        // optional — the idempotency anchor for workflow calls
  conversationId?: string | null;           // optional
  messageIdempotencyKey?: string | null;    // "Required when workflowStepRunId is absent (chat/assist calls)"
  executionId?: string | null;              // optional
  resourceType: CreditResourceType;         // REQUIRED — 'LLM_CALL' | 'TOOL_CALL' (credits.types.ts:38)
  estimatedCredits: number;                 // REQUIRED
  modelCostRateId?: string | null;          // optional at the type level — see the assertion below
  toolCostRateId?: string | null;           // optional at the type level — see the assertion below
  reason: string;                           // REQUIRED
  source?: CreditSource;                    // optional, defaults 'SYSTEM' (:109)
}
```

Only **4 fields are structurally required**: `companyId`, `resourceType`, `estimatedCredits`, `reason`.
But two more are *effectively* required:

1. **A rate id.** `CreditLedgerService.assertRatePresence` (`credit-ledger.service.ts:386-393`) throws
   `InternalServerErrorException` for any `DEBIT`/`RESERVATION` with neither `modelCostRateId` nor
   `toolCostRateId`. So assist **must** call `priceLlmCall` first and pass `modelCostRateId`. `priceLlmCall`
   always returns a non-null `modelCostRateId` (`credit-cost-calculator.service.ts:43-56`, self-healing via
   `rateAdmin.ensureModelRate`), so this is satisfiable.
2. **An idempotency anchor.** With `workflowStepRunId` absent, `deriveKey` produces
   `sha256(companyId:${conversationId}:${messageIdempotencyKey})`. Passing both as `null` yields the literal
   string `"<companyId>:null:null"` for **every** assist turn in a company — and `CreditReservation` has
   `@@unique([companyId, idempotencyKey])` (`schema.prisma:1407`). The **first** assist turn would create a
   reservation; every subsequent turn in that company would P2002 and be returned as `settled` /
   `duplicateInFlight` (`credit-reservation.service.ts:152-171`), silently charging nothing forever. **This is
   the single sharpest trap in Gap B and any implementation must not hit it.**

### What `CreditLedger` allows for attribution — and the key finding

`schema.prisma:1247-1311`. Attribution columns: `companyId`, `employeeId?`, `workflowId?`, `workflowRunId?`,
`workflowStepRunId?`, `conversationId?`, `executionId?`, `reservationId?`, `packId?`,
`enterpriseAgreementId?`, `lotId?`, plus `reason`, `source`, `metadata Json?`.

🔑 **None of these are foreign keys.** The only `@relation` in the model is the self-reference
`reversesLedgerEntry` (`:1284-1286`). A repo-wide grep for back-relations (`CreditLedger[]` /
`CreditReservation[]`) returns exactly one hit — that self-relation — and `Conversation`
(`schema.prisma:746-758`) has **no** `creditLedger`/`creditReservation` field. The same is true of
`CreditReservation` (`:1380-1414`): every id column is a bare `String?`. This is the deliberate
"Convention B" the credits e2e header documents (`apps/api/test/credits-phase3.e2e-spec.ts:26-32`:
*"`CreditReservation`/`CreditLedger`/`CompanyCreditBalance` use Convention B (plain `companyId`, no
`@relation`), so `Company.delete` does NOT cascade to them"*).

**Consequence: writing an `AssistSession.id` into `conversationId` would be accepted by Postgres, needs no
migration, and would produce correct balance math.** I am reporting that because you asked whether any column
could be used — but **I do not recommend it**, for three concrete reasons:

- `credits-phase3.e2e-spec.ts` queries `prisma.creditReservation.findFirst({ where: { conversationId: conversation.id } })`
  (`:160-162`, `:179-181`) to mean "the chat reservation for this conversation". Overloading the column makes
  those semantics ambiguous and any future "chat spend" report silently include assist spend.
- `credit-reservation-sweep.service.ts` uses the `@@index([status, leaseExpiresAt])` "chat/assist fallback
  sweep" (schema comment `:1411-1413`) — it already anticipates non-workflow reservations, but a sweep that
  reasons about `conversationId` would now be reasoning about two different entity types.
- The `/billing/usage` table renders per-row attribution; a row claiming to belong to a `Conversation` id that
  doesn't exist in `Conversation` is a data-integrity lie in the customer's own billing record.

### Recommendation

**Option 1 (recommended, NO migration): use `messageIdempotencyKey` as the anchor and `metadata`/`reason` for
attribution.**

```ts
const priced = await this.costCalculator.priceLlmCall({
  provider: /* the assist provider name */, model, promptTokens: ASSIST_TURN_PROMPT_TOKEN_CEILING_ESTIMATE,
  completionTokens: ASSIST_TURN_COMPLETION_TOKEN_CEILING,
});
const { reservation } = await this.reservations.reserve({
  companyId,
  employeeId: null,                              // assist is not an employee — correct as null
  conversationId: null,
  messageIdempotencyKey: `assist:${sessionId}:${turnSeq}`,   // ⇐ the anchor
  resourceType: 'LLM_CALL',
  estimatedCredits: priced.credits,
  modelCostRateId: priced.modelCostRateId,
  reason: `AI Assist turn (session ${sessionId})`,
});
```
`deriveKey` then yields `sha256(companyId:null:assist:<sessionId>:<turnSeq>)` — unique per turn, stable across
a retry of the same turn. `turnSeq` must come from something already persisted and monotonic; the cleanest
existing candidate is the id of the USER `AssistMessage` for this turn (created in `AssistService.turn` at
`assist.service.ts:239-241`) — but note it is **not currently returned** to the caller, and the
"repeatsUnanswered" branch (`:234-242`) can skip creating it entirely, in which case the last USER message's
id is the right anchor. **Flagged as needing a decision: the plan must specify exactly which id is used and
handle the `repeatsUnanswered` case, or the key will collide across the "empty text opens the stream" path.**

Trade-off, stated: with no `assistSessionId` column, the `/billing/usage` table shows the row with
Employee "—" and Workflow "—", and the session id is only recoverable from `reason` (free text) or `metadata`.
That is honest but not filterable.

**Option 2 (if the plan wants first-class, filterable assist attribution): one nullable column on each of two
models.** Exact names:

- `CreditLedger.assistSessionId String?` (+ optionally `@@index([companyId, assistSessionId])`)
- `CreditReservation.assistSessionId String?`

plus `assistSessionId?: string | null` on `ReserveInput` (`credit-reservation.service.ts:15-31`),
`CreditLedgerAppendInput` (`apps/api/src/modules/credits/credits.types.ts:47-70`), `CreditLedgerEntry`
(`:73-92`), `toEntry`, the `deriveKey` branch, and `CreditLedgerEntryDto` in `@vaep/types` + the mapping in
`billing.controller.ts:130-158`. Keep it a bare `String?` with **no** `@relation`, matching Convention B —
adding an FK would break the documented non-cascade behaviour the credits tests rely on.

**My recommendation: ship Option 1 first** (it closes the enforcement + ledger-visibility gap with zero
migration risk and zero schema churn), and treat Option 2 as a follow-on only if the founder wants assist
spend filterable on `/billing/usage`. Note the deriveKey change is unavoidable either way if you want a
per-turn key — Option 1 achieves it with an existing field.

### Enforcement layers for assist — what applies and what does not

- **Layer 1 (company balance floor)** — applies, and comes free: it lives inside `CreditLedgerService`'s
  guarded `updateMany` and surfaces as `InsufficientCreditsError` (`credit-ledger.service.ts:397-404`).
  Assist must catch it and, when `enforcementActive`, turn it into a user-visible stop. The natural place is
  the existing `stoppedBecause` mechanism — `AssistTurnResult.stoppedBecause?: 'iterations' | 'budget'`
  (`assist-agent.service.ts:64`), already rendered and already used by the token-budget path (`:121-140`).
  Extend that union rather than throwing: assist's own budget stop is a graceful reply, not a 409.
- **Layer 2 (per-employee budget)** — **does not apply.** Assist has no `AiEmployee`; `employeeId` is `null`.
  `checkAndReserveEmployeeBudget` requires an `employeeId: string`. Do not fabricate one.
- **Layer 3 (per-run cap)** — **does not apply.** No `WorkflowRun`. `checkAndReserveWorkflowLimit` requires a
  `workflowRunId: string`.

So the assist enforcement story is Layer 1 + the existing `ASSIST_SESSION_TOKEN_BUDGET` (400 000 output
tokens, `assist.constants.ts:16-17`). That is a real, defensible design — but the plan should state it
explicitly rather than leaving "assist has no per-employee cap" as an unspoken hole.

### Module wiring

`AssistModule` (`apps/api/src/modules/assist/assist.module.ts:23-32`) imports
`[WorkflowsModule, BillingModule, LlmModule, SkillsModule]`. `CreditsModule`
(`apps/api/src/modules/credits/credits.module.ts`) exports `CreditReservationService`,
`CreditCostCalculatorService`, `CreditLimitsService`, `CreditLedgerService` and others, and its house rule
(`:33-36`) is *"CreditsModule must never import WorkflowsModule, EmployeesModule, or SkillsModule back."*
So **adding `CreditsModule` to `AssistModule.imports` creates no cycle** — Assist → Credits is one-way, the
same direction Employees/Workflows/Skills already use. (`UsageService` needs no import: `UsageModule` is
`@Global` — `apps/api/src/modules/usage/usage.module.ts`.)

## B.4 `ASSIST_USAGE_SOURCE` — where it lives and how it is called

Defined at `apps/api/src/modules/assist/assist.constants.ts:26-27`:
```ts
/** Usage-metering source tag, so assist spend is separable from chat spend. */
export const ASSIST_USAGE_SOURCE = 'assist';
```

Imported at `assist-agent.service.ts:24` and used exactly once, at `:352-358` — after the connection-card
block, before the log line and the return:
```ts
    // Metered under its own source so assist spend is separable from chat spend.
    await this.usage.record({
      companyId,
      source: ASSIST_USAGE_SOURCE,
      promptTokens,
      completionTokens,
    });
```

Note what is **absent**: `employeeId` (so it is stored as `null` per `usage.service.ts:85`), `workflowRunId`,
`workflowStepRunId`. `RecordUsageParams` (`usage.service.ts:9-19`) has no session field, so the `UsageEvent`
row cannot be traced back to an assist session either — only aggregated by `source: 'assist'`.

Also note this is **once per turn**, aggregating all completions in the loop (`promptTokens`/`completionTokens`
are accumulated across every `streamOrComplete` at `:186-187` and `:276-277`, including the forced wrap-up
call at `:259-279`). That is a *different* granularity from chat (which records per completion) — so a
reservation should likewise be **one per turn**, opened before the loop and settled after it, matching the
chat turn's own "reservation covering the WHOLE turn" design (`agent-runtime.service.ts:363-365`).

## B.5 Would `/billing/usage` show assist spend automatically once ledger rows exist?

**Yes for the rows to appear; no for them to be legible. A small display change is needed.**

- Backend `GET /billing/credits/usage` — `apps/api/src/modules/billing/billing.controller.ts:121-158`,
  `@Roles('OWNER','ADMIN')`. It calls `creditLedger.listEntries({ companyId, employeeId, source, since, until, limit })`
  and maps every column through. `listEntries` (`credit-ledger.service.ts:358-384`) filters only on
  `companyId` + optional `employeeId`/`source`/date range, `orderBy: { createdAt: 'desc' }`,
  `take: Math.min(limit ?? 100, 500)`. **An assist ledger row with `companyId` set is returned with no code
  change.** (`source` here is the ledger's `SYSTEM|USER|WEBHOOK|ADMIN` axis, *not* `UsageEvent.source` — an
  assist reservation defaulting to `'SYSTEM'` is included by the unfiltered default.)
- Frontend `apps/web/src/features/billing/components/UsageLedgerTable.tsx` — columns are
  **Date · Employee · Workflow · Action · Credits · Actual Cost**. With `employeeId: null` and
  `workflowId: null`, an assist row renders `—` / `—`, i.e. indistinguishable from an unattributed row.
  `employeeName()` (`:21-22`) returns `'—'` for null; the Workflow cell is `entry.workflowId ?? '—'` (`:105`).
  Also `SOURCES = ['SYSTEM','USER','WEBHOOK','ADMIN']` (`:9`) — there is no "assist" filter option and there
  shouldn't be one on that axis.
- **Minimum display change:** make the Employee (or a new "Source"/"Where") cell fall back to something
  meaningful for assist rows. With Option 1 (no migration) the only signal is `reason`
  (`"AI Assist turn (session …)"`), which is already returned by the endpoint (`billing.controller.ts:151`)
  but **not rendered by the table at all**. Adding the `reason` as the Workflow-cell fallback, or as a new
  column, is the smallest honest fix. With Option 2, render `assistSessionId` directly.

## B.6 Existing test patterns to match

**House style: `apps/api/test/credits-phase3.e2e-spec.ts`** (507 lines) — this is the file the new assist
tests should mirror. Key conventions:

- `const hasDb = Boolean(process.env.DATABASE_URL); const describeIfDb = hasDb ? describe : describe.skip;` (`:34-35`)
- Flags toggled **directly on `process.env`** in the test body, because `credit-config.ts` reads
  `process.env` live rather than through `ConfigService` (`:22-25`): `process.env.CREDIT_LEDGER_ENABLED = 'true'`
  / `delete process.env.CREDIT_LEDGER_ENABLED`, with `delete` in `afterAll` (`:113`).
- A fresh company per describe-block via `newCompany(label)` (`:49-62`) — registers through
  `POST /auth/register` with a randomised email.
- Balances set by direct Prisma write, explicitly labelled `/** TEST SCAFFOLDING ONLY … */` (`:64-70`).
- **Explicit Convention-B cleanup in `afterAll`** (`:112-127`): `creditLedger` → `creditReservation` →
  `companyCreditBalance` → … → `company`, because `Company.delete` does not cascade to the credit tables. The
  header comment (`:26-32`) records that skipping this "polluted the dev DB … and made the reservation-leak
  sweep (deliberately cross-tenant) trip over stale rows from unrelated, hours-old runs."

The pattern to copy, verbatim shape (`:151-177`):

```ts
    it('flag ON: a successful chat turn opens a reservation and settles it from real usage', async () => {
      process.env.CREDIT_LEDGER_ENABLED = 'true';
      await resetBalance(companyId, 1000);
      const conversation = await prisma.conversation.create({
        data: { companyId, employeeId: employee.id },
      });

      await agentRuntime.run(employee as never, conversation as never, 'Hello again.');

      const reservation = await prisma.creditReservation.findFirst({
        where: { conversationId: conversation.id },
      });
      expect(reservation).not.toBeNull();
      expect(reservation!.status).toBe('SETTLED');
      expect(Number(reservation!.actualCredits)).toBeGreaterThan(0);
      expect(reservation!.resourceType).toBe('LLM_CALL');

      const debits = await prisma.creditLedger.count({
        where: { reservationId: reservation!.id, transactionType: 'DEBIT' },
      });
      expect(debits).toBe(1);

      // §33 — exactly one audit row for this settlement.
      const auditRows = await prisma.auditLog.count({
        where: { companyId, action: 'credit.settled', entityId: reservation!.id },
      });
      expect(auditRows).toBe(1);
    });
```

And the paired flag-OFF test (`:140-149`) asserting **zero** rows — every credit call site in this repo has
one, and the new assist tests must too.

Also relevant: `:179-195` proves two independent turns get two reservations with **different**
`idempotencyKey`s. **An assist equivalent of that test is mandatory**, because it is exactly the assertion
that would catch the `"<companyId>:null:null"` collision trap described in §B.3.

**`CLAUDE.md`'s warning, restated because it applies directly here:** *"asserting a GLOBAL count against a
CROSS-TENANT sweep in the shared dev DB (`credits-phase2` did exactly that and failed ~1 run in 3; fixed
2026-09-03)"*. Every new assertion must be scoped by `companyId` (or by the specific `reservationId` /
`assistSessionId`) — never `prisma.creditReservation.count()` with no `where`, and never a call to any
retention/SLA/reservation `sweep()` from a test (project memory: *"the dev DB has 44 tenants with real
retention policies"*).

There is **one** credit unit spec — `apps/api/src/modules/credits/credit-reservation-sweep.service.spec.ts` —
and `credit-limits.service.spec.ts`; neither asserts an end-to-end reserve→settle, so the e2e file above is
the only real precedent.

---

# What the implementation plan must do

Ordered. Each step names the exact file and the exact signature.

## Part A — trigger wiring

**A-1. Extract the trigger rule into one shared pure module.**
New file `apps/api/src/modules/workflows/engine/trigger-intent.ts`:
```ts
export type TriggerIntentResult =
  | { ok: true; triggerType: TriggerType; triggerConfig: TriggerConfig | null }
  | { ok: false; error: string };
/** Parse + validate an agent-proposed trigger. `raw` is the parsed JSON from propose_graph.trigger. */
export function resolveTriggerIntent(raw: unknown): TriggerIntentResult;
/** The rule `validateTrigger` enforces, as a pure predicate (throws nothing). */
export function collectTriggerIssues(type: TriggerType, config: TriggerConfig | null): string[];
```
Then make `WorkflowsService.validateTrigger` (`workflows.service.ts:1248-1270`) delegate to
`collectTriggerIssues` and throw `BadRequestException(issues.join(' · '))`. **Do not duplicate the rule** —
this mirrors how `collectDefinitionIssues` is shared by publish, readiness and `propose_graph`.
`resolveTriggerIntent` must reject: unknown `type`; SCHEDULE with neither `cron` nor `everyMs >= 15000`; EVENT
with empty `eventType`; EVENT with an `eventType` outside the agreed allow-list (see A-2); and must strip
cross-type keys.

**A-2. DECIDE and encode the EVENT allow-list.** Blocking decision, flagged not guessed: `CANONICAL_EVENT_TYPES`
(`packages/types/src/index.ts:2851-2875`) contains 19 names, but the inbound drivers fire
`NEW_EMAIL_REPLY` — which is **not in that list** — while `EMAIL_REPLIED` — which is — has no producer.
The plan must publish an explicit `ASSIST_ALLOWED_EVENT_TYPES` constant containing only types with a live
producer, and `resolveTriggerIntent` must reject everything else with a message telling the agent what to use
instead (the `rejectionFor`-style pattern at `frozen-node-types.ts:56-63`).

**A-3. Migration: 2 nullable columns on `AssistSession`** (`apps/api/prisma/schema.prisma:2734-2767`):
`draftTriggerType TriggerType?` and `draftTriggerConfig Json?`. Author with `prisma:migrate:new`, strip any
`DROP INDEX ..._embedding_idx` from the SQL, apply with `prisma:migrate`.

**A-4. `propose_graph` gains a required `trigger` field.**
`apps/api/src/modules/assist/agent/assist-write-tools.ts`:
- `proposeGraphSchema` (`:220-225`) → add `trigger: z.string().min(2)`.
- `parameters` (`:235-249`) → add the `trigger` property and put `'trigger'` in the required array.
- In `run` (`:250`), after the existing five gates and **before** the `assistSession.update` at `:423-430`:
  parse with `extractJson` (same tolerant parse as `:253`), call `resolveTriggerIntent`, and on `!ok` return
  `{ ok: false, summary: …, result: { error: intent.error } }` in the identical style as the other gates.
  On success extend the update to
  `data: { draftDefinition, draftVersion: { increment: 1 }, draftTriggerType: intent.triggerType, draftTriggerConfig: intent.triggerConfig ?? null }`
  and include the resolved trigger in the returned `result` so the agent can describe it truthfully in
  `finish`.
- Update the tool `description` (`:232-233`) — it is prompt surface.

**A-5. `patch_graph` must be able to change the trigger.** `apps/api/src/modules/assist/agent/assist-test-tool.ts`
— either add an optional `trigger: z.string().optional()` to `patchGraphSchema` (`:45-48`) routed through the
same `resolveTriggerIntent`, or add a `setTrigger` op to `GraphPatchOp` (`agent/graph-patch.ts`). Prefer the
schema field: `applyGraphPatch` is a pure graph function and the trigger is not part of the graph.

**A-6. Prompt.** `apps/api/src/modules/assist/agent/assist-prompt.ts` — add a "Rules that matter" bullet next
to `:59` and `:73` naming the four trigger types and their exact keys, and stating that MANUAL is a real
choice the agent may make **only** when the user asked for it. Also state the server-timezone fact
(`schedule.ts:18-22`) so the agent never claims a zone it cannot set.

**A-7. `accept()` applies the trigger AND becomes idempotent.**
`apps/api/src/modules/assist/assist.service.ts:138-191`:
- Insert the idempotency guard from §A.7 right after `:150`, backed by a guarded
  `assistSession.updateMany({ where: { id, createdWorkflowId: null }, … })` claim.
- Pass the trigger through. Two sub-options; **recommended: widen `create()`**, because a second write is a
  second failure mode and `accept()`'s current comment (`:158-160`) promises "the ORDINARY create path":
  - Add `triggerType?: TriggerType` and `triggerConfig?: TriggerConfig` to
    `createWorkflowSchema` (`packages/types/src/index.ts:1953-1962`) **and** `CreateWorkflowDto`
    (`apps/api/src/modules/workflows/dto/create-workflow.dto.ts:15-37`) with
    `@IsOptional() @IsIn(TRIGGER_TYPES)` / `@IsOptional() @ValidateNested() @Type(() => TriggerConfigDto)`
    (reuse the existing `TriggerConfigDto` from `update-workflow.dto.ts:49-81` — move it to a shared
    `dto/trigger-config.dto.ts` rather than duplicating).
  - In `WorkflowsService.create` (`workflows.service.ts:198-228`): call
    `this.validateTrigger(dto.triggerType ?? 'MANUAL', dto.triggerConfig ?? null)` **before** the
    `prisma.workflow.create`, and write `triggerType: dto.triggerType ?? undefined` and
    `triggerConfig: dto.triggerConfig === undefined ? undefined : (dto.triggerConfig as Prisma.InputJsonObject)`
    — matching `update()`'s existing idiom at `:332-336`.
  - Also fix the drift noted in §A.2: add `connectorId` to `triggerConfigSchema`
    (`packages/types/src/shared-schemas.ts:97-102`).
- The `accept()` call becomes:
  ```ts
  const workflow = await this.workflows.create(companyId, {
    name: dto.name,
    description: dto.description,
    definition: definition as WorkflowDefinition,
    ...(session.draftTriggerType ? { triggerType: session.draftTriggerType } : {}),
    ...(session.draftTriggerConfig ? { triggerConfig: session.draftTriggerConfig } : {}),
  }, user.userId);
  ```
  (requires `draftTriggerType`/`draftTriggerConfig` on `AssistSessionDto`
  (`packages/types/src/index.ts:3742-3749`) and `toAssistSessionDto` (`assist.mapper.ts:48-60`)).
- **Handle the EVENT single-active conflict.** `assertNoConflictingEventTrigger` runs at *activate*, not
  create, so `accept()` will succeed and activation may 409 later. The frontend auto-create effect
  (`apps/web/src/app/(app)/assist/[sessionId]/page.tsx:92-122`) pushes straight to `/workflows/:id`, where
  the existing "Published v1, but it isn't live yet" surface (`activated:false` + `activationError`) already
  handles this — verify that path renders, don't add a new one.

**A-8. Readiness stops reporting "ready & automated" for a silent MANUAL fallback.**
`apps/api/src/modules/workflows/readiness/workflow-readiness.ts:158-186` — add, inside a new
`else if (triggerType === 'MANUAL')` branch (or after the existing chain), the provenance-free rule from
§A.4.2(b):
```ts
// A MANUAL workflow whose steps read {{trigger.*}} is contradictory: nothing
// populates the trigger payload unless a human types one in.
```
Emit `code: 'TRIGGER_MANUAL_BUT_EXPECTS_PAYLOAD'`, `severity: 'BLOCKER'`, `fix: { kind: 'OPEN_TRIGGER' }`,
and set `triggerFailed = true` so the `TRIGGER` check row (`:265-269`) flips to `FAIL`. Scan node configs for
`{{trigger.…}}` using the same recursive string walk as `findNodeIdRefs`
(`assist-write-tools.ts:132-162`) — extract it rather than writing a second scanner.
**Respect the invariant** documented at `:122-130` and in `CLAUDE.md`: `ready === (publish would succeed)`.
Publish does **not** enforce a trigger, so a BLOCKER here would break the invariant and reintroduce the
"readiness says ready, publish 400s" / "readiness says not ready after the user fixed it" pair of bugs.
**Therefore: either make `activate()` enforce the same rule (activate already requires a valid trigger, so
this is the consistent home), or emit it as a `WARNING` and let the `TRIGGER` check show `WARN`.** The plan
must pick one explicitly. My recommendation: **`WARNING` + `TRIGGER: 'WARN'`**, plus the honest
`triggerSummary`, because the workflow genuinely *is* publishable — it just won't do what was asked.

**A-9. `describeTrigger` must not lie.** `workflow-readiness.ts:57-80` — the `default:` case at `:77-78`
returns `'Manual — someone starts it'` for both MANUAL and any future type. Make the switch total over
`TriggerType` (per project memory's "a cast is not a conversion" / `Record<Union,…>` rule) so a new trigger
type is a compile error rather than a silent "Manual".

## Part B — assist credit metering

**B-1. Wire the module.** `apps/api/src/modules/assist/assist.module.ts:29` — add `CreditsModule` to
`imports`. No cycle (§B.3). Update the module doc comment, which currently enumerates why each import exists.

**B-2. Add assist token ceilings.** `apps/api/src/modules/assist/assist.constants.ts` — two new constants
mirroring `CHAT_TURN_PROMPT_TOKEN_CEILING_ESTIMATE` / `CHAT_TURN_COMPLETION_TOKEN_CEILING`:
`ASSIST_TURN_PROMPT_TOKEN_CEILING_ESTIMATE` and `ASSIST_TURN_COMPLETION_TOKEN_CEILING`. An assist turn can
make up to `ASSIST_MAX_ITERATIONS = 12` completions at `maxTokens: 4096`
(`assist-agent.service.ts:163,175`) plus a 1024-token wrap-up (`:270`), so the ceiling must be sized for the
**whole turn**, not one call — otherwise settlement will exceed the estimate and
`settleWithin`'s `reservedBalance` floor-guard throws (documented limitation,
`credit-reservation.service.ts:190-194`).

**B-3. Reserve → run → settle/release around the turn.**
`apps/api/src/modules/assist/agent/assist-agent.service.ts`:
- Inject `CreditCostCalculatorService`, `CreditReservationService` into the constructor (`:86-92`).
- After the token-budget early return (`:121-140`) and before the loop (`:163`), inside
  `if (creditLedgerEnabled())`: read `Company.creditEnforcementEnabledAt`, compute
  `companyEnforcementActive`, `priceLlmCall`, then `reserve(...)` with the §B.3 Option-1 shape.
  **Skip Layers 2 and 3 deliberately, with a comment saying why** (no employee, no run).
- Wrap the whole loop in `try { … } catch { release; throw }` and settle after it — mirroring
  `agent-runtime.service.ts:652-678`. Settle from the **accumulated** `promptTokens`/`completionTokens` that
  already exist as locals (`:152-153`), the same figures `usage.record` uses at `:353-358`.
- On `enforcementActive && err instanceof InsufficientCreditsError`, do **not** throw a `ConflictException`
  (that would 500/409 an SSE stream mid-flight). Return the graceful shape already used for the token budget:
  extend `AssistTurnResult['stoppedBecause']` (`:64`) to `'iterations' | 'budget' | 'credits'` and return a
  plain-language reply. Update `AssistStreamEvent`/DTO consumers if that union is shared.
- **Leave the `UsageService.record` call at `:352-358` exactly as it is.** It is the only per-`source`
  aggregate that feeds `BillingService.usage()`; removing or moving it would regress the existing
  `/billing/usage` estimate. Ledger integration is *additive*.

**B-4. Optional (only if filterable attribution is wanted).** Migration adding
`CreditLedger.assistSessionId String?` + `CreditReservation.assistSessionId String?` (no `@relation`, per
Convention B) and threading it through `ReserveInput`, `CreditLedgerAppendInput`, `CreditLedgerEntry`,
`toEntry`, `deriveKey`, `CreditLedgerEntryDto` and `billing.controller.ts:130-158`. Decide before B-3, since
it changes the `reserve()` call.

**B-5. `/billing/usage` display.** `apps/web/src/features/billing/components/UsageLedgerTable.tsx` — render
`entry.reason` (already returned by the endpoint, currently unrendered) as the fallback for the
Employee/Workflow cells so an assist row is legible instead of `— / —`. With B-4, render `assistSessionId`.

## Required test cases

**Trigger (Part A)**

| # | Kind | File | Assertion |
|---|---|---|---|
| A-T1 | unit | new `trigger-intent.spec.ts` | `resolveTriggerIntent` accepts `{"type":"SCHEDULE","cron":"0 9 * * 1"}`, `{"type":"SCHEDULE","everyMs":900000}`, `{"type":"EVENT","eventType":"NEW_EMAIL"}`, `{"type":"MANUAL"}`, `{"type":"WEBHOOK"}` |
| A-T2 | unit | same | rejects `everyMs: 14999`, empty/missing `eventType`, an `eventType` outside the allow-list, an unknown `type`, and strips `eventType` from a SCHEDULE config |
| A-T3 | unit | same | `collectTriggerIssues` agrees with `WorkflowsService.validateTrigger` for every one of the 4 types (the "one rule, two callers" pin) |
| A-T4 | unit | `assist-write-tools.spec.ts` | `propose_graph` returns `ok:false` with a corrective `error` when `trigger` is unparseable / unsupported, and does **not** touch `draftDefinition` |
| A-T5 | e2e | `assist-agent.e2e-spec.ts` | a session whose scripted agent proposes an EVENT trigger persists `draftTriggerType: 'EVENT'` + `draftTriggerConfig.eventType` on `AssistSession` and still creates **no** `Workflow` row |
| A-T6 | e2e | `assist-sessions.e2e-spec.ts` | accept produces a `Workflow` with `triggerType: 'EVENT'` and `triggerConfig.eventType: 'NEW_EMAIL'` — **the regression test for the whole gap** |
| A-T7 | e2e | `assist-sessions.e2e-spec.ts` | POST `/accept` **twice** → same workflow id both times, and `prisma.workflow.count({ where: { assistSessionId } }) === 1` |
| A-T8 | unit | `workflow-readiness.spec.ts` | a MANUAL workflow whose step config contains `{{trigger.email}}` produces the new issue code and `TRIGGER` check ≠ `PASS`; a MANUAL workflow with no `{{trigger.*}}` reference still PASSes |
| A-T9 | e2e | `workflow-ux-simplification.e2e-spec.ts` | the `ready === (publish would succeed)` invariant still holds after A-8 — this suite already has the "agrees with publish" test; it must stay green |
| A-T10 | e2e | new or `per-employee-skill-connections.e2e-spec.ts` | an assist-accepted EVENT/`NEW_EMAIL` workflow, once ACTIVE, is picked up by the gmail-consumer query (`gmail-inbound.service.ts:262-268`) — i.e. the trigger really enables inbound polling |

**Credits (Part B)** — all scoped by `companyId`, all with explicit Convention-B cleanup, modelled on
`credits-phase3.e2e-spec.ts`.

| # | Kind | File | Assertion |
|---|---|---|---|
| B-T1 | e2e | new `credits-assist.e2e-spec.ts` | `CREDIT_LEDGER_ENABLED` **unset**: one assist turn creates **zero** `CreditReservation` and zero `CreditLedger` rows for that company (the byte-identical-to-before pin every credit call site has) |
| B-T2 | e2e | same | flag **on**: one assist turn opens exactly one reservation, `status === 'SETTLED'`, `resourceType === 'LLM_CALL'`, `Number(actualCredits) > 0`, and exactly **one** `CreditLedger` `DEBIT` with that `reservationId` |
| B-T3 | e2e | same | **two** turns in the **same** session produce **two** reservations with **different** `idempotencyKey`s — the test that catches the `"<companyId>:null:null"` collision trap |
| B-T4 | e2e | same | `UsageService.record` still writes a `UsageEvent` with `source: 'assist'` alongside the ledger rows (the additive guarantee) |
| B-T5 | e2e | same | with `CREDIT_ENFORCEMENT_ENABLED=true` + `Company.creditEnforcementEnabledAt` set + balance 0, the turn returns a graceful `stoppedBecause: 'credits'` reply (not a 409/500) and the reservation is `RELEASED`, not `SETTLED` |
| B-T6 | e2e | same | `GET /billing/credits/usage` returns the assist row for an OWNER (proving §B.5's "appears automatically") |

Run both engine modes for anything touching workflow execution
(`pnpm test` **and** `WORKFLOW_ENGINE_MODE=legacy_walk pnpm test`), and pin the providers explicitly per
`CLAUDE.md` or expect 78 configuration-only failures.

## Flagged as undetermined — decide, do not guess

1. **`NEW_EMAIL_REPLY` vs `EMAIL_REPLIED`** (§A.3). Two different strings, one in the canonical list with no
   producer, one with a producer and not in the list. The allow-list in A-2 depends on this.
2. **Which `eventType`s are in the assist allow-list** (§A.3). Only a subset of the 19 canonical types has a
   live producer; emitting one without a producer rebuilds the same silent-success defect.
3. **The exact idempotency anchor for an assist turn** (§B.3). The USER `AssistMessage.id` is the natural
   choice but is not returned by `AssistService.turn` and is **not created at all** on the
   `repeatsUnanswered` / empty-text-opens-the-stream path (`assist.service.ts:234-242`).
4. **Readiness severity for the MANUAL-but-expects-payload rule** (A-8): BLOCKER (requires `activate()` to
   enforce the same rule, to preserve `ready === publish`) or WARNING (safe, but softer).
5. **Whether to add `assistSessionId` columns** (B-4). No migration is *required*; filterable attribution on
   `/billing/usage` is the only thing it buys.
6. **`connectorId` for an assist-built EVENT trigger.** Pinning it to one `InstalledSkill.id` is what avoids
   the `assertNoConflictingEventTrigger` 409 when a tenant has two email connectors — but the agent has no
   tool that returns `InstalledSkill.id`s (`list_skills` returns `skillKey`, not the row id —
   `assist-read-tools.ts:114-145`). Leaving it unset is the back-compat default and is probably right for
   MVP; say so explicitly.
