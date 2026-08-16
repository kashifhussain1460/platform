import { randomBytes, randomUUID } from 'node:crypto';
import { InjectQueue } from '@nestjs/bullmq';
import {
  BadRequestException,
  ConflictException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { Prisma, type Workflow, type WorkflowRun } from '@prisma/client';
import type { Queue } from 'bullmq';
import { WORKFLOW_RUN_STATUSES } from '@vaep/types';
import type {
  Condition,
  FireEventResultDto,
  TriggerConfig,
  TriggerType,
  WorkflowDefinition,
  WorkflowDto,
  WorkflowRunDto,
  WorkflowRunStatus,
} from '@vaep/types';
import { isInlineExecution } from '../../common/resilience/workflow-execution-mode';
import { AuthorizationService } from '../authorization/authorization.service';
import { RunStateWriter } from '../workflow-runtime/run-state-writer.service';
import { EngineModeService } from '../workflow-runtime/engine-mode';
import {
  WF_ADVANCE_JOB,
  WF_RUN_ADVANCE_QUEUE,
  type AdvanceJobData,
} from '../workflow-runtime/workflow-runtime.constants';
import { PrismaService } from '../../common/prisma/prisma.service';
import { clampLimit } from '../../common/pagination';
import { AuditLogService } from '../audit/audit-log.service';
import { WorkflowPermissionService } from '../workflow-permissions/workflow-permissions.service';
import { WorkflowEngine } from './engine/workflow-engine.service';
import { evaluateConditions } from './engine/conditions';
import {
  validateDefinitionStructure,
  validateStorableDefinition,
} from './engine/definition-validator';
import { CreateWorkflowDto } from './dto/create-workflow.dto';
import { UpdateWorkflowDto } from './dto/update-workflow.dto';
import {
  MIN_SCHEDULE_MS,
  scheduleSlotKey,
  WORKFLOW_RUN_JOB,
  WORKFLOW_RUN_QUEUE,
  WORKFLOW_TRIGGER_JOB,
  type RunDispatchJob,
  type WorkflowRunJobData,
} from './workflows.constants';
import {
  STARTER_DEFINITION,
  toWorkflowDto,
  toWorkflowRunDto,
} from './workflows.mapper';

/** BullMQ job-scheduler id for a workflow's SCHEDULE repeatable job. */
function schedulerId(workflowId: string): string {
  return `wf:${workflowId}`;
}

/**
 * Terminal run states (doc 16 §7). Once a run is in one of these it must never
 * transition again — guards against terminal→terminal overwrites.
 */
const TERMINAL_RUN_STATUSES = new Set<string>([
  'COMPLETED',
  'FAILED',
  'CANCELLED',
  'TIMED_OUT',
  'COMPENSATED',
]);

/**
 * Tenant-scoped CRUD for workflows plus run creation and trigger/activation.
 *
 * A run is created PENDING and its execution is enqueued on the BullMQ
 * `workflow-run` queue (async); the WorkflowProcessor/WorkflowEngine walk the
 * graph. Every tenant query is scoped by companyId (from the JWT).
 *
 * Triggers (Steps 8/9/11): MANUAL keeps the existing POST /:id/run path.
 * ACTIVE workflows can also fire via a SCHEDULE (repeatable BullMQ job), a
 * public WEBHOOK (token URL), or an internal EVENT.
 */
@Injectable()
export class WorkflowsService {
  private readonly logger = new Logger(WorkflowsService.name);

  constructor(
    private readonly prisma: PrismaService,
    @InjectQueue(WORKFLOW_RUN_QUEUE)
    private readonly queue: Queue<WorkflowRunJobData>,
    private readonly auditLog: AuditLogService,
    // P3-06 — enqueue-time `workflow:run` authorization (doc 16 §21).
    private readonly permissions: WorkflowPermissionService,
    // Only used when WORKFLOW_EXECUTION_MODE=inline (no worker to hand off to).
    // Safe to inject: the engine does NOT depend on this service, so no cycle.
    private readonly engine: WorkflowEngine,
    // WAVE 1 — which engine this company's runs go to. From the leaf
    // EngineModeModule, NOT WorkflowRuntimeModule (which imports this module).
    private readonly engineMode: EngineModeService,
    @InjectQueue(WF_RUN_ADVANCE_QUEUE)
    private readonly advanceQueue: Queue<AdvanceJobData>,
    // WAVE 2 §2.2 — the single authorization layer (global leaf module).
    private readonly authz: AuthorizationService,
    // WAVE 1 §8 — the ONLY writer of run status, so resume/cancel emit their
    // outbox events like every other transition.
    private readonly runState: RunStateWriter,
  ) {}

  /**
   * Hand a run off for execution. `queue` mode enqueues for the persistent
   * worker; `inline` mode runs it here, because on a serverless-only deployment
   * there is no worker and an enqueued job would sit PENDING for ever (G40).
   *
   * Inline execution is AWAITED deliberately. Fire-and-forget would be frozen or
   * killed the moment the response is sent on a serverless host, which is the
   * exact environment this mode exists for. The observable consequence is that a
   * run may already be COMPLETED when the create response arrives — polling
   * clients simply find it finished, which is harmless.
   */
  private async dispatchRun(
    job: RunDispatchJob,
    companyId: string,
  ): Promise<void> {
    // WAVE 1 (gap W1-a) — THE cutover. Until this line existed the durable
    // runtime was unreachable code: its workers booted, subscribed to
    // `wf-run-advance`, and idled for ever because nothing produced to that
    // queue. `EngineModeService` defaults every company to `legacy_walk`, so
    // this changes nothing until a tenant is opted in — and rolling back is
    // clearing an env var, not shipping a deploy.
    if (this.engineMode.usesStateMachine(companyId)) {
      await this.dispatchDurable(job, companyId);
      return;
    }

    if (!isInlineExecution()) {
      await this.queue.add(WORKFLOW_RUN_JOB, job, {
        removeOnComplete: true,
        removeOnFail: 100,
      });
      return;
    }

    try {
      if (job.resume) await this.engine.resume(job.runId);
      else await this.engine.execute(job.runId);
    } catch (err) {
      // The engine records a node failure as a FAILED run — a terminal domain
      // outcome the poller reads. So a throw here is an infrastructure problem,
      // and it must NOT turn the caller's "start this run" request into a 500:
      // the run row exists and its status is authoritative.
      this.logger.error(
        `inline execution failed (company=${companyId}): ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    }
  }

  /**
   * Hand a run to the DURABLE state machine: enqueue one `advance` job and stop.
   *
   * There is deliberately no "execute" call here. The state machine decides what
   * to do next by reading Postgres, so the producer's only job is to wake it —
   * which is also why a duplicate dispatch is harmless: two advances for the
   * same run take the run's advisory lock in turn and the second finds the work
   * already done.
   *
   * WAVE 1 (G-B1): this used to fall back to the legacy `workflow-run` queue for
   * a `{workflowId, source}` job, because a SCHEDULE fire had no run yet and the
   * legacy engine created it. Schedules now create their run through
   * `fireSchedule` → `enqueueRun` like every other trigger, so a dispatch
   * without a runId can no longer happen and the fallback is gone with it.
   */
  private async dispatchDurable(
    job: RunDispatchJob,
    companyId: string,
  ): Promise<void> {
    await this.advanceQueue.add(
      WF_ADVANCE_JOB,
      { runId: job.runId, companyId },
      {
        removeOnComplete: true,
        removeOnFail: 100,
      },
    );
  }

  // --- CRUD ----------------------------------------------------------------

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
        definition: (dto.definition ??
          STARTER_DEFINITION) as unknown as Prisma.InputJsonObject,
        // P3-06 — the creator owns it (may manage its permissions even as a MEMBER).
        ownerUserId: actorUserId ?? null,
        // WAVE 2 §2.1 — the department axis authorization scopes on. Until now
        // `category` could only be set by a template install, so a hand-authored
        // workflow had nothing for department isolation to isolate on.
        category: dto.category ?? null,
      },
    });
    await this.auditLog.record({
      companyId,
      actorUserId,
      action: 'workflow.create',
      entityType: 'Workflow',
      entityId: workflow.id,
      metadata: { name: workflow.name },
    });
    return toWorkflowDto(workflow);
  }

  async list(
    companyId: string,
    limitRaw?: unknown,
    actorUserId?: string,
  ): Promise<WorkflowDto[]> {
    const workflows = await this.prisma.workflow.findMany({
      // Scratch workflows exist only so the AI Assist can dry-run a draft
      // through the real engine (doc 30 §13.1). They are created and deleted
      // within one tool call and must never appear in the user's list.
      where: { companyId, isAssistScratch: false },
      orderBy: { createdAt: 'desc' },
      take: clampLimit(limitRaw),
    });

    // WAVE 2 §2.1 — the LIST must apply the same rule as the detail read.
    // A list that shows names the detail endpoint then denies is still a leak:
    // "HR — Terminations checklist" tells a Marketing admin what they should not
    // know, even when opening it 403s.
    const actor = await this.authz.actorById(companyId, actorUserId);
    const visible = actor
      ? await this.authz.filter(actor, 'workflow:read', workflows, (wf) => ({
          type: 'workflow' as const,
          companyId,
          id: wf.id,
          scope: wf.category,
          ownerUserId: wf.ownerUserId,
        }))
      : workflows;
    return visible.map(toWorkflowDto);
  }

  async get(
    companyId: string,
    id: string,
    actorUserId?: string,
  ): Promise<WorkflowDto> {
    const workflow = await this.findOwned(companyId, id);
    await this.assertScope(companyId, actorUserId, workflow, 'workflow:read');
    return toWorkflowDto(workflow);
  }

  /**
   * Department-scope a loaded workflow (WAVE 2 §2.1).
   *
   * Deliberately AFTER the row is loaded: the rule depends on the resource's
   * own `category`, which a route guard cannot know. `actorUserId` absent means
   * a machine caller (the engine, a template installer) that was authorized at
   * its own entry point and has no human to scope to.
   */
  private async assertScope(
    companyId: string,
    actorUserId: string | undefined,
    workflow: Workflow,
    action: 'workflow:read' | 'workflow:run' | 'workflow:update',
  ): Promise<void> {
    const actor = await this.authz.actorById(companyId, actorUserId);
    if (!actor) return;
    await this.authz.assert(actor, action, {
      type: 'workflow',
      companyId,
      id: workflow.id,
      scope: workflow.category,
      ownerUserId: workflow.ownerUserId,
    });
  }

  async update(
    companyId: string,
    id: string,
    dto: UpdateWorkflowDto,
    actorUserId?: string,
  ): Promise<WorkflowDto> {
    const existing = await this.findOwned(companyId, id);

    // Optimistic concurrency (opt-in): if the caller tells us what `updatedAt`
    // they last read and it doesn't match, someone else saved in between —
    // 409 instead of silently overwriting their change (two tabs/people
    // editing the same workflow previously had zero conflict signal).
    if (
      dto.expectedUpdatedAt !== undefined &&
      dto.expectedUpdatedAt !== existing.updatedAt.toISOString()
    ) {
      throw new ConflictException(
        'This workflow was changed by someone else since you loaded it. Reload and re-apply your edit.',
      );
    }

    // Validate the trigger shape when either trigger field is being changed.
    if (dto.triggerType !== undefined || dto.triggerConfig !== undefined) {
      const type = (dto.triggerType ?? existing.triggerType) as TriggerType;
      const config =
        dto.triggerConfig ?? (existing.triggerConfig as TriggerConfig | null);
      this.validateTrigger(type, config);
    }
    this.validateStorable(dto.definition);

    const workflow = await this.prisma.workflow.update({
      where: { id },
      data: {
        name: dto.name,
        description: dto.description,
        status: dto.status,
        triggerType: dto.triggerType,
        triggerConfig:
          dto.triggerConfig === undefined
            ? undefined
            : (dto.triggerConfig as Prisma.InputJsonObject),
        definition:
          dto.definition === undefined
            ? undefined
            : (dto.definition as unknown as Prisma.InputJsonObject),
        // WAVE 2 §2.1 — undefined leaves it alone; explicit null makes the
        // workflow company-wide (visible to every department) again.
        category: dto.category === undefined ? undefined : dto.category,
      },
    });
    await this.auditLog.record({
      companyId,
      actorUserId,
      action: 'workflow.update',
      entityType: 'Workflow',
      entityId: workflow.id,
      metadata: { changedFields: Object.keys(dto) },
    });
    return toWorkflowDto(workflow);
  }

  /**
   * SOFT delete (gap G29). Sets `status = ARCHIVED` and keeps the workflow row,
   * every WorkflowRun and every WorkflowStepRun.
   *
   * This used to be `prisma.workflow.delete()`, which cascaded
   * (`WorkflowRun.workflow` and `WorkflowStepRun.run` both declare
   * `onDelete: Cascade`) and silently destroyed the entire execution history.
   * An AuditLog row recorded *that* a deletion happened but could not recover
   * what it erased — so "show me every CV screening decision from Q1" stopped
   * being answerable the moment somebody tidied up an old workflow.
   *
   * Refuses with 409 while any run is still in flight: archiving a workflow out
   * from under a PENDING/RUNNING/WAITING run would strand it against a
   * definition that can no longer be activated or edited.
   *
   * `hard: true` is the genuine-erasure escape hatch (data-subject deletion
   * requests). It is caller-gated to platform admins in the controller, is
   * still blocked on in-flight runs, and is audited separately.
   */
  async remove(
    companyId: string,
    id: string,
    actorUserId?: string,
    opts: { hard?: boolean } = {},
  ): Promise<void> {
    const existing = await this.findOwned(companyId, id);

    const activeRuns = await this.prisma.workflowRun.count({
      where: {
        companyId,
        workflowId: id,
        status: { in: ['PENDING', 'RUNNING', 'WAITING'] },
      },
    });
    if (activeRuns > 0) {
      throw new ConflictException(
        `Cannot delete workflow "${existing.name}": ${activeRuns} run(s) still in flight. ` +
          `Wait for them to finish or cancel them first.`,
      );
    }

    // Best-effort: drop any repeatable schedule so it doesn't fire post-delete.
    if (existing.triggerType === 'SCHEDULE') {
      await this.removeSchedule(id);
    }

    if (opts.hard) {
      // Cascades to runs and their step runs (onDelete: Cascade). Irreversible.
      await this.prisma.workflow.delete({ where: { id } });
      this.logger.warn(
        `workflow.hard_delete workflow=${id} company=${companyId} actor=${actorUserId ?? 'unknown'} ` +
          `name="${existing.name}" — execution history permanently destroyed`,
      );
      await this.auditLog.record({
        companyId,
        actorUserId,
        action: 'workflow.hard_delete',
        entityType: 'Workflow',
        entityId: id,
        metadata: { name: existing.name, historyDestroyed: true },
      });
      return;
    }

    if (existing.status === 'ARCHIVED') {
      // Idempotent: DELETE is expected to be safe to repeat.
      return;
    }

    await this.prisma.workflow.update({
      where: { id },
      data: { status: 'ARCHIVED', activatedAt: null },
    });
    this.logger.log(
      `workflow.archive workflow=${id} company=${companyId} actor=${actorUserId ?? 'unknown'} ` +
        `name="${existing.name}" (run history retained)`,
    );
    await this.auditLog.record({
      companyId,
      actorUserId,
      action: 'workflow.archive',
      entityType: 'Workflow',
      entityId: id,
      metadata: { name: existing.name, previousStatus: existing.status },
    });
  }

  // --- Activation (Steps 8/9) ---------------------------------------------

  /**
   * Activate a workflow: require ≥1 runnable (non-TRIGGER) node, set ACTIVE +
   * activatedAt. SCHEDULE → add a repeatable job; WEBHOOK → ensure a token.
   */
  async activate(companyId: string, id: string): Promise<WorkflowDto> {
    const existing = await this.findOwned(companyId, id);

    this.assertNotArchived(existing, 'activate');

    if (!this.hasRunnableSteps(existing.definition)) {
      throw new BadRequestException(
        'Add at least one step (beyond the trigger) before activating',
      );
    }
    // Readiness is enforced here rather than at save time (see
    // `validateStorable`), so activating is where a half-finished graph is
    // refused. Skipped when a published version is pinned — publish already ran
    // the same check on it, and this field is only the fallback graph.
    if (!existing.activeVersionId) {
      this.assertRunnable(existing.definition);
    }

    const type = existing.triggerType as TriggerType;
    const config = existing.triggerConfig as TriggerConfig | null;
    this.validateTrigger(type, config);

    // Two EVENT workflows on the same event + overlapping connector would BOTH
    // fire on every matching event (the Gmail double-fire footgun). Refuse to
    // activate a second one; the author must deactivate the other or scope each
    // to a different connector.
    if (type === 'EVENT') {
      await this.assertNoConflictingEventTrigger(companyId, id, config);
    }

    // Generate a webhook token on first WEBHOOK activation (crypto-random).
    const webhookToken =
      type === 'WEBHOOK' && !existing.webhookToken
        ? randomBytes(24).toString('hex')
        : undefined;

    const workflow = await this.prisma.workflow.update({
      where: { id },
      data: {
        status: 'ACTIVE',
        activatedAt: new Date(),
        ...(webhookToken ? { webhookToken } : {}),
      },
    });

    if (type === 'SCHEDULE') {
      await this.addSchedule(companyId, id, config);
    }

    return toWorkflowDto(workflow);
  }

  /** Deactivate: set PAUSED and remove any SCHEDULE repeatable job. */
  async deactivate(companyId: string, id: string): Promise<WorkflowDto> {
    const existing = await this.findOwned(companyId, id);
    if (existing.triggerType === 'SCHEDULE') {
      await this.removeSchedule(id);
    }
    const workflow = await this.prisma.workflow.update({
      where: { id },
      data: { status: 'PAUSED' },
    });
    return toWorkflowDto(workflow);
  }

  /**
   * Reject activating an EVENT workflow when another ACTIVE EVENT workflow already
   * listens for the same eventType with an overlapping connector scope. Two such
   * workflows would both fire on every matching event. Scopes overlap unless BOTH
   * are pinned to a different `connectorId` (an unscoped trigger matches every
   * connector, so it overlaps everything of that eventType).
   */
  private async assertNoConflictingEventTrigger(
    companyId: string,
    selfId: string,
    config: TriggerConfig | null,
  ): Promise<void> {
    const eventType = config?.eventType;
    if (!eventType) return;
    const myConnector = config?.connectorId ?? null;
    const others = await this.prisma.workflow.findMany({
      where: {
        companyId,
        status: 'ACTIVE',
        triggerType: 'EVENT',
        id: { not: selfId },
        triggerConfig: { path: ['eventType'], equals: eventType },
      },
      select: { name: true, triggerConfig: true },
    });
    for (const other of others) {
      const otherConnector =
        ((other.triggerConfig ?? null) as TriggerConfig | null)?.connectorId ?? null;
      const overlaps =
        myConnector == null ||
        otherConnector == null ||
        myConnector === otherConnector;
      if (overlaps) {
        throw new ConflictException(
          `"${other.name}" is already live on the same trigger (${eventType}` +
            `${myConnector ? '' : ', all connectors'}). Two workflows on the same ` +
            `event would both fire on every event. Deactivate it first, or scope ` +
            `each workflow to a different connector.`,
        );
      }
    }
  }

  // --- Event / webhook firing (Step 11) -----------------------------------

  /**
   * Fire an internal event: enqueue a run for every ACTIVE EVENT workflow whose
   * triggerConfig.eventType matches AND whose optional condition DSL (docs §5.2)
   * passes against the fired payload. Returns the matched count + created runIds.
   *
   * Correlation/lineage (docs §9): when the payload carries an `eventId` (the
   * CanonicalEvent id, set by the normalization pipeline), each created run gets
   * `triggerEventId` = that id and `correlationId` = that id, so a single
   * correlationId ties event→run→steps. A manual fire (no eventId) still gets a
   * generated correlationId so every run is traceable.
   */
  async fireEvent(
    companyId: string,
    eventType: string,
    payload?: Record<string, unknown>,
    connectorId?: string,
  ): Promise<FireEventResultDto> {
    const workflows = await this.prisma.workflow.findMany({
      where: {
        companyId,
        status: 'ACTIVE',
        triggerType: 'EVENT',
        triggerConfig: { path: ['eventType'], equals: eventType },
      },
    });

    const safePayload = payload ?? {};
    const eventId =
      typeof safePayload.eventId === 'string' ? safePayload.eventId : null;

    const runIds: string[] = [];
    for (const wf of workflows) {
      // Connector-scoped triggers (per-employee skill connections) only fire for
      // events from THEIR OWN connector; a trigger with no connectorId keeps
      // matching every connector of this eventType — today's exact behavior.
      const cfg = (wf.triggerConfig ?? null) as TriggerConfig | null;
      if (cfg?.connectorId && cfg.connectorId !== connectorId) {
        continue;
      }
      // Richer EVENT filtering: a workflow fires only if ALL its conditions pass
      // (empty/absent → always fire, so existing EVENT workflows are unaffected).
      const conditions = this.extractConditions(wf.triggerConfig);
      if (!evaluateConditions(conditions, safePayload)) {
        continue;
      }
      const run = await this.enqueueRun(wf.companyId, wf.id, 'EVENT', payload, {
        triggerEventId: eventId,
        // undefined → enqueueRun generates one (manual fire with no eventId).
        correlationId: eventId ?? undefined,
        // Same canonical event must not fire the same workflow twice (P0-2).
        idempotencyKey: eventId ? `event:${wf.id}:${eventId}` : null,
      });
      runIds.push(run.id);
    }
    return { eventType, count: runIds.length, runIds };
  }

  /** Read a workflow's EVENT condition list from its persisted triggerConfig. */
  private extractConditions(config: Prisma.JsonValue): Condition[] {
    const cfg = (config ?? null) as TriggerConfig | null;
    return Array.isArray(cfg?.conditions) ? (cfg.conditions as Condition[]) : [];
  }

  /**
   * Fire a public webhook by token (no JWT; tenant = the workflow's company).
   * 404 unless the token maps to an ACTIVE WEBHOOK workflow.
   */
  async fireWebhook(
    token: string,
    payload?: Record<string, unknown>,
    idempotencyKey?: string | null,
  ): Promise<WorkflowRunDto> {
    const workflow = await this.prisma.workflow.findUnique({
      where: { webhookToken: token },
    });
    if (
      !workflow ||
      workflow.status !== 'ACTIVE' ||
      workflow.triggerType !== 'WEBHOOK'
    ) {
      throw new NotFoundException('Webhook not found');
    }
    // A provider delivery id (or explicit Idempotency-Key) namespaced to the
    // webhook makes a redelivery a no-op instead of a duplicate run (P0-2).
    return this.enqueueRun(workflow.companyId, workflow.id, 'WEBHOOK', payload, {
      idempotencyKey: idempotencyKey ? `webhook:${token}:${idempotencyKey}` : null,
    });
  }

  // --- Runs ----------------------------------------------------------------

  /** Create a PENDING run and enqueue its async execution; returns the run. */
  async createRun(
    companyId: string,
    id: string,
    actingUserId: string,
    trigger?: Record<string, unknown>,
    dryRun?: boolean,
    idempotencyKey?: string | null,
  ): Promise<WorkflowRunDto> {
    const existing = await this.findOwned(companyId, id);
    this.assertNotArchived(existing, 'run');
    // WAVE 2 §2.1 — running is the side-effecting action, so it is scoped as
    // well as read. A Marketing admin must not be able to fire an HR workflow
    // just because they learned its id.
    await this.assertScope(companyId, actingUserId, existing, 'workflow:run');
    // Drafts are allowed to be incomplete (see `validateStorable`), so the
    // readiness check moved here. Without it, relaxing save-time validation
    // would let someone POST a run for a half-built graph — the disabled Run
    // button in the builder is a hint, not a control.
    if (!existing.activeVersionId) {
      this.assertRunnable(existing.definition);
    }
    // MANUAL run: the subject is the clicking user (doc 09 §9.C.3).
    return this.enqueueRun(companyId, id, 'MANUAL', trigger, {
      dryRun,
      subjectUserId: actingUserId,
      // Namespaced to the workflow so the same client key can't collide across
      // workflows; a double-click / retry then returns the same run (P1-2).
      idempotencyKey: idempotencyKey ? `run:${id}:${idempotencyKey}` : null,
    });
  }

  async listRuns(
    companyId: string,
    id: string,
    limitRaw?: unknown,
  ): Promise<WorkflowRunDto[]> {
    await this.findOwned(companyId, id);
    const runs = await this.prisma.workflowRun.findMany({
      where: { companyId, workflowId: id },
      orderBy: { createdAt: 'desc' },
      take: clampLimit(limitRaw),
    });
    return runs.map((r) => toWorkflowRunDto(r));
  }

  /**
   * Every run in the tenant, newest first — the cross-workflow operations view.
   *
   * The workflow NAME is joined in rather than fetched per row: an operations
   * table of 100 runs would otherwise be 100 extra requests. An unrecognised
   * `status` filter is ignored rather than rejected, so a stale bookmark degrades
   * to "all runs" instead of a 400.
   */
  async listAllRuns(
    companyId: string,
    filters: { status?: string; workflowId?: string; limit?: unknown } = {},
  ): Promise<WorkflowRunDto[]> {
    const status = WORKFLOW_RUN_STATUSES.includes(
      filters.status as WorkflowRunStatus,
    )
      ? (filters.status as WorkflowRunStatus)
      : undefined;

    const runs = await this.prisma.workflowRun.findMany({
      where: {
        companyId,
        ...(status ? { status } : {}),
        ...(filters.workflowId ? { workflowId: filters.workflowId } : {}),
      },
      orderBy: { createdAt: 'desc' },
      take: clampLimit(filters.limit),
      include: { workflow: { select: { name: true } } },
    });

    return runs.map((r) => ({
      ...toWorkflowRunDto(r),
      workflowName: r.workflow?.name,
    }));
  }

  /** A single run WITH its step runs (for polling). Tenant-scoped. */
  async getRun(companyId: string, runId: string): Promise<WorkflowRunDto> {
    const run = await this.prisma.workflowRun.findFirst({
      where: { id: runId, companyId },
      include: { steps: { orderBy: { createdAt: 'asc' } } },
    });
    if (!run) {
      throw new NotFoundException('Workflow run not found');
    }
    return toWorkflowRunDto(run);
  }

  /**
   * Resume a WAITING run whose APPROVAL was approved. Flip it to RUNNING and
   * enqueue a `{runId, resume:true}` job so the engine continues from
   * `resumeNodeId` with the persisted context. Idempotent: a run that is not
   * WAITING is ignored (a double-approve cannot double-run). Called by
   * ApprovalService when a WORKFLOW-kind request is approved.
   */
  async resumeRun(runId: string, companyId: string): Promise<void> {
    // Tenant-scoped by (id, companyId) so a runId from one tenant can never
    // resume another tenant's run even if a future caller forgets to check.
    const run = await this.prisma.workflowRun.findFirst({
      where: { id: runId, companyId },
    });
    if (!run || run.status !== 'WAITING') {
      return;
    }
    // WAVE 1 §8 → closed: go through RunStateWriter so the transition is
    // guarded AND emits its outbox event. Writing `status` directly here meant
    // a resumed run produced no `run.resumed` event, so the realtime stream
    // (WAVE 5) showed a run frozen at WAITING until its next step finished.
    await this.runState.transitionRun({
      runId,
      companyId: run.companyId,
      to: 'RUNNING',
      error: null,
      event: 'run.resumed',
    });
    await this.dispatchRun(
      { runId, resume: true, companyId: run.companyId },
      run.companyId,
    );
  }

  /**
   * Cancel a non-terminal run (used when a WORKFLOW-kind approval is rejected):
   * mark it FAILED with the reason and clear its resume pointer. A run already
   * COMPLETED/FAILED is left untouched. Called by ApprovalService on reject.
   */
  async cancelRun(
    runId: string,
    reason: string,
    companyId: string,
    // WAVE 1 (G-B4): the taxonomy, not free text. Without it every approval
    // rejection and every SLA expiry was indistinguishable from a node crash in
    // `workflow_failure_total{failure_class}` and in any "why did this fail"
    // query — the two most common non-technical failures were invisible.
    failureClass: 'APPROVAL_REJECTED' | 'TIMEOUT' | 'CANCELLED' = 'APPROVAL_REJECTED',
  ): Promise<void> {
    const run = await this.prisma.workflowRun.findFirst({
      where: { id: runId, companyId },
    });
    // Never overwrite ANY terminal state. Previously only COMPLETED/FAILED were
    // guarded, so a reject / SLA-expire / auto-reject arriving after a user
    // CANCELLED (or a TIMED_OUT) run would illegally rewrite it to FAILED — a
    // terminal→terminal transition the doc 16 §7 state table forbids.
    if (!run || TERMINAL_RUN_STATUSES.has(run.status)) {
      return;
    }
    // Same reason as resumeRun: guarded + emits `run.failed` for the stream.
    await this.runState.transitionRun({
      runId,
      companyId: run.companyId,
      to: 'FAILED',
      error: reason,
      failureClass,
      resumeNodeId: null,
      event: 'run.failed',
    });
  }

  /**
   * User-initiated cancel of a non-terminal run (privileged + audited). Authoritative
   * for PENDING and WAITING runs; a RUNNING run's current step may still finish (the
   * engine is not yet cancellation-aware mid-step).
   */
  async cancelRunByUser(
    companyId: string,
    runId: string,
    userId: string,
  ): Promise<WorkflowRunDto> {
    const run = await this.prisma.workflowRun.findFirst({
      where: { id: runId, companyId },
      select: { status: true },
    });
    if (!run) {
      throw new NotFoundException('Workflow run not found');
    }
    if (
      run.status === 'COMPLETED' ||
      run.status === 'FAILED' ||
      run.status === 'CANCELLED' ||
      run.status === 'TIMED_OUT'
    ) {
      throw new ConflictException('This run has already finished.');
    }
    // WAVE 1 (G-B2) — go through RunStateWriter.
    //
    // The previous code did a plain `prisma.workflowRun.update`, which broke
    // BOTH of the writer's invariants at once:
    //
    //   1. the status read above and this write were separate statements, so a
    //      worker finishing the run in the gap was silently stomped back to
    //      CANCELLED — a terminal→terminal transition the §7 state table forbids;
    //   2. no outbox row, so `run.cancelled` — a declared event type — was
    //      emitted by NOTHING. The realtime stream showed a cancelled run frozen
    //      on its last step until someone reloaded the page.
    //
    // `transitionRun` returns false when the run already moved on, which turns
    // the race into the same 409 the caller would have got a moment earlier.
    const cancelled = await this.runState.transitionRun({
      runId,
      companyId,
      to: 'CANCELLED',
      error: 'Cancelled by a user',
      failureClass: 'CANCELLED',
      resumeNodeId: null,
      event: 'run.cancelled',
    });
    if (!cancelled) {
      throw new ConflictException('This run has already finished.');
    }
    await this.auditLog.record({
      companyId,
      actorUserId: userId,
      action: 'workflow.run.cancel',
      entityType: 'WorkflowRun',
      entityId: runId,
    });
    return this.getRun(companyId, runId);
  }

  /**
   * Retry a run by starting a FRESH run of the same workflow with the same trigger
   * input — never resurrects the old run (two histories in one row would destroy
   * the audit trail). Re-checks run permission via createRun.
   */
  async retryRun(
    companyId: string,
    runId: string,
    userId: string,
  ): Promise<WorkflowRunDto> {
    const run = await this.prisma.workflowRun.findFirst({
      where: { id: runId, companyId },
      select: { workflowId: true, trigger: true, dryRun: true },
    });
    if (!run) {
      throw new NotFoundException('Workflow run not found');
    }
    const trigger = (run.trigger as Record<string, unknown> | null) ?? undefined;
    return this.createRun(companyId, run.workflowId, userId, trigger, run.dryRun);
  }

  /** Test/introspection hook: the queue's registered job schedulers. */
  listSchedulers() {
    return this.queue.getJobSchedulers();
  }

  // --- Internals -----------------------------------------------------------

  /**
   * Create a run with the given source + enqueue a `{runId}` job. Every run gets
   * a `correlationId` (docs §9): the caller supplies the triggering eventId for
   * EVENT runs; otherwise a crypto-random id is generated so manual/schedule/
   * webhook runs are equally traceable. `triggerEventId` is the CanonicalEvent id
   * for EVENT runs (the lineage join key) and null for the rest.
   */
  private async enqueueRun(
    companyId: string,
    workflowId: string,
    source: string,
    trigger?: Record<string, unknown>,
    opts?: {
      triggerEventId?: string | null;
      correlationId?: string;
      dryRun?: boolean;
      subjectUserId?: string | null;
      idempotencyKey?: string | null;
    },
  ): Promise<WorkflowRunDto> {
    // Idempotency (P0-2 webhook / P1-2 run): a caller-supplied key dedups
    // retries and provider redeliveries within a tenant. A run already created
    // for this (companyId, key) is returned as-is — its side effects fire once.
    // Absent key → no dedup (back-compat: existing callers are unaffected).
    const idempotencyKey = opts?.idempotencyKey ?? null;
    if (idempotencyKey) {
      const prior = await this.prisma.workflowRun.findUnique({
        where: { companyId_idempotencyKey: { companyId, idempotencyKey } },
      });
      if (prior) return toWorkflowRunDto(prior);
    }
    // P1-02 (gap G1): pin the exact graph this run will execute. Null is a
    // legitimate value for a workflow that predates versioning and has not been
    // backfilled — the engine then falls back to Workflow.definition rather
    // than refusing to run, so no existing automation breaks.
    const pinned = await this.prisma.workflow.findFirst({
      where: { id: workflowId, companyId },
      select: {
        activeVersionId: true,
        activeVersion: { select: { publishedById: true } },
      },
    });

    // P3-06 (doc 16 §21): `workflow:run` is authorised HERE, at enqueue — not per
    // attempt. The run-as subject is the clicking user (MANUAL) or the pinned
    // version's publisher, role re-resolved fresh (SCHEDULE/EVENT/WEBHOOK, §9.C.3).
    const subjectUserId =
      source === 'MANUAL'
        ? opts?.subjectUserId ?? null
        : pinned?.activeVersion?.publishedById ?? null;
    await this.permissions.assertCanRun(companyId, workflowId, subjectUserId);

    let run: WorkflowRun;
    try {
      run = await this.prisma.workflowRun.create({
        data: {
          companyId,
          workflowId,
          workflowVersionId: pinned?.activeVersionId ?? null,
          status: 'PENDING',
          source,
          dryRun: opts?.dryRun ?? false,
          // Who started it (MANUAL = the clicking user; automated triggers = system).
          startedByUserId: source === 'MANUAL' ? subjectUserId : null,
          trigger:
            trigger === undefined
              ? Prisma.JsonNull
              : (trigger as Prisma.InputJsonObject),
          triggerEventId: opts?.triggerEventId ?? null,
          correlationId: opts?.correlationId ?? randomUUID(),
          idempotencyKey,
        },
      });
    } catch (e) {
      // Concurrent request with the same idempotency key won the create race.
      // Return the winner rather than dispatching a duplicate run.
      if (
        idempotencyKey &&
        e instanceof Prisma.PrismaClientKnownRequestError &&
        e.code === 'P2002'
      ) {
        const winner = await this.prisma.workflowRun.findUnique({
          where: { companyId_idempotencyKey: { companyId, idempotencyKey } },
        });
        if (winner) return toWorkflowRunDto(winner);
      }
      throw e;
    }

    await this.dispatchRun({ runId: run.id, companyId }, companyId);

    // Re-read: inline execution has already moved the run on (often to a
    // terminal state), so returning the pre-dispatch row would report a status
    // that is already stale.
    const settled = isInlineExecution()
      ? ((await this.prisma.workflowRun.findUnique({ where: { id: run.id } })) ??
        run)
      : run;
    return toWorkflowRunDto(settled);
  }

  /**
   * Sweep runs orphaned by a process that died mid-execution.
   *
   * Normally driven by a BullMQ repeatable; exposed here so a platform scheduler
   * can drive it too, because repeatables never fire without a persistent worker
   * (see `workflow-execution-mode.ts`). Thin pass-through so the admin surface
   * talks to this service rather than reaching into the engine.
   */
  sweepStuckRuns(): Promise<{ swept: number }> {
    return this.engine.sweepStuckRuns();
  }

  /**
   * Fire one workflow as if its schedule had elapsed. Same reasoning as
   * {@link sweepStuckRuns}: the repeatable that normally does this needs a
   * worker that a serverless deployment does not have.
   */
  async fireScheduled(workflowId: string): Promise<void> {
    await this.fireSchedule(workflowId, 'SCHEDULE');
  }

  /**
   * WAVE 1 (gap G-B1) — THE canonical SCHEDULE entry point.
   *
   * This used to be `WorkflowEngine.trigger()`, which called
   * `prisma.workflowRun.create()` directly. That single line meant a scheduled
   * run was the ONLY kind of run in the system that got:
   *
   *   - no `workflowVersionId`, so it executed `Workflow.definition` — the
   *     MUTABLE draft column — instead of the pinned immutable version. Editing
   *     a workflow changed what its next scheduled run did, with no publish;
   *   - no `idempotencyKey`, so the two schedule drivers could each produce a
   *     run for the same occurrence;
   *   - no `workflow:run` authorization, so a workflow restricted by
   *     `WorkflowPermission` ran anyway on its schedule, and a DISABLED
   *     publisher's schedule kept firing after their access was revoked.
   *
   * Routing it through `enqueueRun` fixes all three at once, because all three
   * already live there for every other trigger type.
   */
  async fireSchedule(workflowId: string, source = 'SCHEDULE'): Promise<void> {
    const workflow = await this.prisma.workflow.findUnique({
      where: { id: workflowId },
      select: {
        id: true,
        companyId: true,
        triggerConfig: true,
        status: true,
        archivedAt: true,
      },
    });
    if (!workflow) {
      this.logger.warn(`Scheduled workflow ${workflowId} not found; skipping`);
      return;
    }

    // Defence in depth. `deactivate()` removes the BullMQ repeatable, and the
    // cron sweep already filters on ACTIVE — but a repeatable that outlives its
    // removal (a Redis restore from backup, a failed removeSchedule) would
    // otherwise keep running a workflow its owner had switched OFF. A paused
    // automation that still sends email is the worst kind of surprise.
    if (workflow.status !== 'ACTIVE' || workflow.archivedAt) {
      this.logger.warn(
        `Scheduled fire skipped for workflow=${workflowId}: status=${workflow.status}` +
          `${workflow.archivedAt ? ' archived' : ''}`,
      );
      return;
    }

    try {
      await this.enqueueRun(workflow.companyId, workflow.id, source, undefined, {
        idempotencyKey: scheduleSlotKey(
          workflow.id,
          workflow.triggerConfig as { everyMs?: unknown } | null,
          Date.now(),
        ),
      });
    } catch (err) {
      // A schedule fire is a background job with no caller to receive a 403.
      // `assertCanRun` throwing here is a legitimate outcome — the workflow is
      // restricted and its run subject is no longer allowed to run it — so it
      // must be logged and swallowed, not left to fail the queue job and be
      // retried forever against a permission that will not change.
      this.logger.warn(
        `Scheduled fire refused for workflow=${workflowId} company=${workflow.companyId}: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    }
  }

  /**
   * Create a throwaway workflow so the AI Assist can dry-run a draft through the
   * REAL engine (doc 30 §13.1).
   *
   * A real row rather than a virtual execution: the engine runs from a persisted
   * `Workflow` + `WorkflowRun`, and inventing a parallel in-memory path would
   * fork engine behaviour — at which point the "test" stops testing the thing
   * that actually runs.
   *
   * Marked `isAssistScratch` so it is excluded from `list()`, and the caller
   * deletes it in a `finally`. Deliberately NOT activated: it exists to be run
   * once, dry, and thrown away.
   */
  async createAssistScratch(
    companyId: string,
    definition: WorkflowDefinition,
    actorUserId: string,
  ): Promise<{ id: string }> {
    this.validateDefinition(definition);
    return this.prisma.workflow.create({
      data: {
        companyId,
        name: '[assist test]',
        status: 'ACTIVE', // runnable without going through activate()
        definition: definition as unknown as Prisma.InputJsonObject,
        ownerUserId: actorUserId,
        isAssistScratch: true,
      },
      select: { id: true },
    });
  }

  /** True when the definition has ≥1 node that is not a TRIGGER. */
  private hasRunnableSteps(definition: Prisma.JsonValue): boolean {
    const def = (definition ?? {}) as Partial<WorkflowDefinition>;
    const nodes = Array.isArray(def.nodes) ? def.nodes : [];
    return nodes.some((n) => n?.type && n.type !== 'TRIGGER');
  }

  /**
   * Structural sanity checks beyond the DTO's per-field shape validation.
   * A duplicate node id would let the LAST one silently win at run time
   * (`nodesById` is built as a Map, keyed by id) — the other becomes
   * unreachable dead code with no error anywhere. An edge referencing an
   * unknown node id makes a run silently stop early (`nodesById.get(...)`
   * resolves to `undefined`, and the engine's walk just ends) instead of
   * failing loudly. Both are rejected at SAVE time, where a clear 400 is far
   * more useful than a silently wrong run later.
   */
  private validateDefinition(definition: WorkflowDefinition | undefined): void {
    if (!definition) {
      return;
    }
    validateDefinitionStructure(definition);
  }

  /**
   * SAVE-time validation for create/update — integrity only.
   *
   * A workflow the customer is still drawing is incomplete by definition. The
   * builder autosaves after every canvas change, so running the full readiness
   * check here meant that dropping a node made the whole draft unsaveable until
   * every field on it was filled in: the canvas showed "Couldn't save — retry"
   * and everything after that point was lost on refresh. Readiness is enforced
   * where it matters — publish, activate and run (`assertRunnable` below), so
   * an unfinished graph still cannot execute. Found by driving the real builder
   * in a browser (WAVE 7).
   */
  private validateStorable(definition: WorkflowDefinition | undefined): void {
    if (!definition) {
      return;
    }
    validateStorableDefinition(definition);
  }

  /**
   * The other half of `validateStorable`: full readiness, checked at the moment
   * a graph is about to execute (activate / run) instead of while it is drawn.
   * Takes the raw Prisma JSON column, which is what both callers hold.
   */
  private assertRunnable(definition: Prisma.JsonValue): void {
    this.validateDefinition(
      (definition ?? undefined) as WorkflowDefinition | undefined,
    );
  }

  /** Validate a trigger's config shape (SCHEDULE/EVENT); 400 otherwise. */
  private validateTrigger(
    type: TriggerType,
    config: TriggerConfig | null,
  ): void {
    if (type === 'SCHEDULE') {
      const everyMs = Number(config?.everyMs);
      const hasEvery = Number.isFinite(everyMs) && everyMs >= MIN_SCHEDULE_MS;
      const hasCron =
        typeof config?.cron === 'string' && config.cron.trim().length > 0;
      if (!hasEvery && !hasCron) {
        throw new BadRequestException(
          `SCHEDULE trigger needs everyMs >= ${MIN_SCHEDULE_MS} or a cron expression`,
        );
      }
    }
    if (type === 'EVENT') {
      const eventType =
        typeof config?.eventType === 'string' ? config.eventType.trim() : '';
      if (!eventType) {
        throw new BadRequestException('EVENT trigger needs a non-empty eventType');
      }
    }
  }

  /** Add/refresh the repeatable SCHEDULE job for a workflow. */
  private async addSchedule(
    companyId: string,
    workflowId: string,
    config: TriggerConfig | null,
  ): Promise<void> {
    // In inline mode the schedule is driven by the cron sweep
    // (`/admin/cron/workflow-schedules`), so registering a BullMQ repeatable as
    // well is not merely useless — it is a DOUBLE-FIRE bug. If any worker is
    // reachable (a mixed deployment, or a leftover connected to the same Redis)
    // the workflow fires twice per interval: once from the repeatable and once
    // from the sweep. Caught by `inline-execution.e2e-spec.ts`, which saw two
    // runs where it expected one.
    if (isInlineExecution()) {
      return;
    }
    const repeat =
      typeof config?.cron === 'string' && config.cron.trim().length > 0
        ? { pattern: config.cron.trim() }
        : { every: Number(config?.everyMs) };
    await this.queue.upsertJobScheduler(schedulerId(workflowId), repeat, {
      name: WORKFLOW_TRIGGER_JOB,
      // companyId scopes the DLQ view (Unit C) if a scheduled fire ever fails.
      data: { workflowId, source: 'SCHEDULE', companyId },
      opts: { removeOnComplete: true, removeOnFail: 100 },
    });
  }

  /** Best-effort removal of a workflow's repeatable SCHEDULE job. */
  private async removeSchedule(workflowId: string): Promise<void> {
    // Nothing was registered in inline mode, so there is nothing to remove —
    // and touching the queue here would need a Redis round trip for no reason.
    if (isInlineExecution()) {
      return;
    }
    try {
      await this.queue.removeJobScheduler(schedulerId(workflowId));
    } catch {
      // No scheduler registered (e.g. never activated) — nothing to remove.
    }
  }

  // --- Ownership helper ----------------------------------------------------

  /**
   * An ARCHIVED workflow (soft-deleted, G29) is readable but not operational.
   * Guards every path that would make it live again, so archiving is a real
   * stop rather than a label. Restoring is deliberate: PATCH the status back.
   */
  private assertNotArchived(workflow: Workflow, action: string): void {
    if (workflow.status === 'ARCHIVED') {
      throw new ConflictException(
        `Cannot ${action} workflow "${workflow.name}": it is archived. ` +
          `Restore it first by setting its status back to DRAFT.`,
      );
    }
  }

  private async findOwned(companyId: string, id: string): Promise<Workflow> {
    const workflow = await this.prisma.workflow.findFirst({
      where: { id, companyId },
    });
    if (!workflow) {
      throw new NotFoundException('Workflow not found');
    }
    return workflow;
  }
}
