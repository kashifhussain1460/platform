import type {
  AvailableTemplateDto,
  EmployeeRole,
  EntitlementsDto,
  Plan,
  ProductArea,
  ProductContextDto,
  RecommendedSkillDto,
  RelevanceReason,
  ResolvedNavItemDto,
  SkillCapability,
  SkillStatusDto,
  SkillExecutionSupport,
} from '@vaep/types';
import { PRODUCT_AREAS } from '@vaep/types';
import {
  AREA_MIN_PLAN,
  AREA_MIN_ROLE,
  AREA_NAV,
  CORE_AREAS,
  DEPARTMENT_EMPLOYEE_ROLES,
  EMPLOYEE_ROLE_AREAS,
  EMPLOYEE_ROLE_CAPABILITIES,
  GOAL_CAPABILITIES,
  INDUSTRY_CAPABILITIES,
  normalizeKey,
  planMeetsMinimum,
} from './relevance.map';

/**
 * THE capability resolver — a PURE function.
 *
 * Same shape as `authorization.policy.decide()`, and for the same reason: every
 * input is a value the caller already loaded, so the whole A–H scenario matrix
 * can be tested exhaustively without Postgres, Redis or a Nest context.
 * `ProductContextService` is the thin I/O shell that fetches the rows and calls
 * this.
 *
 * ## What it is NOT
 *
 * It is not an authorization layer. `authorizedAreas` and `visibleEmployeeIds`
 * arrive already decided by `AuthorizationService`; this function intersects
 * with them and can only ever REMOVE. Nothing here can grant a user access to
 * anything, and the endpoints being navigated to keep their own guards.
 *
 * ## The composition rule
 *
 *     RELEVANT  ∧  ENTITLED  ∧  AUTHORIZED  →  available
 *
 * Relevance answers "is this useful for this company?", entitlement answers
 * "does the plan include it?", authorization answers "may this user?". Three
 * different questions with three different owners, ANDed exactly once, here.
 */

/** Everything the resolver needs, already loaded. No Prisma types leak in. */
export interface CompanyContext {
  companyId: string;
  company: {
    industry: string | null;
    size: string | null;
    businessGoals: string[];
  };
  subscription: { plan: Plan; maxEmployees: number | null; features: string[] };
  /** Department NAMES for this tenant (Phase 2 made these real). */
  departments: string[];
  /** Non-archived AI Employees the tenant has hired. */
  hiredEmployees: Array<{ id: string; role: EmployeeRole; status: string }>;
  installedSkills: Array<{ skillKey: string; connectionStatus: string }>;
  user: { userId: string; role: 'OWNER' | 'ADMIN' | 'MEMBER' };
  /** Areas `AuthorizationService` says this user may reach. Intersected, never widened. */
  authorizedAreas: ReadonlySet<ProductArea>;
  /** Employee ids the authorization policy already filtered for this user. */
  visibleEmployeeIds: readonly string[];
  templates: Array<{
    id: string;
    key: string;
    name: string;
    category: AvailableTemplateDto['category'];
    requires: { skills: string[]; employeeRoles: EmployeeRole[]; minPlan?: Plan };
  }>;
}

/** Injected so the resolver stays pure — the real one is `SkillCapabilities`. */
export interface CapabilityLookup {
  /** Catalog skills that can satisfy a capability. */
  skillsFor(capability: SkillCapability): string[];
  /** Capabilities a skill provides. */
  capabilitiesFor(skillKey: string): SkillCapability[];
  displayName(skillKey: string): string;
  executionSupport(skillKey: string): SkillExecutionSupport;
  /** Every skill in the code catalog — the population `skillStatuses` covers. */
  allSkillKeys(): string[];
}

const ROLE_RANK: Record<'MEMBER' | 'ADMIN' | 'OWNER', number> = {
  MEMBER: 0,
  ADMIN: 1,
  OWNER: 2,
};

/**
 * True when the company has told us essentially nothing.
 *
 * Drives the single most important behaviour in this file: an unconfigured
 * company gets EVERYTHING as relevant. Roughly every tenant that onboarded
 * before Phase 2 is in this state (the wizard sent `departments: []` and
 * nothing read industry or goals), so treating "no signal" as "narrow the
 * product" would have silently shrunk the app for the entire existing customer
 * base on deploy day.
 */
