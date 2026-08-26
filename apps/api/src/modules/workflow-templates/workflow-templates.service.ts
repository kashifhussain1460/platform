import {
  ConflictException,
  Injectable,
  Logger,
  NotFoundException,
  type OnModuleInit,
  UnprocessableEntityException,
} from '@nestjs/common';
import { Prisma } from '@prisma/client';
import type {
  CreateWorkflowTemplateDto,
  InstallWorkflowTemplateDto,
  Plan,
  TemplateParameter,
  WorkflowCategory,
  WorkflowDefinition,
  WorkflowDto,
  WorkflowTemplateManifest,
  WorkflowTemplateRequires,
  WorkflowTemplateSummaryDto,
} from '@vaep/types';
import { PrismaService } from '../../common/prisma/prisma.service';
import { AuditLogService } from '../audit/audit-log.service';
import { planMeetsMinimum } from '../billing/billing.plans';
import { SkillCatalog } from '../skills/catalog';
import { validateDefinitionStructure } from '../workflows/engine/definition-validator';
import { toWorkflowDto } from '../workflows/workflows.mapper';
import { FIRST_PARTY_WORKFLOW_TEMPLATES } from './workflow-templates.catalog';
import { toWorkflowTemplateSummaryDto } from './workflow-templates.mapper';
import {
  resolveInstallParameters,
  substituteParams,
  validateManifest,
} from './workflow-templates.util';

/**
 * Workflow templates (P3-02). Install performs a deep COPY into the tenant
 * (provenance recorded, no live link) producing a DRAFT workflow + v1 PUBLISHED
 * version in ONE transaction, idempotency-keyed. First-party templates are seeded
 * from the code catalog on boot. Reuses pure functions only (`validateDefinition
 * Structure`, `resolveTemplate`, `toWorkflowDto`, `SkillCatalog`) + Prisma, so this
 * is a clean leaf module with no cross-module DI.
 */
@Injectable()
export class WorkflowTemplatesService implements OnModuleInit {
  private readonly logger = new Logger(WorkflowTemplatesService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly auditLog: AuditLogService,
  ) {}

  private validSkillKeys(): ReadonlySet<string> {
    return new Set(SkillCatalog.list().map((s) => s.key));
  }

  /** Seed (upsert) the first-party catalog on boot. Validation is fail-fast (a
   *  malformed first-party template is a code bug); the DB write is best-effort
   *  (a transient blip must not crash boot — install just 404s until re-seeded). */
  async onModuleInit(): Promise<void> {
    const validSkills = this.validSkillKeys();
    let seeded = 0;
    for (const manifest of FIRST_PARTY_WORKFLOW_TEMPLATES) {
      validateManifest(manifest, validSkills);
      try {
        // NULL companyId can't be used in an upsert compound-unique WHERE, so
        // seed idempotently by hand (first-party rows have companyId = NULL).
        const existing = await this.prisma.workflowTemplate.findFirst({
          where: { companyId: null, key: manifest.key, version: manifest.version },
          select: { id: true },
        });
        if (existing) {
          await this.prisma.workflowTemplate.update({
            where: { id: existing.id },
            data: { ...this.manifestToRow(manifest), status: 'PUBLISHED' },
          });
        } else {
          await this.prisma.workflowTemplate.create({
            data: {
              companyId: null,
              ...this.manifestToRow(manifest),
              status: 'PUBLISHED',
            },
          });
        }
        seeded += 1;
      } catch (err) {
        this.logger.error(
          `Failed to seed first-party template ${manifest.key}@${manifest.version}: ${
            err instanceof Error ? err.message : String(err)
          }`,
        );
      }
    }
    this.logger.log(
      `seeded ${seeded}/${FIRST_PARTY_WORKFLOW_TEMPLATES.length} first-party workflow templates`,
    );
  }

  async list(
    companyId: string,
    category?: WorkflowCategory,
  ): Promise<WorkflowTemplateSummaryDto[]> {
    const rows = await this.prisma.workflowTemplate.findMany({
      where: {
        OR: [{ companyId: null, status: 'PUBLISHED' }, { companyId }],
        ...(category ? { category } : {}),
      },
      orderBy: [{ category: 'asc' }, { name: 'asc' }],
    });
    return rows.map(toWorkflowTemplateSummaryDto);
  }

  async get(
    companyId: string,
    id: string,
  ): Promise<WorkflowTemplateSummaryDto> {
    const row = await this.prisma.workflowTemplate.findFirst({
      where: { id, OR: [{ companyId: null }, { companyId }] },
    });
    if (!row) {
      throw new NotFoundException('Workflow template not found');
    }
    return toWorkflowTemplateSummaryDto(row);
  }

