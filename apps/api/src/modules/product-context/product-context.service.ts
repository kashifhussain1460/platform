import { Injectable } from '@nestjs/common';
import type {
  EmployeeRole,
  Plan,
  ProductArea,
  ProductContextDto,
  SkillCapability,
} from '@vaep/types';
import { PRODUCT_AREAS } from '@vaep/types';
import { PrismaService } from '../../common/prisma/prisma.service';
import { AuthorizationService } from '../authorization/authorization.service';
import type { AuthzAction, AuthzActor } from '../authorization/authorization.types';
import { maxEmployeesFor, PLAN_CATALOG } from '../billing/billing.plans';
import { SkillCapabilities } from '../skills/capabilities';
import { SkillCatalog } from '../skills/catalog';
import {
  resolveProductContext,
  type CapabilityLookup,
  type CompanyContext,
} from './capability-resolver';

/**
 * Areas whose visibility genuinely depends on the authorization policy, and the
 * action that decides them.
 *
 * Everything absent from this map is authorized for any authenticated member of
 * the tenant — which is already true of the routes behind them (`/dashboard`,
 * `/billing`, `/marketplace` are JWT-only today). Listing them here with an
 * invented action would be the resolver pretending to enforce something the
 * endpoint does not, which is worse than not listing them: it would look like
 * a control while protecting nothing.
 */
const AREA_AUTHZ_ACTION: Partial<Record<ProductArea, AuthzAction>> = {
  EMPLOYEES: 'employee:read',
  KNOWLEDGE: 'knowledge:read',
  WORKFLOWS: 'workflow:read',
  SCHEDULES: 'workflow:read',
  ORGANIZATION: 'organization:manage',
  // SKILLS is deliberately ABSENT.
  //
  // It was mapped to `skill:connect`, which has an ADMIN floor — but
  // `GET /skills/catalog` and `GET /skills/installed` carry no
  // `@RequirePermission` at all: any member may read them, and the controller
  // says so explicitly ("the read-only catalog + installed list stay open").
  // Mapping the AREA to the MUTATION capability hid a page members are allowed
  // to open, i.e. the resolver invented a restriction the backend does not
  // have. Managing a connection is still ADMIN-only, enforced where it belongs.
  //
  // RUNS is absent for the mirror-image reason: `GET /workflows/runs` is
  // documented as "a read open to any member" and applies no filter, so
  // claiming `workflow:read` here would advertise an enforcement that endpoint
  // does not perform.
};

/**
 * The I/O shell around the pure `resolveProductContext`.
 *
 * Mirrors `AuthorizationService`'s own split — pure policy in one file, the
 * queries that feed it in another — so the whole scenario matrix is testable
 * without a database, and this class stays small enough to read in one sitting.
 *
 * Every query here is scoped by `companyId`. There is no cross-tenant path in
 * or out: the resolver receives only rows this tenant owns, and the caller's
 * `companyId` comes from the JWT, never from the request body.
 */
@Injectable()
export class ProductContextService {
  constructor(
    private readonly prisma: PrismaService,
    // NOT re-implemented here. Relevance narrows what this service already
    // decided; it never widens it.
    private readonly authz: AuthorizationService,
  ) {}

  /** The concrete capability registry, adapted to the resolver's port. */
  private readonly lookup: CapabilityLookup = {
    skillsFor: (capability: SkillCapability) => SkillCapabilities.skillsFor(capability),
    capabilitiesFor: (skillKey: string) => SkillCapabilities.capabilitiesFor(skillKey),
    displayName: (skillKey: string) => SkillCapabilities.displayName(skillKey),
    executionSupport: (skillKey: string) =>
      SkillCatalog.get(skillKey)?.executionSupport ?? 'SIMULATED',
    allSkillKeys: () => SkillCatalog.list().map((s) => s.key),
  };