export function isMinimallyConfigured(ctx: CompanyContext): boolean {
  return (
    !ctx.company.industry &&
    ctx.company.businessGoals.length === 0 &&
    ctx.departments.length === 0 &&
    ctx.hiredEmployees.length === 0
  );
}

/** Capabilities this company plausibly needs, with the reason each was added. */
export function resolveRelevantCapabilities(
  ctx: CompanyContext,
): Map<SkillCapability, RelevanceReason> {
  const out = new Map<SkillCapability, RelevanceReason>();
  // First reason wins: a capability justified by an actual hire is better
  // explained that way than by an industry guess.
  const add = (capability: SkillCapability, reason: RelevanceReason) => {
    if (!out.has(capability)) out.set(capability, reason);
  };

  for (const employee of ctx.hiredEmployees) {
    for (const c of EMPLOYEE_ROLE_CAPABILITIES[employee.role] ?? []) {
      add(c, 'HIRED_EMPLOYEE');
    }
  }
  for (const goal of ctx.company.businessGoals) {
    for (const c of GOAL_CAPABILITIES[normalizeKey(goal)] ?? []) {
      add(c, 'BUSINESS_GOAL');
    }
  }
  if (ctx.company.industry) {
    for (const c of INDUSTRY_CAPABILITIES[normalizeKey(ctx.company.industry)] ?? []) {
      add(c, 'INDUSTRY');
    }
  }
  // Departments imply the employee roles that work in them, which imply
  // capabilities — even before anyone has been hired for them.
  for (const department of ctx.departments) {
    for (const role of DEPARTMENT_EMPLOYEE_ROLES[normalizeKey(department)] ?? []) {
      for (const c of EMPLOYEE_ROLE_CAPABILITIES[role] ?? []) {
        add(c, 'DEPARTMENT');
      }
    }
  }
  return out;
}

/** Areas that are RELEVANT (before entitlement and authorization). */
function resolveRelevantAreas(
  ctx: CompanyContext,
  unconfigured: boolean,
): Map<ProductArea, RelevanceReason> {
  const out = new Map<ProductArea, RelevanceReason>();
  for (const area of CORE_AREAS) out.set(area, 'CORE');

  if (unconfigured) {
    // Nothing to personalise on. Offer the whole product rather than a
    // guess — discovering the app is how a new company configures it.
    for (const area of PRODUCT_AREAS) {
      if (!out.has(area)) out.set(area, 'NO_CONFIGURATION');
    }
    return out;
  }

  for (const employee of ctx.hiredEmployees) {
    for (const area of EMPLOYEE_ROLE_AREAS[employee.role] ?? []) {
      if (!out.has(area)) out.set(area, 'HIRED_EMPLOYEE');
    }
  }
  // A department implies the areas its roles would unlock, so a company that
  // created an HR department sees interview scheduling before it hires anyone.
  for (const department of ctx.departments) {
    for (const role of DEPARTMENT_EMPLOYEE_ROLES[normalizeKey(department)] ?? []) {
      for (const area of EMPLOYEE_ROLE_AREAS[role] ?? []) {
        if (!out.has(area)) out.set(area, 'DEPARTMENT');
      }
    }
  }
  // Plan-gated areas are RELEVANT to everyone; the entitlement filter below is
  // what removes them. Keeping the two separate is what lets the UI say
  // "upgrade to unlock" instead of simply hiding the feature.
  for (const area of Object.keys(AREA_MIN_PLAN) as ProductArea[]) {
    if (!out.has(area)) out.set(area, 'CORE');
  }
  for (const area of Object.keys(AREA_MIN_ROLE) as ProductArea[]) {
    if (!out.has(area)) out.set(area, 'CORE');
  }
  return out;
}