  /** Author a tenant-owned (third-party) template. Runs the SAME publish
   *  validation as a user graph (rejects DB_QUERY / inline secrets → 400). */
  async createTemplate(
    companyId: string,
    dto: CreateWorkflowTemplateDto,
    actorUserId: string,
  ): Promise<WorkflowTemplateSummaryDto> {
    const manifest: WorkflowTemplateManifest = {
      key: dto.key,
      version: dto.version ?? 1,
      name: dto.name,
      description: dto.description ?? '',
      category: dto.category,
      parameters: dto.parameters ?? [],
      requires: {
        skills: dto.requires?.skills ?? [],
        employeeRoles: dto.requires?.employeeRoles ?? [],
        minPlan: dto.requires?.minPlan,
      },
      definition: dto.definition,
    };
    validateManifest(manifest, this.validSkillKeys());
    try {
      const row = await this.prisma.workflowTemplate.create({
        data: { companyId, ...this.manifestToRow(manifest), status: 'PUBLISHED' },
      });
      await this.auditLog.record({
        companyId,
        actorUserId,
        action: 'workflow-template.create',
        entityType: 'WorkflowTemplate',
        entityId: row.id,
        metadata: { key: manifest.key, version: manifest.version },
      });
      return toWorkflowTemplateSummaryDto(row);
    } catch (err) {
      if (
        err instanceof Prisma.PrismaClientKnownRequestError &&
        err.code === 'P2002'
      ) {
        throw new ConflictException(
          `A workflow template with key "${manifest.key}" version ${manifest.version} already exists`,
        );
      }
      throw err;
    }
  }

  async install(
    companyId: string,
    templateId: string,
    dto: InstallWorkflowTemplateDto,
    actorUserId: string,
    idempotencyKey?: string,
  ): Promise<WorkflowDto> {
    // Idempotency fast-path: a repeat with the same key returns the original.
    if (idempotencyKey) {
      const existing = await this.prisma.workflow.findFirst({
        where: { companyId, installIdempotencyKey: idempotencyKey },
      });
      if (existing) {
        return toWorkflowDto(existing);
      }
    }

    const template = await this.prisma.workflowTemplate.findFirst({
      where: { id: templateId, OR: [{ companyId: null }, { companyId }] },
    });
    if (!template) {
      throw new NotFoundException('Workflow template not found');
    }
    if (template.status !== 'PUBLISHED') {
      throw new ConflictException('Workflow template is not published');
    }

    const parameters = template.parameters as unknown as TemplateParameter[];
    const requires = template.requires as unknown as WorkflowTemplateRequires;
    const definition = template.definition as unknown as WorkflowDefinition;

    // Validate + resolve params (422 on missing/type-mismatch), then substitute.
    const paramValues = resolveInstallParameters(parameters, dto.parameters ?? {});
    // A `binds` param must point at a REAL tenant resource — catch a bogus
    // employee/skill id here (422), not at 3am on the first run.
    await this.assertBindsResolve(companyId, parameters, paramValues);
    const concrete = substituteParams(definition, paramValues) as WorkflowDefinition;
    // Defensive structural re-check on the concrete graph.
    validateDefinitionStructure(concrete);

    await this.assertPrerequisites(companyId, requires);

    const name = await this.uniqueName(
      companyId,
      dto.name?.trim() || template.name,
    );

    try {
      const workflow = await this.prisma.$transaction(async (tx) => {
        const wf = await tx.workflow.create({
          data: {
            companyId,
            name,
            description: template.description,
            definition: concrete as unknown as Prisma.InputJsonValue,
            category: template.category,
            sourceTemplateId: template.id,
            sourceTemplateVersion: template.version,
            installIdempotencyKey: idempotencyKey ?? null,
          },
        });
        const version = await tx.workflowVersion.create({
          data: {
            companyId,
            workflowId: wf.id,
            version: 1,
            status: 'PUBLISHED',
            definition: concrete as unknown as Prisma.InputJsonValue,
            publishedAt: new Date(),
            publishedById: actorUserId,
            changeNote: `Installed from template ${template.key}@${template.version}`,
          },
        });
        // Workflow stays DRAFT (no triggers fire on install) but its active
        // version is PUBLISHED (immediately runnable) — doc 19 §6.2 step 5.
        return tx.workflow.update({
          where: { id: wf.id },
          data: { activeVersionId: version.id },
        });
      });

      await this.auditLog.record({
        companyId,
        actorUserId,
        action: 'workflow-template.install',
        entityType: 'Workflow',
        entityId: workflow.id,
        metadata: {
          templateId: template.id,
          templateKey: template.key,
          templateVersion: template.version,
        },
      });
      this.logger.log(
        `workflow-template.install company=${companyId} template=${template.key}@${template.version} workflow=${workflow.id}`,
      );
      return toWorkflowDto(workflow);
    } catch (err) {
      // Idempotency race: a concurrent install with the same key won the unique.
      if (
        idempotencyKey &&
        err instanceof Prisma.PrismaClientKnownRequestError &&
        err.code === 'P2002'
      ) {
        const existing = await this.prisma.workflow.findFirst({
          where: { companyId, installIdempotencyKey: idempotencyKey },
        });
        if (existing) {
          return toWorkflowDto(existing);
        }
      }
      throw err;
    }
  }