  async resolve(
    companyId: string,
    user: { userId: string; role: 'OWNER' | 'ADMIN' | 'MEMBER' },
  ): Promise<ProductContextDto> {
    const [company, subscription, departments, employees, installedSkills, templates] =
      await Promise.all([
        this.prisma.company.findUniqueOrThrow({
          where: { id: companyId },
          select: { industry: true, size: true, businessGoals: true },
        }),
        this.prisma.subscription.findUnique({
          where: { companyId },
          select: { plan: true },
        }),
        this.prisma.department.findMany({
          where: { companyId },
          select: { name: true },
          orderBy: { createdAt: 'asc' },
        }),
        this.prisma.aiEmployee.findMany({
          // Archived employees are gone from the customer's roster (Phase 1),
          // so they must not keep unlocking product areas from the grave.
          where: { companyId, archivedAt: null },
          select: { id: true, role: true, status: true },
          orderBy: { createdAt: 'asc' },
        }),
        this.prisma.installedSkill.findMany({
          where: { companyId, enabled: true },
          select: { skillKey: true, connectionStatus: true },
          // Explicit order: Postgres guarantees none without it, and the
          // resolver's output must not depend on physical row order.
          orderBy: { skillKey: 'asc' },
        }),
        this.prisma.workflowTemplate.findMany({
          where: { OR: [{ companyId: null, status: 'PUBLISHED' }, { companyId }] },
          select: { id: true, key: true, name: true, category: true, requires: true },
          orderBy: { key: 'asc' },
        }),
      ]);

    // A company with no Subscription row falls back to STARTER, matching
    // BillingService's own self-healing default. Failing here would lock a
    // tenant out of its own navigation over a billing bookkeeping gap.
    const plan: Plan = (subscription?.plan as Plan | undefined) ?? 'STARTER';

    const actor = await this.authz.actorById(companyId, user.userId);
    const authorizedAreas = await this.resolveAuthorizedAreas(companyId, actor);
    const visibleEmployeeIds = await this.resolveVisibleEmployees(
      companyId,
      actor,
      employees,
    );

    const ctx: CompanyContext = {
      companyId,
      company: {
        industry: company.industry,
        size: company.size,
        businessGoals: company.businessGoals,
      },
      subscription: {
        plan,
        maxEmployees: maxEmployeesFor(plan),
        features: [...PLAN_CATALOG[plan].features],
      },
      departments: departments.map((d) => d.name),
      hiredEmployees: employees.map((e) => ({
        id: e.id,
        role: e.role,
        status: e.status,
      })),
      installedSkills: installedSkills.map((s) => ({
        skillKey: s.skillKey,
        connectionStatus: s.connectionStatus,
      })),
      user,
      authorizedAreas,
      visibleEmployeeIds,
      templates: templates.map((t) => ({
        id: t.id,
        key: t.key,
        name: t.name,
        category: t.category,
        requires: (t.requires as CompanyContext['templates'][number]['requires']) ?? {
          skills: [],
          employeeRoles: [],
        },
      })),
    };

    return resolveProductContext(ctx, this.lookup);
  }

  /**
   * Ask the REAL policy which areas this user may reach.
   *
   * `actor` is null only for a machine caller with no user row, which cannot
   * happen on this JWT-guarded endpoint; treating it as unrestricted matches
   * every other service's convention rather than inventing a new one.
   */
  private async resolveAuthorizedAreas(
    companyId: string,
    actor: AuthzActor | null,
  ): Promise<Set<ProductArea>> {
    if (!actor) return new Set(PRODUCT_AREAS);
    const allowed = new Set<ProductArea>();

    // Areas no capability governs are allowed here rather than being given an
    // invented action string the policy would fail closed on.
    const governed = new Map<AuthzAction, ProductArea[]>();
    for (const area of PRODUCT_AREAS) {
      const action = AREA_AUTHZ_ACTION[area];
      if (!action) {
        allowed.add(area);
        continue;
      }
      governed.set(action, [...(governed.get(action) ?? []), area]);
    }

    // BATCHED, one call per distinct action rather than one per area.
    //
    // `authorize()` resolves the actor's department on EVERY call, so the
    // original per-area loop re-read the same `Department` row five times for
    // any user who is actually placed in one — on an endpoint the shell hits
    // on every page. `filter()` is the existing batch form of the same policy
    // and does that lookup once for a whole list; this is what it is for.
    await Promise.all(
      [...governed.entries()].map(async ([action, areas]) => {
        const visible = await this.authz.filter(actor, action, areas, (area) => ({
          // Area-level question: no specific resource, so no `scope`. A
          // department-scoped user is still allowed INTO the area; which rows
          // they see inside it is decided per-resource by the services that own
          // them (and by `visibleEmployeeIds` below).
          type: areaResourceType(area),
          companyId,
        }));
        for (const area of visible) allowed.add(area);
      }),
    );
    return allowed;
  }

  /** Employee ids this user may see, through the existing policy filter. */
  private async resolveVisibleEmployees(
    companyId: string,
    actor: AuthzActor | null,
    employees: Array<{ id: string; role: EmployeeRole }>,
  ): Promise<string[]> {
    if (!actor) return employees.map((e) => e.id);
    const visible = await this.authz.filter(
      actor,
      'employee:read',
      employees,
      (e) => ({ type: 'employee', companyId, id: e.id, scope: e.role }),
    );
    return visible.map((e) => e.id);
  }
}

/** Map an area onto the resource type its capability is declared against. */
function areaResourceType(area: ProductArea): 'employee' | 'knowledge' | 'workflow' | 'skill' | 'organization' {
  switch (area) {
    case 'EMPLOYEES':
      return 'employee';
    case 'KNOWLEDGE':
      return 'knowledge';
    case 'SKILLS':
      return 'skill';
    case 'ORGANIZATION':
      return 'organization';
    default:
      return 'workflow';
  }
}