/** Entitlement view of the plan, including what it locks and at what tier. */
function resolveEntitlements(
  ctx: CompanyContext,
  relevant: ReadonlyMap<ProductArea, RelevanceReason>,
): EntitlementsDto {
  const lockedAreas: EntitlementsDto['lockedAreas'] = [];
  for (const [area, requiresPlan] of Object.entries(AREA_MIN_PLAN) as Array<
    [ProductArea, Plan]
  >) {
    if (relevant.has(area) && !planMeetsMinimum(ctx.subscription.plan, requiresPlan)) {
      lockedAreas.push({ area, requiresPlan });
    }
  }
  return {
    plan: ctx.subscription.plan,
    features: ctx.subscription.features,
    maxEmployees: ctx.subscription.maxEmployees,
    lockedAreas,
  };
}

/** Skills already installed that serve at least one relevant capability. */
function resolveRelevantSkills(
  ctx: CompanyContext,
  capabilities: ReadonlyMap<SkillCapability, RelevanceReason>,
  lookup: CapabilityLookup,
  unconfigured: boolean,
): string[] {
  const installed = ctx.installedSkills.map((s) => s.skillKey);
  // Nothing to filter against — every installed skill is "relevant" because the
  // company chose to install it. Never tell someone the skill they connected
  // is irrelevant just because they skipped the wizard.
  if (unconfigured || capabilities.size === 0) return [...new Set(installed)].sort();

  const relevant = installed.filter((skillKey) =>
    lookup.capabilitiesFor(skillKey).some((c) => capabilities.has(c)),
  );
  // A skill with no capability mapping at all (e.g. `http`) is general-purpose,
  // not irrelevant — excluding it would be the resolver overreaching.
  const unmapped = installed.filter((k) => lookup.capabilitiesFor(k).length === 0);
  return [...new Set([...relevant, ...unmapped])].sort();
}

/** Not-yet-installed skills worth suggesting, each with a stated reason. */
function resolveRecommendedSkills(
  ctx: CompanyContext,
  capabilities: ReadonlyMap<SkillCapability, RelevanceReason>,
  lookup: CapabilityLookup,
): RecommendedSkillDto[] {
  const installed = new Set(ctx.installedSkills.map((s) => s.skillKey));
  const out: RecommendedSkillDto[] = [];
  const seen = new Set<string>();

  // Sorted for determinism: the same configuration must always produce the same
  // list in the same order, or this is untestable and the UI flickers.
  const ordered = [...capabilities.entries()].sort(([a], [b]) => a.localeCompare(b));

  for (const [capability, reason] of ordered) {
    // Already covered by something installed → not a recommendation.
    const covered = [...installed].some((k) =>
      lookup.capabilitiesFor(k).includes(capability),
    );
    if (covered) continue;

    for (const skillKey of lookup.skillsFor(capability).slice().sort()) {
      if (installed.has(skillKey) || seen.has(skillKey)) continue;
      const executionSupport = lookup.executionSupport(skillKey);
      // Never recommend an integration that cannot perform a real action.
      // Suggesting HubSpot to a sales team, when every HubSpot write is
      // answered by the sandbox, is the "CONNECTED + SUCCESS" lie in a
      // different costume (Phase 1, §3).
      if (executionSupport === 'SIMULATED') continue;
      seen.add(skillKey);
      out.push({
        skillKey,
        name: lookup.displayName(skillKey),
        capability,
        reason,
        because: becauseSentence(ctx, reason, capability),
        executionSupport,
      });
      // One provider per capability is a recommendation; listing all of them is
      // a catalog, which the customer already has.
      break;
    }
  }
  return out;
}

/**
 * Categorise EVERY catalog skill for the discovery screen.
 *
 * Exhaustive on purpose. The brief's rule — "do not remove access to a
 * legitimately supported skill only because it is not recommended" — is
 * structural here rather than a matter of care: the function starts from the
 * whole catalog and assigns a status, so there is no code path that can drop
 * one. Relevance decides the LABEL and the sort order, never the membership.
 *
 * This is also the only consumer of `connectionStatus`, which the resolver
 * previously loaded and never read: an installed-but-DISCONNECTED skill is a
 * real, distinct state that the customer has to be told about, and calling it
 * "connected" because a row exists is the same class of lie as a green badge
 * over a mock executor.
 */
