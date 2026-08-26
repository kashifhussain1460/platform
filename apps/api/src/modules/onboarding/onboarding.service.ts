import { Injectable, Logger } from '@nestjs/common';
import { Prisma, type Department as DepartmentRow } from '@prisma/client';
import type {
  AiEmployeeDto,
  CompleteOnboardingResultDto,
  DepartmentDto,
  EmployeeRoleTemplate,
  OnboardingStatusDto,
} from '@vaep/types';
import { DEPARTMENTS, allowedGoalsForRoles } from '@vaep/types';
import { PrismaService } from '../../common/prisma/prisma.service';
import { EmployeesService } from '../employees/employees.service';
import { AuditLogService } from '../audit/audit-log.service';
import { NotificationsService } from '../notifications/notifications.service';
import { toCompanyDto } from '../tenant/tenant.service';
import { CompleteOnboardingDto } from './dto/complete-onboarding.dto';
import { ONBOARDING_CATALOG } from './onboarding.catalog';
import {
  creditGrantsEnabled,
  freeGrantCredits,
  freeGrantDomainCap,
  freeGrantExpiryDays,
} from '../../common/config/credit-config';
import { isDisposableEmailDomain } from '../auth/disposable-email.list';
import { RateLimiter } from '../../common/resilience/rate-limiter';
import { CreditLedgerService } from '../credits/credit-ledger.service';
import { signupDomainVelocityWindowMs } from '../../common/config/credit-abuse.constants';

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
 *
 * ONLY applied to the code-defined `Department` enum values. A company that
 * types its own name gets it stored verbatim — running "Customer Success &
 * Renewals" through this would return "Customer success & renewals", which is
 * not the department anyone asked for.
 */
const ENUM_DEPARTMENTS = new Set<string>(DEPARTMENTS);

function departmentName(value: string): string {
  const trimmed = value.trim();
  if (!ENUM_DEPARTMENTS.has(trimmed)) {
    // Custom, user-typed name: collapse internal whitespace, keep their casing.
    return trimmed.replace(/\s+/g, ' ');
  }
  return trimmed
    .split('_')
    .filter(Boolean)
    .map((word) =>
      ACRONYMS.has(word) ? word : word.charAt(0).toUpperCase() + word.slice(1).toLowerCase(),
    )
    .join(' ');
}

/**
 * Normalise the wizard's department list into the names to persist.
 *
 * Drops blanks (so an empty text box never becomes an empty placeholder row),
 * de-duplicates case-insensitively (so "Sales" and "sales" are one department,
 * not a unique-constraint 500), and caps the length at the column's own limit.
 */
export function normalizeDepartmentNames(raw: readonly string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const value of raw) {
    if (typeof value !== 'string') continue;
    const name = departmentName(value).slice(0, 120);
    if (!name) continue;
    const key = name.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(name);
  }
  return out;
}

