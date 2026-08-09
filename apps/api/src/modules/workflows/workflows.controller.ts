import {
  BadRequestException,
  Body,
  Headers,
  Controller,
  Delete,
  ForbiddenException,
  Get,
  HttpCode,
  Param,
  Patch,
  Post,
  Put,
  Query,
  UseGuards,
} from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import type { NodeType } from '@vaep/types';
import type {
  FireEventResultDto,
  GenerateWorkflowResultDto,
  NodeDefinitionDto,
  PublishWorkflowResultDto,
  WorkflowDto,
  WorkflowRunDto,
  WorkflowSkillRequirementsDto,
  WorkflowVersionDto,
} from '@vaep/types';
import { CurrentTenant } from '../auth/decorators/current-tenant.decorator';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import type { AuthenticatedUser } from '../auth/auth.provider';
import { Roles } from '../auth/decorators/roles.decorator';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { RolesGuard } from '../auth/roles.guard';
import { RequirePlan } from '../billing/decorators/plan.decorator';
import { PlanGuard } from '../billing/plan.guard';
import { CreateWorkflowDto } from './dto/create-workflow.dto';
import { FireEventDto } from './dto/fire-event.dto';
import { GenerateWorkflowDto } from './dto/generate-workflow.dto';
import { RunWorkflowDto } from './dto/run-workflow.dto';
import { UpdateWorkflowDto } from './dto/update-workflow.dto';
import { WorkflowGeneratorService } from './engine/workflow-generator.service';
import { SkillRequirementsService } from '../skills/skill-requirements.service';
import { WorkflowsService } from './workflows.service';
import { WorkflowVersionService } from './workflow-version.service';
import { NodeRegistry } from './engine/node-registry.service';
import { listNodeDefinitions } from './engine/nodes/node-catalog';
import {
  PublishWorkflowDto,
  SaveDraftDto,
} from './dto/workflow-version.dto';

/**
 * All routes are tenant-scoped by companyId from the JWT and JWT-guarded.
 * Authoring workflows (create/update/delete/activate/deactivate) is
 * @Roles('OWNER','ADMIN'); reads + running/firing stay open to any member.
 */
@Controller('workflows')
@UseGuards(JwtAuthGuard, RolesGuard)
export class WorkflowsController {
  constructor(
    private readonly workflows: WorkflowsService,
    private readonly versions: WorkflowVersionService,
    private readonly registry: NodeRegistry,
    private readonly generator: WorkflowGeneratorService,
    private readonly skillRequirements: SkillRequirementsService,
  ) {}

  @Post()
  @Roles('OWNER', 'ADMIN')
  create(
    @CurrentTenant() companyId: string,
    @CurrentUser() user: AuthenticatedUser,
    @Body() dto: CreateWorkflowDto,
  ): Promise<WorkflowDto> {
    return this.workflows.create(companyId, dto, user.userId);
  }

  @Get()
  list(
    @CurrentTenant() companyId: string,
    @Query('limit') limit?: string,
  ): Promise<WorkflowDto[]> {
    return this.workflows.list(companyId, limit);
  }

  /**
   * Fire an internal event to every ACTIVE EVENT-triggered workflow whose
   * eventType matches. Declared before `:id` so the fixed `events` segment is
   * never shadowed by a parametric route.
   */
  @Post('events')
  @HttpCode(200)
  fireEvent(
    @CurrentTenant() companyId: string,
    @Body() dto: FireEventDto,
  ): Promise<FireEventResultDto> {
    return this.workflows.fireEvent(companyId, dto.eventType, dto.payload, dto.connectorId);
  }

  /**
   * A single run + its steps (for polling). Declared before `:id` so the fixed
   * `runs` segment is never shadowed by the parametric workflow route.
   */
  @Get('runs/:runId')
  getRun(
    @CurrentTenant() companyId: string,
    @Param('runId') runId: string,
  ): Promise<WorkflowRunDto> {
    return this.workflows.getRun(companyId, runId);
  }

  /** Cancel a non-terminal run (privileged + audited). */
  @Post('runs/:runId/cancel')
  cancelRun(
    @CurrentTenant() companyId: string,
    @CurrentUser() user: AuthenticatedUser,
    @Param('runId') runId: string,
  ): Promise<WorkflowRunDto> {
    return this.workflows.cancelRunByUser(companyId, runId, user.userId);
  }

