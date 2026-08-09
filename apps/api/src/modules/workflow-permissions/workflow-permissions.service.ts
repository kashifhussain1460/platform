import {
  ConflictException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { Prisma, type WorkflowPermission } from '@prisma/client';
import type {
  CreateWorkflowPermissionDto,
  Role,
  WorkflowPermissionDto,
} from '@vaep/types';
import { PrismaService } from '../../common/prisma/prisma.service';
import { roleSatisfies } from '../auth/roles.guard';
import { toWorkflowPermissionDto } from './workflow-permissions.mapper';

/** The acting user, as far as permission checks need them. */
export interface PermissionActor {
  userId: string;
  role: Role;
}

/** A run subject resolved from the DB (its role + org membership). */
interface RunSubject {
  id: string;
  role: Role;
  departmentId: string | null;
  teamId: string | null;
}

/**
 * Workflow permissions (P3-06, doc 09 §9.C.5). A dependency-light leaf (PrismaService
 * only) that WorkflowsModule imports for the ENQUEUE-time `workflow:run` check (doc
 * 16 §21), and which also serves the `/workflows/:id/permissions` CRUD.
 *
 * Model: a workflow with NO grants is runnable by any member (back-compat, today's
 * status quo). Adding `RUN` grants restricts the workflow to the named subjects
 * (USER/ROLE/DEPARTMENT/TEAM) — with a company OWNER/ADMIN always allowed. Managing
 * grants requires being the workflow's owner OR a company admin (§9.C.6): a MEMBER
 * who created a workflow can still share it.
 */
@Injectable()
export class WorkflowPermissionService {
  private readonly logger = new Logger(WorkflowPermissionService.name);

  constructor(private readonly prisma: PrismaService) {}

  /**
   * Enqueue-time gate (doc 16 §21): may this run's subject run this workflow?
   * `subjectUserId` is the clicking user (MANUAL) or the pinned version's publisher
   * (SCHEDULE/EVENT/WEBHOOK — doc 09 §9.C.3). Throws 403 if denied.
   */
  async assertCanRun(
    companyId: string,
    workflowId: string,
    subjectUserId: string | null,
  ): Promise<void> {
    const grants = await this.prisma.workflowPermission.findMany({
      where: { companyId, workflowId, action: 'RUN' },
      select: { subjectType: true, subjectId: true },
    });
    if (grants.length === 0) {
      return; // Unrestricted: any member may run it (back-compat).
    }
    const subject = subjectUserId
      ? await this.loadSubject(companyId, subjectUserId)
      : null;
    if (!subject) {
      // Restricted workflow, but the run-as subject can't be resolved (e.g. an
      // automated run whose publisher was deleted) — deny rather than run blind.
      throw new ForbiddenException(
        'This workflow is restricted and the run subject could not be authorised',
      );
    }
    if (roleSatisfies(subject.role, ['ADMIN'])) {
      return; // OWNER/ADMIN may run any workflow in their company.
    }
    const allowed = grants.some((g) =>
      this.subjectMatches(g.subjectType, g.subjectId, subject),
    );
    if (!allowed) {
      throw new ForbiddenException(
        'You are not permitted to run this workflow',
      );
    }
  }

  async list(
    companyId: string,
    workflowId: string,
    actor: PermissionActor,
  ): Promise<WorkflowPermissionDto[]> {
    await this.assertCanManage(companyId, workflowId, actor);
    const rows = await this.prisma.workflowPermission.findMany({
      where: { companyId, workflowId },
      orderBy: { createdAt: 'asc' },
    });
    return rows.map(toWorkflowPermissionDto);
  }

  async grant(
    companyId: string,
    workflowId: string,
    actor: PermissionActor,
    dto: CreateWorkflowPermissionDto,
  ): Promise<WorkflowPermissionDto> {
    await this.assertCanManage(companyId, workflowId, actor);
    try {
      const row = await this.prisma.workflowPermission.create({
        data: {
          companyId,
          workflowId,
          subjectType: dto.subjectType,
          subjectId: dto.subjectId,
          action: dto.action,
          grantedByUserId: actor.userId,
        },
      });
      this.logger.log(
        `workflow-permission.grant company=${companyId} workflow=${workflowId} ${dto.subjectType}:${dto.subjectId} → ${dto.action}`,
      );
      return toWorkflowPermissionDto(row);
    } catch (err) {
      if (
        err instanceof Prisma.PrismaClientKnownRequestError &&
        err.code === 'P2002'
      ) {
        throw new ConflictException('That grant already exists');
      }
      throw err;
    }
  }

  async revoke(
    companyId: string,
    workflowId: string,
    actor: PermissionActor,
    permissionId: string,
  ): Promise<void> {
    await this.assertCanManage(companyId, workflowId, actor);
    const result = await this.prisma.workflowPermission.deleteMany({
      where: { id: permissionId, companyId, workflowId },
    });
    if (result.count === 0) {
      throw new NotFoundException('Permission grant not found');
    }
  }

  // --- helpers -------------------------------------------------------------

  /** Manage = the workflow's owner OR a company admin (doc 09 §9.C.6). */
  private async assertCanManage(
    companyId: string,
    workflowId: string,
    actor: PermissionActor,
  ): Promise<void> {
    const workflow = await this.prisma.workflow.findFirst({
      where: { id: workflowId, companyId },
      select: { ownerUserId: true },
    });
    if (!workflow) {
      throw new NotFoundException('Workflow not found');
    }
    const isOwner =
      workflow.ownerUserId != null && workflow.ownerUserId === actor.userId;
    if (!isOwner && !roleSatisfies(actor.role, ['ADMIN'])) {
      throw new ForbiddenException(
        'Only the workflow owner or a company admin can manage its permissions',
      );
    }
  }

  private subjectMatches(
    subjectType: WorkflowPermission['subjectType'],
    subjectId: string,
    subject: RunSubject,
  ): boolean {
    switch (subjectType) {
      case 'USER':
        return subject.id === subjectId;
      case 'ROLE':
        return roleSatisfies(subject.role, [subjectId as Role]);
      case 'DEPARTMENT':
        return subject.departmentId != null && subject.departmentId === subjectId;
      case 'TEAM':
        return subject.teamId != null && subject.teamId === subjectId;
      case 'EMPLOYEE':
        // An AI employee is not a user run-subject; EMPLOYEE grants don't gate a
        // user-triggered run (they scope node/skill use in the full doc-09 PDP).
        return false;
      default:
        return false;
    }
  }

  private async loadSubject(
    companyId: string,
    userId: string,
  ): Promise<RunSubject | null> {
    // Company kill-switch (doc 09 §9.C.5): a DISABLED user is never a valid run
    // subject — so a later-disabled publisher's automated runs of a RESTRICTED
    // workflow correctly stop being authorised, rather than living on with the
    // permissions the account had while ACTIVE. Filtering here → subject resolves
    // to null → assertCanRun denies.
    return this.prisma.user.findFirst({
      where: { id: userId, companyId, status: 'ACTIVE' },
      select: { id: true, role: true, departmentId: true, teamId: true },
    });
  }
}