function resolveSkillStatuses(
  ctx: CompanyContext,
  recommended: readonly RecommendedSkillDto[],
  allSkillKeys: readonly string[],
  lookup: CapabilityLookup,
): SkillStatusDto[] {
  const installed = new Map(ctx.installedSkills.map((s) => [s.skillKey, s.connectionStatus]));
  const recommendedBy = new Map(recommended.map((r) => [r.skillKey, r.because]));

  const statuses = allSkillKeys.map((skillKey): SkillStatusDto => {
    const executionSupport = lookup.executionSupport(skillKey);
    const connectionStatus = installed.get(skillKey) ?? null;
    const name = lookup.displayName(skillKey);

    if (connectionStatus !== null) {
      // Installed. CONNECTED only when the connector actually says so —
      // DEGRADED and DISCONNECTED are failures the customer must see, and
      // NOT_CONNECTED means the install never finished.
      return {
        skillKey,
        name,
        status: connectionStatus === 'CONNECTED' ? 'CONNECTED' : 'NEEDS_CONFIGURATION',
        because: null,
        connectionStatus,
        executionSupport,
      };
    }
    if (executionSupport === 'SIMULATED') {
      // Still installable, still listed — but never dressed up as ready, and
      // never promoted to RECOMMENDED (the recommender skips these entirely).
      return {
        skillKey,
        name,
        status: 'SIMULATED_ONLY',
        because: null,
        connectionStatus: null,
        executionSupport,
      };
    }
    const because = recommendedBy.get(skillKey);
    return {
      skillKey,
      name,
      status: because ? 'RECOMMENDED' : 'AVAILABLE',
      because: because ?? null,
      connectionStatus: null,
      executionSupport,
    };
  });

  // Deterministic: status band first (most actionable first), then key.
  const rank: Record<SkillStatusDto['status'], number> = {
    NEEDS_CONFIGURATION: 0,
    RECOMMENDED: 1,
    CONNECTED: 2,
    AVAILABLE: 3,
    SIMULATED_ONLY: 4,
  };
  return statuses.sort(
    (a, b) => rank[a.status] - rank[b.status] || a.skillKey.localeCompare(b.skillKey),
  );
}

/** The specific configuration that triggered a recommendation, in plain words. */
function becauseSentence(
  ctx: CompanyContext,
  reason: RelevanceReason,
  capability: SkillCapability,
): string {
  switch (reason) {
    case 'HIRED_EMPLOYEE': {
      const role = ctx.hiredEmployees.find((e) =>
        (EMPLOYEE_ROLE_CAPABILITIES[e.role] ?? []).includes(capability),
      )?.role;
      return role
        ? `Your ${humanRole(role)} AI Employee needs this.`
        : 'One of your AI Employees needs this.';
    }
    case 'BUSINESS_GOAL': {
      const goal = ctx.company.businessGoals.find((g) =>
        (GOAL_CAPABILITIES[normalizeKey(g)] ?? []).includes(capability),
      );
      return goal ? `You chose "${goal}" as a goal.` : 'One of your goals needs this.';
    }
    case 'INDUSTRY':
      return `Common for ${ctx.company.industry} companies.`;
    case 'DEPARTMENT': {
      const department = ctx.departments.find((d) =>
        (DEPARTMENT_EMPLOYEE_ROLES[normalizeKey(d)] ?? []).some((r) =>
          (EMPLOYEE_ROLE_CAPABILITIES[r] ?? []).includes(capability),
        ),
      );
      return department
        ? `Your ${department} department works with this.`
        : 'One of your departments works with this.';
    }
    default:
      return 'Commonly used.';
  }
}

function humanRole(role: EmployeeRole): string {
  return role === 'HR'
    ? 'HR'
    : role
        .split('_')
        .map((w) => w.charAt(0) + w.slice(1).toLowerCase())
        .join(' ');
}

/**
 * Templates the company could install, and precisely what is missing when it
 * cannot.
 *
 * The prerequisites are the template's OWN `requires` block, already enforced
 * at install time with a 422 — this reads the same data so the browse list can
 * say "you need Gmail" up front instead of letting the customer click and fail.
 * No second prerequisite vocabulary is invented.
 */