  /** Retry a run by starting a fresh run of the same workflow (new run, never resurrects). */
  @Post('runs/:runId/retry')
  retryRun(
    @CurrentTenant() companyId: string,
    @CurrentUser() user: AuthenticatedUser,
    @Param('runId') runId: string,
  ): Promise<WorkflowRunDto> {
    return this.workflows.retryRun(companyId, runId, user.userId);
  }

  /**
   * AI-assisted draft generation (BUSINESS/ENTERPRISE only). Never persists —
   * hand the returned `definition` to POST / (create) once the user accepts it.
   * Tighter than the app-wide default (docs status audit §3): each call runs
   * up to GENERATION_MAX_ATTEMPTS real LLM completions, so this is one of the
   * endpoints that actually costs real money per request.
   */
  @Post('generate')
  @UseGuards(PlanGuard)
  @RequirePlan('BUSINESS', 'ENTERPRISE')
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  generateDraft(
    @CurrentTenant() companyId: string,
    @Body() dto: GenerateWorkflowDto,
  ): Promise<GenerateWorkflowResultDto> {
    return this.generator.generate(companyId, dto.messages);
  }

  /**
   * The node types this engine can actually execute, GENERATED from the
   * NodeRegistry (P1-03, doc 26 §9) — never a hand-maintained list, so the
   * palette can never drift from the runtime.
   *
   * Declared before `:id` so the fixed `node-types` segment is not shadowed by
   * the parametric workflow route.
   */
  @Get('node-types')
  listNodeTypes(): { types: NodeType[] } {
    return { types: this.registry.list() };
  }

  /**
   * The full node-metadata CATALOG (category, label, description, handle
   * topology, config-field schema) for the Workflow Builder palette + Inspector.
   * A static, code-defined catalog (mirrors SkillCatalog; doc 02 §7) so the
   * frontend no longer needs a hardcoded client node-registry. Any authenticated
   * member may read it.
   *
   * Kept alongside — not replacing — `GET /workflows/node-types` (back-compat).
   * Declared before `:id` so the fixed `node-definitions` segment is not
   * shadowed by the parametric workflow route.
   */
  @Get('node-definitions')
  listNodeDefinitions(): NodeDefinitionDto[] {
    return listNodeDefinitions();
  }

  @Get(':id')
  get(
    @CurrentTenant() companyId: string,
    @Param('id') id: string,
  ): Promise<WorkflowDto> {
    return this.workflows.get(companyId, id);
  }

  @Patch(':id')
  @Roles('OWNER', 'ADMIN')
  update(
    @CurrentTenant() companyId: string,
    @CurrentUser() user: AuthenticatedUser,
    @Param('id') id: string,
    @Body() dto: UpdateWorkflowDto,
  ): Promise<WorkflowDto> {
    return this.workflows.update(companyId, id, dto, user.userId);
  }

  /**
   * SOFT delete (G29) — archives the workflow and KEEPS its full run history.
   * Returns 409 while any run is still PENDING/RUNNING/WAITING.
   *
   * `?hard=true` performs a genuine cascading erasure (data-subject deletion
   * requests). It destroys every run and step permanently, so it is restricted
   * to OWNER — ADMIN can archive but cannot erase — and is audited separately.
   */
  @Delete(':id')
  @Roles('OWNER', 'ADMIN')
  @HttpCode(204)
  async remove(
    @CurrentTenant() companyId: string,
    @CurrentUser() user: AuthenticatedUser,
    @Param('id') id: string,
    @Query('hard') hard?: string,
  ): Promise<void> {
    const wantsHardDelete = hard === 'true';
    if (wantsHardDelete && user.role !== 'OWNER') {
      throw new ForbiddenException(
        'Only an OWNER may permanently erase a workflow and its run history. ' +
          'Omit ?hard=true to archive it instead.',
      );
    }
    await this.workflows.remove(companyId, id, user.userId, {
      hard: wantsHardDelete,
    });
  }

  // --- P1-02 versioning (gap G1) -------------------------------------------
  // Graph edits go through the DRAFT, and only a PUBLISHED version can be run.
  // `PATCH /workflows/:id` still accepts `definition` for one deprecation
  // window (ledger R6) so existing integrations keep working.