function toDepartmentDto(row: DepartmentRow): DepartmentDto {
  return {
    id: row.id,
    companyId: row.companyId,
    name: row.name,
    description: row.description,
    scopes: row.scopes,
    // A department created by the wizard has nobody in it yet, by construction:
    // users are placed afterwards, from the Organization screen.
    memberCount: 0,
    teamCount: 0,
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
    private readonly creditLedger: CreditLedgerService,
    private readonly rateLimiter: RateLimiter,
  ) {}

  /**
   * Resumable onboarding state — server-side, so it survives refresh / logout /
   * device change. `step` is the furthest point reached; the saved company
   * profile, selected roles and goals let the wizard rehydrate exactly.
   */
  async status(companyId: string): Promise<OnboardingStatusDto> {
    const [c, departments] = await Promise.all([
      this.prisma.company.findUniqueOrThrow({
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
      }),
      // Read from the DEPARTMENT TABLE, never from a draft column. Status
      // reporting a department the tenant does not actually have is the exact
      // failure this phase exists to remove — the wizard shipped for months
      // sending `departments: []` while status said nothing at all about it.
      this.prisma.department.findMany({
        where: { companyId },
        select: { name: true },
        orderBy: { createdAt: 'asc' },
      }),
    ]);
    return {
      completed: Boolean(c.onboardedAt),
      step: c.onboardedAt ? 'COMPLETED' : c.onboardingStep ?? 'NOT_STARTED',
      company: { name: c.name, industry: c.industry, size: c.size, website: c.website },
      selectedRoles: c.onboardingRoles,
      goals: c.businessGoals,
      departments: departments.map((d) => d.name),
    };
  }

  /**
   * Step 4 — departments, saved as REAL `Department` rows as the user advances
   * rather than held in a draft and written at the end.
   *
   * Persisting here (not only at `complete`) is what makes the step resumable
   * in the same way every other step already is: refresh, log out, come back on
   * another device, and the departments are there because they are rows, not
   * because a wizard remembered them.
   *
   * Idempotent. `createMany({ skipDuplicates })` against the
   * `@@unique([companyId, name])` index means re-submitting the same list is a
   * no-op, and REMOVING a name here does NOT delete the department — deletion
   * is a deliberate, dependency-checked action in the Organization screen, not
   * a side effect of editing a wizard field.
   */
  async saveDepartments(
    companyId: string,
    names: readonly string[],
  ): Promise<OnboardingStatusDto> {
    const clean = normalizeDepartmentNames(names);
    if (clean.length > 0) {
      await this.prisma.department.createMany({
        data: clean.map((name) => ({ companyId, name })),
        skipDuplicates: true,
      });
      await this.audit.record({
        companyId,
        action: 'onboarding.departments_selected',
        entityType: 'Company',
        entityId: companyId,
        metadata: { departments: clean },
      });
    }
    await this.prisma.company.update({
      where: { id: companyId },
      data: { onboardingStep: 'DEPARTMENTS' },
    });
    return this.status(companyId);
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

    // 1. Departments. The wizard normally persists these at its own step
    //    (`saveDepartments`), so by the time we get here the rows usually
    //    already exist — this is the top-up for a client that posts the whole
    //    payload at once, and it shares the SAME normalisation so the two paths
    //    cannot disagree about what "Sales" means. Blanks are dropped rather
    //    than stored as empty placeholder departments; `skipDuplicates` + the
    //    [companyId, name] unique index make it safe to run twice.
    const names = normalizeDepartmentNames(dto.departments);
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

    // 2.5. Free-credit grant (Phase 4, §7.2 Option B). Runs BEFORE the
    // `onboardedAt` stamp below on purpose: that stamp is what makes a retry
    // of complete() take the early-return at the top of this method, so any
    // failure in the grant must happen before it — a retry after a failed
    // grant attempt must still be able to reach this code, not skip it
    // forever having already been marked "onboarded".
    let grantedCredits = 0;
    if (creditGrantsEnabled()) {
      grantedCredits = await this.grantFreeSignupCredits(companyId);
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
      metadata: grantedCredits > 0 ? { freeCreditsGranted: grantedCredits } : undefined,
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

  /**
   * Phase 4, Tasks 4.2-4.4 — the one-time free-credit grant. Returns the
   * granted amount (0 when skipped by a gate below — never an error, since
   * §26 requires onboarding to never fail because of an abuse check).
   *
   * Gates, in order: (a) the owner's email domain is not disposable (4.3);
   * (b) that domain hasn't exceeded its 24h grant velocity cap (4.2 — a
   * Redis window, checked HERE at grant time, never at registration). A
   * company that clears both gets a CREDIT ledger row + its originating
   * CreditLot, in one transaction, idempotent on `free-grant:{companyId}` —
   * a P2002 on the CreditLot's `originLedgerEntryId` (a retry replaying the
   * SAME ledger row) is a safe no-op, not an error.
   */
  private async grantFreeSignupCredits(companyId: string): Promise<number> {
    const owner = await this.prisma.user.findFirst({
      where: { companyId, role: 'OWNER' },
      select: { email: true },
      orderBy: { createdAt: 'asc' },
    });
    const domain = owner?.email.split('@')[1]?.toLowerCase().trim();
    if (!domain) {
      this.logger.warn(`free-credit grant skipped for ${companyId}: no owner email found`);
      return 0;
    }
    if (isDisposableEmailDomain(domain)) {
      this.logger.log(`free-credit grant skipped for ${companyId}: disposable email domain (${domain})`);
      return 0;
    }
    const allowed = await this.rateLimiter.tryAcquire(
      `freegrant-domain:${domain}`,
      freeGrantDomainCap(),
      signupDomainVelocityWindowMs(),
    );
    if (!allowed) {
      this.logger.warn(`free-credit grant skipped for ${companyId}: domain velocity cap reached (${domain})`);
      return 0;
    }

    const amount = freeGrantCredits();
    try {
      await this.prisma.$transaction(async (tx) => {
        const entry = await this.creditLedger.append(
          {
            companyId,
            transactionType: 'CREDIT',
            grantKind: 'FREE_SIGNUP',
            amount,
            reason: 'One-time free-signup credit grant',
            source: 'SYSTEM',
            idempotencyKey: `free-grant:${companyId}`,
          },
          tx,
        );
        await tx.creditLot.create({
          data: {
            companyId,
            originLedgerEntryId: entry.id,
            grantKind: 'FREE_SIGNUP',
            grantedAmount: amount,
            remaining: amount,
            expiresAt: new Date(Date.now() + freeGrantExpiryDays() * 24 * 60 * 60 * 1000),
          },
        });
      });
    } catch (err) {
      if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
        // The CreditLot for this exact ledger row already exists — a retry
        // replaying the same idempotencyKey's row. Safe no-op.
        this.logger.log(`free-credit grant already recorded for ${companyId}`);
      } else {
        throw err;
      }
    }
    return amount;
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
