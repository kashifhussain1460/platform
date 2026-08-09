import { Injectable, Logger } from '@nestjs/common';
import type { Department as DepartmentRow } from '@prisma/client';
import type {
  AiEmployeeDto,
  CompleteOnboardingResultDto,
  DepartmentDto,
  EmployeeRoleTemplate,
  OnboardingStatusDto,
} from '@vaep/types';
import { allowedGoalsForRoles } from '@vaep/types';
import { PrismaService } from '../../common/prisma/prisma.service';
import { EmployeesService } from '../employees/employees.service';
import { AuditLogService } from '../audit/audit-log.service';
import { NotificationsService } from '../notifications/notifications.service';
import { toCompanyDto } from '../tenant/tenant.service';
import { CompleteOnboardingDto } from './dto/complete-onboarding.dto';
import { ONBOARDING_CATALOG } from './onboarding.catalog';

// Mirrors the frontend's formatDepartment (features/onboarding/labels.ts) —
// short acronyms read wrong under plain Title Case ("HR" → "Hr", caught by
// browser-testing the onboarding wizard). Kept in sync by hand since one lives
// in @vaep/types-adjacent frontend code and one here; the department
// vocabulary is a small, stable, code-defined enum, not user input.
const ACRONYMS = new Set(['HR']);

/**
 * 'CUSTOMER_SUPPORT' → 'Customer Support', 'HR' → 'HR'. `Department.name` is
 * free text shown in the org UI, so the wizard's enum is stored in readable
 * form. Deterministic, so re-running the wizard maps to the SAME name and the
 * `@@unique([companyId, name])` index makes the write idempotent.
 */
function departmentName(value: string): string {
  return value
    .split('_')
    .filter(Boolean)
    .map((word) =>
      ACRONYMS.has(word) ? word : word.charAt(0).toUpperCase() + word.slice(1).toLowerCase(),
    )
    .join(' ');
}

function toDepartmentDto(row: DepartmentRow): DepartmentDto {
  return {
    id: row.id,
    companyId: row.companyId,
    name: row.name,
    description: row.description,
    createdAt: row.createdAt.toISOString(),
  };
}

/**
 * Drives the AI Onboarding Wizard. The company remains the tenant; completing
 * the wizard captures the business profile, hires the selected AI employees
 * (reusing EmployeesService.create), and stamps company.onboardedAt.
 */
@Injectable()
export class OnboardingService {
  private readonly logger = new Logger(OnboardingService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly employees: EmployeesService,
    private readonly audit: AuditLogService,
    private readonly notifications: NotificationsService,
  ) {}

  /**
   * Resumable onboarding state — server-side, so it survives refresh / logout /
   * device change. `step` is the furthest point reached; the saved company
   * profile, selected roles and goals let the wizard rehydrate exactly.
   */
  async status(companyId: string): Promise<OnboardingStatusDto> {
    const c = await this.prisma.company.findUniqueOrThrow({
      where: { id: companyId },
      select: {
        name: true,
        industry: true,
        size: true,
        website: true,
        onboardedAt: true,
        onboardingStep: true,
        onboardingRoles: true,
        businessGoals: true,
      },
    });
    return {
      completed: Boolean(c.onboardedAt),
      step: c.onboardedAt ? 'COMPLETED' : c.onboardingStep ?? 'NOT_STARTED',
      company: { name: c.name, industry: c.industry, size: c.size, website: c.website },
      selectedRoles: c.onboardingRoles,
      goals: c.businessGoals,
    };
  }

  /** Step 1 — company profile. Advances the resume marker to AI-employee select. */
  async saveCompany(
    companyId: string,
    dto: { name: string; industry: string; size: string; website?: string },
  ): Promise<OnboardingStatusDto> {
    await this.prisma.company.update({
      where: { id: companyId },
      data: {
        name: dto.name,
        industry: dto.industry,
        size: dto.size,
        website: dto.website ?? null,
        onboardingStep: 'AI_EMPLOYEE_SELECTION',
      },
    });
    return this.status(companyId);
  }

  /**
   * Step 2 — AI-employee selection. Stores the selected roles and RECONCILES
   * goals: any goal no longer valid for the new role set is dropped (e.g. HR +
   * Marketing → HR only removes every Marketing-only goal). Deterministic; never
   * deletes an already-hired employee (that would be destructive).
   */
  async saveAiEmployees(companyId: string, roles: string[]): Promise<OnboardingStatusDto> {
    const uniqueRoles = [...new Set(roles)];
    const allowed = new Set(allowedGoalsForRoles(uniqueRoles));
    const current = await this.prisma.company.findUniqueOrThrow({
      where: { id: companyId },
      select: { businessGoals: true },
    });
    const prunedGoals = current.businessGoals.filter((g) => allowed.has(g));
    await this.prisma.company.update({
      where: { id: companyId },
      data: {
        onboardingRoles: uniqueRoles,
        businessGoals: prunedGoals,
        onboardingStep: 'BUSINESS_GOALS',
      },
    });
    await this.audit.record({
      companyId,
      action: 'onboarding.ai_employees_selected',
      entityType: 'Company',
      entityId: companyId,
      metadata: { roles: uniqueRoles },
    });
    return this.status(companyId);
  }