function resolveTemplates(ctx: CompanyContext): AvailableTemplateDto[] {
  const installed = new Set(ctx.installedSkills.map((s) => s.skillKey));
  const hiredRoles = new Set(ctx.hiredEmployees.map((e) => e.role));

  return ctx.templates
    .map((t) => {
      const missingSkills = (t.requires.skills ?? []).filter((s) => !installed.has(s));
      const missingEmployeeRoles = (t.requires.employeeRoles ?? []).filter(
        (r) => !hiredRoles.has(r),
      );
      const planOk = t.requires.minPlan
        ? planMeetsMinimum(ctx.subscription.plan, t.requires.minPlan)
        : true;
      return {
        id: t.id,
        key: t.key,
        name: t.name,
        category: t.category,
        ready: missingSkills.length === 0 && missingEmployeeRoles.length === 0 && planOk,
        missingSkills,
        missingEmployeeRoles,
        requiresPlan: planOk ? null : (t.requires.minPlan ?? null),
      };
    })
    .sort((a, b) => a.key.localeCompare(b.key));
}

/**
 * Dashboard sections worth rendering.
 *
 * Phase 4 consumes this; Phase 3 only has to produce it deterministically. The
 * company summary is unconditional — a dashboard with nothing on it is worse
 * than a generic one.
 */
function resolveDashboardCapabilities(ctx: CompanyContext): string[] {
  const out = new Set<string>(['COMPANY_SUMMARY']);
  for (const employee of ctx.hiredEmployees) {
    out.add(`EMPLOYEE_${employee.role}`);
  }
  if (ctx.hiredEmployees.length > 0) out.add('EMPLOYEE_ACTIVITY');
  return [...out].sort();
}

/** The one entry point. Deterministic for a given context. */
export function resolveProductContext(
  ctx: CompanyContext,
  lookup: CapabilityLookup,
): ProductContextDto {
  const unconfigured = isMinimallyConfigured(ctx);
  const capabilities = resolveRelevantCapabilities(ctx);
  const recommendedSkills = resolveRecommendedSkills(ctx, capabilities, lookup);
  const relevantAreas = resolveRelevantAreas(ctx, unconfigured);
  const entitlements = resolveEntitlements(ctx, relevantAreas);
  const locked = new Set(entitlements.lockedAreas.map((l) => l.area));

  //  RELEVANT ∧ ENTITLED ∧ AUTHORIZED — the composition rule, applied once.
  const areaReasons: Record<string, RelevanceReason> = {};
  const productAreas: ProductArea[] = [];
  for (const area of PRODUCT_AREAS) {
    const reason = relevantAreas.get(area);
    if (!reason) continue;
    if (locked.has(area)) continue;
    const minRole = AREA_MIN_ROLE[area];
    if (minRole && ROLE_RANK[ctx.user.role] < ROLE_RANK[minRole]) continue;
    // The authoritative check. Relevance can only ever narrow what the
    // authorization layer already permitted.
    if (!ctx.authorizedAreas.has(area)) continue;
    productAreas.push(area);
    areaReasons[area] = reason;
  }

  const navigation: ResolvedNavItemDto[] = productAreas.map((area) => ({
    area,
    ...AREA_NAV[area],
  }));

  return {
    companyId: ctx.companyId,
    configuration: {
      industry: ctx.company.industry,
      size: ctx.company.size,
      businessGoals: ctx.company.businessGoals,
      departments: ctx.departments,
      hiredEmployeeRoles: [...new Set(ctx.hiredEmployees.map((e) => e.role))].sort(),
      isMinimallyConfigured: unconfigured,
    },
    entitlements,
    productAreas,
    areaReasons,
    navigation,
    dashboardCapabilities: resolveDashboardCapabilities(ctx),
    relevantSkills: resolveRelevantSkills(ctx, capabilities, lookup, unconfigured),
    recommendedSkills: recommendedSkills,
    skillStatuses: resolveSkillStatuses(
      ctx,
      recommendedSkills,
      lookup.allSkillKeys(),
      lookup,
    ),
    availableWorkflowTemplates: resolveTemplates(ctx),
    relevantEmployeeIds: [...ctx.visibleEmployeeIds].sort(),
  };
}
