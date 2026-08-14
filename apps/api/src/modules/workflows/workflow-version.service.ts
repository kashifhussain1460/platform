import {
  BadRequestException,
  ConflictException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { Prisma, type Workflow, type WorkflowVersion } from '@prisma/client';
import type {
  PublishWorkflowResultDto,
  WorkflowDefinition,
  WorkflowVersionDto,
} from '@vaep/types';
import { PrismaService } from '../../common/prisma/prisma.service';
import { AuditLogService } from '../audit/audit-log.service';
import { SkillRequirementsService } from '../skills/skill-requirements.service';
import {
  validateDefinitionStructure,
  validateStorableDefinition,
} from './engine/definition-validator';

/** Prisma → DTO. Dates are ISO strings across the API boundary. */
export function toWorkflowVersionDto(row: WorkflowVersion): WorkflowVersionDto {
  return {
    id: row.id,
    companyId: row.companyId,
    workflowId: row.workflowId,
    version: row.version,
    status: row.status,
    definition: row.definition as unknown as WorkflowDefinition,
    publishedAt: row.publishedAt?.toISOString() ?? null,
    publishedById: row.publishedById,
    changeNote: row.changeNote,
    createdAt: row.createdAt.toISOString(),
  };
}

/** Stable ordering so two structurally identical graphs compare equal. */
function canonicalise(definition: unknown): string {
  const sort = (value: unknown): unknown => {
    if (Array.isArray(value)) return value.map(sort);
    if (value && typeof value === 'object') {
      return Object.keys(value as Record<string, unknown>)
        .sort()
        .reduce<Record<string, unknown>>((acc, key) => {
          acc[key] = sort((value as Record<string, unknown>)[key]);
          return acc;
        }, {});
    }
    return value;
  };
  return JSON.stringify(sort(definition));
}

/**
 * Workflow versioning (P1-02, closes gap G1).
 *
 * Before this, `PATCH /workflows/:id` wrote straight to `Workflow.definition`,
 * so editing an ACTIVE workflow mutated the graph that in-flight runs were
 * still walking. Now every run pins a `workflowVersionId` and a PUBLISHED
 * version is immutable, so an edit can never change history.
 *
 * Immutability is enforced HERE, in the service, rather than by a database
 * trigger: a trigger would also block legitimate admin repair and would be
 * invisible to anyone reading `schema.prisma`.
 *
 * `Workflow.definition` is still written on publish. That is deliberate and
 * temporary — the legacy walk reads it while
 * `WORKFLOW_ENGINE_MODE=legacy_walk`, and it is the rollback path for the
 * backfill. It is removed only after every tenant is migrated.
 */
@Injectable()
export class WorkflowVersionService {
  private readonly logger = new Logger(WorkflowVersionService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly auditLog: AuditLogService,
    private readonly skillRequirements: SkillRequirementsService,
  ) {}

  async list(companyId: string, workflowId: string): Promise<WorkflowVersionDto[]> {
    await this.findOwnedWorkflow(companyId, workflowId);
    const rows = await this.prisma.workflowVersion.findMany({
      where: { companyId, workflowId },
      orderBy: { version: 'desc' },
    });
    return rows.map(toWorkflowVersionDto);
  }

  async get(
    companyId: string,
    workflowId: string,
    version: number,
  ): Promise<WorkflowVersionDto> {
    const row = await this.prisma.workflowVersion.findFirst({
      where: { companyId, workflowId, version },
    });
    if (!row) {
      throw new NotFoundException(`Version ${version} not found`);
    }
    return toWorkflowVersionDto(row);
  }

  /**
   * Save the editable draft. Creates the DRAFT version on first call and
   * overwrites it thereafter — a draft is a scratchpad, not history, so
   * repeated saves must not create a new version each time.
   */
  async saveDraft(
    companyId: string,
    workflowId: string,
    definition: WorkflowDefinition,
    actorUserId?: string,
  ): Promise<WorkflowVersionDto> {
    const workflow = await this.findOwnedWorkflow(companyId, workflowId);
    this.assertEditable(workflow);
    this.validateDraft(definition);

    const existingDraft = workflow.draftVersionId
      ? await this.prisma.workflowVersion.findFirst({
          where: { id: workflow.draftVersionId, companyId },
        })
      : null;

    if (existingDraft) {
      if (existingDraft.status !== 'DRAFT') {
        // Defensive: draftVersionId must only ever point at a DRAFT row.
        throw new ConflictException(
          `Draft pointer for workflow ${workflowId} references a ${existingDraft.status} version`,
        );
      }
      const updated = await this.prisma.workflowVersion.update({
        where: { id: existingDraft.id },
        data: { definition: definition as unknown as Prisma.InputJsonObject },
      });
      return toWorkflowVersionDto(updated);
    }

    const nextVersion = await this.nextVersionNumber(companyId, workflowId);
    const created = await this.prisma.$transaction(async (tx) => {
      const version = await tx.workflowVersion.create({
        data: {
          companyId,
          workflowId,
          version: nextVersion,
          status: 'DRAFT',
          definition: definition as unknown as Prisma.InputJsonObject,
        },
      });
      await tx.workflow.update({
        where: { id: workflowId },
        data: { draftVersionId: version.id },
      });
      return version;
    });

    this.logger.log(
      `workflow.version.draft_created workflow=${workflowId} company=${companyId} version=${nextVersion} actor=${actorUserId ?? 'unknown'}`,
    );
    return toWorkflowVersionDto(created);
  }

  /**
   * Freeze the draft as PUBLISHED. Idempotent: republishing an unchanged graph
   * returns the existing version rather than creating a duplicate.
   */
  async publish(
    companyId: string,
    workflowId: string,
    actorUserId?: string,
    changeNote?: string,
  ): Promise<PublishWorkflowResultDto> {
    const workflow = await this.findOwnedWorkflow(companyId, workflowId);
    this.assertEditable(workflow);

    if (!workflow.draftVersionId) {
      throw new BadRequestException(
        'Nothing to publish: this workflow has no draft. Save a draft first.',
      );
    }
    const draft = await this.prisma.workflowVersion.findFirst({
      where: { id: workflow.draftVersionId, companyId },
    });
    if (!draft) {
      throw new NotFoundException('Draft version not found');
    }
    const draftDefinition = draft.definition as unknown as WorkflowDefinition;
    this.validate(draftDefinition);
    // A workflow whose required skills aren't connected must stay a DRAFT — it
    // cannot become executable/published (doc 30 §12). Structural validity is
    // not enough. No-op in mock mode (see SkillRequirementsService).
    await this.skillRequirements.assertPublishable(companyId, draftDefinition);

    // Idempotency: identical to the live version → no new version.
    if (workflow.activeVersionId) {
      const active = await this.prisma.workflowVersion.findFirst({
        where: { id: workflow.activeVersionId, companyId },
      });
      if (
        active &&
        canonicalise(active.definition) === canonicalise(draft.definition)
      ) {
        this.logger.log(
          `workflow.version.publish_unchanged workflow=${workflowId} company=${companyId} version=${active.version}`,
        );
        return {
          version: toWorkflowVersionDto(active),
          unchanged: true,
          activated: false,
          workflow: null,
          activationError: null,
        };
      }
    }

    const published = await this.prisma.$transaction(async (tx) => {
      // The previously active version is superseded, not deleted — in-flight
      // runs still reference it and must keep resolving.
      if (workflow.activeVersionId) {
        await tx.workflowVersion.update({
          where: { id: workflow.activeVersionId },
          data: { status: 'DEPRECATED' },
        });
      }
      const version = await tx.workflowVersion.update({
        where: { id: draft.id },
        data: {
          status: 'PUBLISHED',
          publishedAt: new Date(),
          publishedById: actorUserId ?? null,
          changeNote: changeNote ?? null,
        },
      });
      await tx.workflow.update({
        where: { id: workflowId },
        data: {
          activeVersionId: version.id,
          draftVersionId: null,
          // Kept in sync for the legacy walk (WORKFLOW_ENGINE_MODE=legacy_walk)
          // and as the backfill rollback path. Removed after full cutover.
          definition: version.definition as Prisma.InputJsonObject,
        },
      });
      return version;
    });

    await this.auditLog.record({
      companyId,
      actorUserId,
      action: 'workflow.version.publish',
      entityType: 'WorkflowVersion',
      entityId: published.id,
      metadata: { workflowId, version: published.version },
    });
    this.logger.log(
      `workflow.version.published workflow=${workflowId} company=${companyId} version=${published.version} actor=${actorUserId ?? 'unknown'}`,
    );
    return {
      version: toWorkflowVersionDto(published),
      unchanged: false,
      activated: false,
      workflow: null,
      activationError: null,
    };
  }

  /**
   * Resolve the version a new run should execute. Returns null when the
   * workflow predates versioning and has not been backfilled — the caller then
   * falls back to `Workflow.definition` rather than refusing to run.
   */
  async resolveActiveVersion(
    companyId: string,
    workflowId: string,
  ): Promise<WorkflowVersion | null> {
    const workflow = await this.prisma.workflow.findFirst({
      where: { id: workflowId, companyId },
      select: { activeVersionId: true },
    });
    if (!workflow?.activeVersionId) return null;
    return this.prisma.workflowVersion.findFirst({
      where: { id: workflow.activeVersionId, companyId },
    });
  }

  /**
   * The definition to inspect for skill requirements: the editable DRAFT when
   * one exists (what the builder is changing), else the active PUBLISHED
   * version, else the legacy `Workflow.definition`. Tenant-scoped; 404 when the
   * workflow isn't the caller's.
   */
  async resolveDefinitionForInspection(
    companyId: string,
    workflowId: string,
  ): Promise<WorkflowDefinition> {
    const workflow = await this.findOwnedWorkflow(companyId, workflowId);
    const versionId = workflow.draftVersionId ?? workflow.activeVersionId;
    if (versionId) {
      const version = await this.prisma.workflowVersion.findFirst({
        where: { id: versionId, companyId },
      });
      if (version) {
        return version.definition as unknown as WorkflowDefinition;
      }
    }
    return workflow.definition as unknown as WorkflowDefinition;
  }

  /**
   * Backfill: give every workflow that has no version a v1 PUBLISHED snapshot
   * of its current `definition`, and point `activeVersionId` at it.
   *
   * Idempotent by construction (skips workflows that already have a version)
   * and non-destructive (`Workflow.definition` is left untouched), so it is
   * safe to re-run and trivially reversible.
   */
  async backfillMissingVersions(batchSize = 500): Promise<{
    scanned: number;
    created: number;
  }> {
    let scanned = 0;
    let created = 0;

    for (;;) {
      const batch = await this.prisma.workflow.findMany({
        where: { activeVersionId: null, versions: { none: {} } },
        take: batchSize,
        orderBy: { createdAt: 'asc' },
      });
      if (batch.length === 0) break;
      scanned += batch.length;

      for (const workflow of batch) {
        await this.prisma.$transaction(async (tx) => {
          const version = await tx.workflowVersion.create({
            data: {
              companyId: workflow.companyId,
              workflowId: workflow.id,
              version: 1,
              status: 'PUBLISHED',
              definition: workflow.definition as Prisma.InputJsonObject,
              publishedAt: workflow.createdAt,
              changeNote: 'Backfilled from Workflow.definition (P1-02)',
            },
          });
          await tx.workflow.update({
            where: { id: workflow.id },
            data: { activeVersionId: version.id },
          });
        });
        created += 1;
      }

      // A full batch that produced no rows would loop forever; the `versions:
      // none` filter makes that impossible, but guard anyway.
      if (batch.length < batchSize) break;
    }

    this.logger.log(
      `workflow.version.backfill scanned=${scanned} created=${created}`,
    );
    return { scanned, created };
  }

  // --- helpers --------------------------------------------------------------

  private async nextVersionNumber(
    companyId: string,
    workflowId: string,
  ): Promise<number> {
    const latest = await this.prisma.workflowVersion.findFirst({
      where: { companyId, workflowId },
      orderBy: { version: 'desc' },
      select: { version: true },
    });
    return (latest?.version ?? 0) + 1;
  }

  private assertEditable(workflow: Workflow): void {
    if (workflow.status === 'ARCHIVED') {
      throw new ConflictException(
        `Cannot edit workflow "${workflow.name}": it is archived.`,
      );
    }
  }

  /** Throws BadRequestException itself — structural rules live in one place. */
  private validate(definition: WorkflowDefinition): void {
    validateDefinitionStructure(definition);
  }

  /**
   * Draft writes check integrity only — a draft is a scratchpad and is expected
   * to be incomplete. `publish()` still runs the full check, so nothing
   * unfinished becomes executable.
   */
  private validateDraft(definition: WorkflowDefinition): void {
    validateStorableDefinition(definition);
  }

  private async findOwnedWorkflow(
    companyId: string,
    id: string,
  ): Promise<Workflow> {
    const workflow = await this.prisma.workflow.findFirst({
      where: { id, companyId },
    });
    if (!workflow) {
      throw new NotFoundException('Workflow not found');
    }
    return workflow;
  }
}