  /** Step 3 — business goals. Silently drops any goal not allowed by the roles. */
  async saveGoals(companyId: string, goals: string[]): Promise<OnboardingStatusDto> {
    const current = await this.prisma.company.findUniqueOrThrow({
      where: { id: companyId },
      select: { onboardingRoles: true },
    });
    const allowed = new Set(allowedGoalsForRoles(current.onboardingRoles));
    const filtered = [...new Set(goals)].filter((g) => allowed.has(g));
    await this.prisma.company.update({
      where: { id: companyId },
      data: { businessGoals: filtered, onboardingStep: 'BUSINESS_GOALS' },
    });
    return this.status(companyId);
  }

  /** The code-defined hire catalog (source of truth). */
  catalog(): EmployeeRoleTemplate[] {
    return ONBOARDING_CATALOG.map((t) => ({
      ...t,
      departments: [...t.departments],
    }));
  }

  /**
   * Complete onboarding: persist the chosen departments, hire the chosen AI
   * employees, then save the business profile and stamp `onboardedAt`.
   *
   * IDEMPOTENT by design. This endpoint is retried in practice — a double-click
   * on "Finish", or a client retry after a network blip on a request the server
   * actually processed. The previous version created a fresh AI employee per
   * call unconditionally, so a retry silently duplicated the whole hire list and
   * (because the failure happened before `onboardedAt` was stamped) the user was
   * sent back through the wizard to do it again. Now: departments upsert,
   * employees are only hired for roles the company does not already have, and a
   * company that is already onboarded short-circuits to its current state.
   *
   * Ordering is deliberate — departments and employees are written BEFORE
   * `onboardedAt`, so a failure part-way leaves onboarding resumable rather than
   * marking a half-configured company as done.
   */
  async complete(
    companyId: string,
    dto: CompleteOnboardingDto,
  ): Promise<CompleteOnboardingResultDto> {
    const existing = await this.prisma.company.findUniqueOrThrow({
      where: { id: companyId },
      select: { onboardedAt: true },
    });

    // Already finished: return the current state instead of hiring a second
    // copy of everyone. Keeps a retry / stale tab harmless.
    if (existing.onboardedAt) {
      this.logger.log(
        `complete: company ${companyId} already onboarded — returning current state`,
      );
      return this.currentState(companyId);
    }

    // 1. Departments. Previously collected by the wizard and thrown away; they
    //    now become real rows. `skipDuplicates` + the [companyId, name] unique
    //    index make this safe to run twice.
    const names = [...new Set(dto.departments.map(departmentName))].filter(Boolean);
    if (names.length > 0) {
      await this.prisma.department.createMany({
        data: names.map((name) => ({ companyId, name })),
        skipDuplicates: true,
      });
    }

    // 2. Employees — only for roles this company doesn't already staff, so a
    //    retry tops up rather than duplicating.
    const alreadyHired = new Set(
      (
        await this.prisma.aiEmployee.findMany({
          where: { companyId },
          select: { role: true },
        })
      ).map((e) => e.role),
    );
    const created: AiEmployeeDto[] = [];
    for (const entry of dto.employees) {
      if (alreadyHired.has(entry.role)) {
        this.logger.log(
          `complete: skipping ${entry.role} for ${companyId} — already hired`,
        );
        continue;
      }
      const suggested = ONBOARDING_CATALOG.find(
        (t) => t.role === entry.role,
      )?.suggestedName;
      const name = entry.name?.trim() || suggested || entry.role;
      // EmployeesService.create owns the plan seat-limit check and its own
      // advisory-locked transaction, so it is called per-employee rather than
      // wrapped in an outer transaction that would bypass those guarantees.
      created.push(await this.employees.create(companyId, { name, role: entry.role }));
      alreadyHired.add(entry.role);
    }

    // 3. Profile + the completion stamp, last.
    const company = await this.prisma.company.update({
      where: { id: companyId },
      data: {
        industry: dto.business?.industry,
        size: dto.business?.size,
        description: dto.business?.description,
        onboardedAt: new Date(),
        onboardingStep: 'COMPLETED',
      },
    });
    await this.audit.record({
      companyId,
      action: 'onboarding.completed',
      entityType: 'Company',
      entityId: companyId,
    });
    // Welcome the owner(s) now that setup is done (best-effort; no-op when off).
    await this.notifications.welcome(companyId);

    const departments = await this.prisma.department.findMany({
      where: { companyId },
      orderBy: { name: 'asc' },
    });
    this.logger.log(
      `complete: company=${companyId} departments=${departments.length} hired=${created.length}`,
    );

    return {
      company: toCompanyDto(company),
      employees: created,
      departments: departments.map(toDepartmentDto),
    };
  }

  /** Present state for an already-onboarded company (idempotent re-complete). */
  private async currentState(
    companyId: string,
  ): Promise<CompleteOnboardingResultDto> {
    const [company, departments] = await Promise.all([
      this.prisma.company.findUniqueOrThrow({ where: { id: companyId } }),
      this.prisma.department.findMany({
        where: { companyId },
        orderBy: { name: 'asc' },
      }),
    ]);
    return {
      company: toCompanyDto(company),
      // Nothing was hired on THIS call — an empty list is the honest answer.
      employees: [],
      departments: departments.map(toDepartmentDto),
    };
  }
}