  // --- helpers -------------------------------------------------------------

  private manifestToRow(
    manifest: WorkflowTemplateManifest,
  ): Omit<Prisma.WorkflowTemplateCreateManyInput, 'companyId' | 'status'> {
    return {
      key: manifest.key,
      version: manifest.version,
      name: manifest.name,
      description: manifest.description || null,
      category: manifest.category,
      definition: manifest.definition as unknown as Prisma.InputJsonValue,
      parameters: manifest.parameters as unknown as Prisma.InputJsonValue,
      requires: manifest.requires as unknown as Prisma.InputJsonValue,
    };
  }

  /** A `binds` parameter must reference a resource that actually exists in this
   *  tenant (an employee id / an installed skill key). `channel` and
   *  `knowledgeCategory` may legitimately be free-text literals, so they are not
   *  checked here. Throws 422 with per-parameter errors. */
  private async assertBindsResolve(
    companyId: string,
    parameters: TemplateParameter[],
    values: Record<string, unknown>,
  ): Promise<void> {
    const errors: string[] = [];
    for (const param of parameters) {
      const value = values[param.key];
      if (value === undefined || value === null) continue;
      if (param.binds === 'employee') {
        const employee = await this.prisma.aiEmployee.findFirst({
          where: { id: String(value), companyId },
          select: { id: true },
        });
        if (!employee) {
          errors.push(
            `Parameter "${param.key}" must reference one of this company's AI Employees`,
          );
        }
      } else if (param.binds === 'skill') {
        const installed = await this.prisma.installedSkill.findFirst({
          where: { companyId, skillKey: String(value) },
          select: { id: true },
        });
        if (!installed) {
          errors.push(
            `Parameter "${param.key}" must reference a skill installed for this company`,
          );
        }
      }
    }
    if (errors.length > 0) {
      throw new UnprocessableEntityException(errors.join('; '));
    }
  }

  private async assertPrerequisites(
    companyId: string,
    requires: WorkflowTemplateRequires,
  ): Promise<void> {
    const missingSkills: string[] = [];
    const missingRoles: string[] = [];
    let missingPlan: Plan | undefined;

    if (requires.skills?.length) {
      const installed = await this.prisma.installedSkill.findMany({
        where: { companyId },
        select: { skillKey: true },
      });
      const set = new Set(installed.map((s) => s.skillKey));
      for (const skill of requires.skills) {
        if (!set.has(skill)) missingSkills.push(skill);
      }
    }
    if (requires.employeeRoles?.length) {
      const employees = await this.prisma.aiEmployee.findMany({
        where: { companyId },
        select: { role: true },
      });
      const set = new Set<string>(employees.map((e) => e.role));
      for (const role of requires.employeeRoles) {
        if (!set.has(role)) missingRoles.push(role);
      }
    }
    if (requires.minPlan) {
      const sub = await this.prisma.subscription.findUnique({
        where: { companyId },
        select: { plan: true },
      });
      const current: Plan = sub?.plan ?? 'STARTER';
      if (!planMeetsMinimum(current, requires.minPlan)) {
        missingPlan = requires.minPlan;
      }
    }

    if (missingSkills.length || missingRoles.length || missingPlan) {
      const parts: string[] = [];
      if (missingSkills.length) {
        parts.push(`install these skills first: ${missingSkills.join(', ')}`);
      }
      if (missingRoles.length) {
        parts.push(`hire an AI Employee with role: ${missingRoles.join(', ')}`);
      }
      if (missingPlan) {
        parts.push(`upgrade to the ${missingPlan} plan or higher`);
      }
      throw new UnprocessableEntityException(
        `Template prerequisites not met — ${parts.join('; ')}`,
      );
    }
  }

  /** Names are unique per tenant; a repeat install disambiguates with " (n)". */
  private async uniqueName(companyId: string, base: string): Promise<string> {
    const existing = await this.prisma.workflow.findMany({
      where: { companyId, name: { startsWith: base } },
      select: { name: true },
    });
    const taken = new Set(existing.map((e) => e.name));
    if (!taken.has(base)) return base;
    for (let i = 2; i <= taken.size + 2; i++) {
      const candidate = `${base} (${i})`;
      if (!taken.has(candidate)) return candidate;
    }
    // Unreachable: at most taken.size names, so one of (2..size+2) is free.
    return `${base} (${taken.size + 2})`;
  }
}