  @Get(':id/versions')
  listVersions(
    @CurrentTenant() companyId: string,
    @Param('id') id: string,
  ): Promise<WorkflowVersionDto[]> {
    return this.versions.list(companyId, id);
  }

  @Get(':id/versions/:version')
  getVersion(
    @CurrentTenant() companyId: string,
    @Param('id') id: string,
    @Param('version') version: string,
  ): Promise<WorkflowVersionDto> {
    const parsed = Number(version);
    if (!Number.isInteger(parsed) || parsed < 1) {
      throw new BadRequestException('version must be a positive integer');
    }
    return this.versions.get(companyId, id, parsed);
  }

  /**
   * The workflow's machine-readable SKILL DEPENDENCIES + readiness (doc 30 §12).
   * Derived by scanning the current draft/active definition's TOOL_ACTION nodes
   * and resolving each against the tenant's real connections — the source the
   * in-chat Skill card and the publish gate share. A read: any member may call
   * it; `canManageConnection` reflects whether THIS member (OWNER/ADMIN) may
   * connect a skill.
   */
  @Get(':id/skill-requirements')
  async getSkillRequirements(
    @CurrentTenant() companyId: string,
    @CurrentUser() user: AuthenticatedUser,
    @Param('id') id: string,
  ): Promise<WorkflowSkillRequirementsDto> {
    const definition = await this.versions.resolveDefinitionForInspection(companyId, id);
    const canManageConnection = user.role === 'OWNER' || user.role === 'ADMIN';
    return this.skillRequirements.forDefinition(companyId, definition, {
      canManageConnection,
    });
  }

  /** Save the editable draft graph (creates the DRAFT version on first call). */
  @Put(':id/draft')
  @Roles('OWNER', 'ADMIN')
  saveDraft(
    @CurrentTenant() companyId: string,
    @CurrentUser() user: AuthenticatedUser,
    @Param('id') id: string,
    @Body() dto: SaveDraftDto,
  ): Promise<WorkflowVersionDto> {
    return this.versions.saveDraft(companyId, id, dto.definition, user.userId);
  }

  /** Freeze the draft as PUBLISHED and make it the active version. */
  @Post(':id/publish')
  @Roles('OWNER', 'ADMIN')
  @HttpCode(200)
  publish(
    @CurrentTenant() companyId: string,
    @CurrentUser() user: AuthenticatedUser,
    @Param('id') id: string,
    @Body() dto: PublishWorkflowDto,
  ): Promise<PublishWorkflowResultDto> {
    return this.versions.publish(companyId, id, user.userId, dto.changeNote);
  }

  /** Create a run (PENDING) + enqueue async execution; returns the run. */
  @Post(':id/run')
  run(
    @CurrentTenant() companyId: string,
    @CurrentUser() user: AuthenticatedUser,
    @Param('id') id: string,
    @Body() dto: RunWorkflowDto,
    @Headers('idempotency-key') idempotencyKey?: string,
  ): Promise<WorkflowRunDto> {
    return this.workflows.createRun(
      companyId,
      id,
      user.userId,
      dto.trigger,
      dto.dryRun,
      idempotencyKey ?? null,
    );
  }

  @Get(':id/runs')
  listRuns(
    @CurrentTenant() companyId: string,
    @Param('id') id: string,
    @Query('limit') limit?: string,
  ): Promise<WorkflowRunDto[]> {
    return this.workflows.listRuns(companyId, id, limit);
  }

  /** Activate a workflow (requires runnable steps); arms its trigger. */
  @Post(':id/activate')
  @Roles('OWNER', 'ADMIN')
  @HttpCode(200)
  activate(
    @CurrentTenant() companyId: string,
    @Param('id') id: string,
  ): Promise<WorkflowDto> {
    return this.workflows.activate(companyId, id);
  }

  /** Deactivate a workflow (PAUSED); disarms any SCHEDULE job. */
  @Post(':id/deactivate')
  @Roles('OWNER', 'ADMIN')
  @HttpCode(200)
  deactivate(
    @CurrentTenant() companyId: string,
    @Param('id') id: string,
  ): Promise<WorkflowDto> {
    return this.workflows.deactivate(companyId, id);
  }
}
