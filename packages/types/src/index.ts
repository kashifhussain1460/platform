/**
 * @vaep/types — shared DTO/type definitions.
 *
 * Single source of truth consumed by BOTH the web app and the API.
 * The API imports these as `import type { ... }` (erased at build time, so it
 * never pulls zod into the Nest runtime — it validates with class-validator).
 * The web app uses the zod schemas for react-hook-form validation.
 */
import { z } from 'zod';
import {
  conditionSchema,
  kpiTargetsSchema,
  triggerConfigSchema,
  workflowDefinitionSchema,
} from './shared-schemas';

// Re-exported so `import { workflowDefinitionSchema } from '@vaep/types'` (the
// existing public surface) is unchanged — only where they're DEFINED moved.
// See shared-schemas.ts for why: response-schemas.ts needs these as runtime
// values and this file re-exports response-schemas.ts wholesale, so defining
// them here created a circular import (a live TDZ crash, not theoretical —
// reproduced via browser-testing /onboarding).
export {
  conditionSchema,
  kpiTargetsSchema,
  triggerConfigSchema,
  workflowDefinitionSchema,
};

/** Tenant membership role. */
export type Role = 'OWNER' | 'ADMIN' | 'MEMBER';

export const ROLES: readonly Role[] = ['OWNER', 'ADMIN', 'MEMBER'] as const;

/** Whether a user account may authenticate. DISABLED users are rejected at login. */
export type UserStatus = 'ACTIVE' | 'DISABLED';

export const USER_STATUSES: readonly UserStatus[] = ['ACTIVE', 'DISABLED'] as const;

// ---------------------------------------------------------------------------
// Zod schemas (shared validation contract) — web uses these directly.
// ---------------------------------------------------------------------------

/**
 * Canonical password policy — the SINGLE source for both the frontend (zod) and
 * the backend (class-validator via these regexes). Secure without friction:
 * ≥8 chars, at least one letter and one number. Backend validation is
 * authoritative; the frontend mirrors it for immediate feedback.
 */
export const PASSWORD_MIN_LENGTH = 8;
export const PASSWORD_HAS_LETTER = /[A-Za-z]/;
export const PASSWORD_HAS_NUMBER = /[0-9]/;
export const passwordSchema = z
  .string()
  .min(PASSWORD_MIN_LENGTH, `Use at least ${PASSWORD_MIN_LENGTH} characters`)
  .max(200)
  .regex(PASSWORD_HAS_LETTER, 'Include at least one letter')
  .regex(PASSWORD_HAS_NUMBER, 'Include at least one number');

export const registerSchema = z.object({
  companyName: z.string().min(2, 'Company name is too short').max(120),
  name: z.string().min(1, 'Your name is required').max(120),
  email: z.string().email('Enter a valid email'),
  password: passwordSchema,
  // Optional company profile (Step 2 richer registration) + admin phone.
  industry: z.string().max(120).optional(),
  size: z.string().max(40).optional(),
  country: z.string().max(120).optional(),
  timezone: z.string().max(80).optional(),
  website: z.string().max(200).optional(),
  logoUrl: z.string().max(500).optional(),
  description: z.string().max(2000).optional(),
  phone: z.string().max(40).optional(),
});

export const loginSchema = z.object({
  email: z.string().email('Enter a valid email'),
  password: z.string().min(1, 'Password is required'),
});

/** Knowledge search form/body contract — web uses this directly (rhf + zod). */
export const searchSchema = z.object({
  query: z.string().min(1, 'Enter a search query').max(1000),
  k: z.number().int().min(1).max(50).optional(),
  // Hardcoded (not EMPLOYEE_ROLES) because EMPLOYEE_ROLES is declared later in
  // this file as a `const` — referencing it here would hit the temporal dead
  // zone at module-eval time. Keep in sync with EMPLOYEE_ROLES below.
  category: z
    .enum(['SUPPORT', 'SALES', 'RECRUITER', 'HR', 'ACCOUNTANT', 'PROJECT_MANAGER', 'CUSTOM', 'MARKETING'])
    .optional(),
});

// ---------------------------------------------------------------------------
// DTOs / API contract types.
// ---------------------------------------------------------------------------

/** POST /auth/register body. */
export type RegisterDto = z.infer<typeof registerSchema>;

/** POST /auth/login body. */
export type LoginDto = z.infer<typeof loginSchema>;

/** Tokens returned by register/login. Refresh travels as an httpOnly cookie. */
export interface AuthTokens {
  accessToken: string;
  /** Present only when cookies are unavailable (e.g. non-browser clients). */
  refreshToken?: string;
}

/** Public shape of a user (never includes passwordHash). */
export interface UserDto {
  id: string;
  companyId: string;
  email: string;
  name: string;
  phone: string | null;
  role: Role;
  status: UserStatus;
  /** True once the user has confirmed their email OTP. Drives post-login routing. */
  emailVerified: boolean;
  /** P3-05 org-structure links — used to group/target users in approval routing + workflow permissions. */
  departmentId: string | null;
  teamId: string | null;
  managerUserId: string | null;
  createdAt: string;
}

/** Public shape of a company/tenant. */
export interface CompanyDto {
  id: string;
  name: string;
  slug: string;
  industry: string | null;
  size: string | null;
  country: string | null;
  timezone: string | null;
  website: string | null;
  logoUrl: string | null;
  description: string | null;
  /** Set when the AI Onboarding Wizard is completed; null = not yet onboarded. */
  onboardedAt: string | null;
  createdAt: string;
}

/** PATCH /companies/current body — update the company profile. */
export const updateCompanySchema = z.object({
  name: z.string().min(2).max(120).optional(),
  industry: z.string().max(120).optional(),
  size: z.string().max(40).optional(),
  country: z.string().max(120).optional(),
  timezone: z.string().max(80).optional(),
  website: z.string().max(200).optional(),
  logoUrl: z.string().max(500).optional(),
  description: z.string().max(2000).optional(),
});

export type UpdateCompanyDto = z.infer<typeof updateCompanySchema>;

/** GET /auth/me response. */
export interface MeDto {
  user: UserDto;
  company: CompanyDto;
}

/** Response envelope for register/login. */
export interface AuthResponse {
  user: UserDto;
  company: CompanyDto;
  tokens: AuthTokens;
}

// ---------------------------------------------------------------------------
// User Management module contracts (RBAC, P0 governance).
// ---------------------------------------------------------------------------
// Company-scoped team management: an OWNER/ADMIN invites (adds) users, edits
// their role, enables/disables (blocks login), and deletes them. Guardrails:
// only an OWNER may create/grant OWNER; you cannot change your own role; the
// last OWNER cannot be demoted, disabled or deleted. Never exposes passwordHash.

/** POST /users body — add a user to the caller's company. */
export const createUserSchema = z.object({
  email: z.string().email('Enter a valid email'),
  name: z.string().min(1, 'Name is required').max(120),
  role: z.enum(['OWNER', 'ADMIN', 'MEMBER']),
  password: z
    .string()
    .min(8, 'Password must be at least 8 characters')
    .max(200),
});

/** PATCH /users/:id body — update name/role/status (all optional). */
export const updateUserSchema = z.object({
  name: z.string().min(1).max(120).optional(),
  role: z.enum(['OWNER', 'ADMIN', 'MEMBER']).optional(),
  status: z.enum(['ACTIVE', 'DISABLED']).optional(),
  /**
   * WAVE 2 department isolation, finally reachable.
   *
   * The scoping rules shipped with no way to PLACE a user in a department — the
   * column existed, the policy read it, and no API could set it, so the whole
   * feature was unreachable through the product. Found by the browser journey,
   * which could not do through the UI what the API-level test had done by
   * writing the column directly. `null` removes the placement.
   */
  departmentId: z.string().min(1).max(60).nullable().optional(),
  teamId: z.string().min(1).max(60).nullable().optional(),
});

export type CreateUserDto = z.infer<typeof createUserSchema>;
export type UpdateUserDto = z.infer<typeof updateUserSchema>;

// ---------------------------------------------------------------------------
// Knowledge / RAG module contracts.
// ---------------------------------------------------------------------------

/** Ingestion lifecycle of an uploaded knowledge document. */
export type DocumentStatus = 'PENDING' | 'PROCESSING' | 'READY' | 'FAILED';

export const DOCUMENT_STATUSES: readonly DocumentStatus[] = [
  'PENDING',
  'PROCESSING',
  'READY',
  'FAILED',
] as const;

/** Public shape of a knowledge document (never includes the storage key). */
export interface KnowledgeDocumentDto {
  id: string;
  companyId: string;
  filename: string;
  mimeType: string;
  sizeBytes: number;
  status: DocumentStatus;
  error: string | null;
  chunkCount: number;
  createdAt: string;
  /** null = Shared/company-wide; otherwise scoped to that AI-employee role. */
  category: EmployeeRole | null;
}

/** PATCH /knowledge/documents/:id/category body. `category: null` = Shared/company-wide. */
export interface UpdateDocumentCategoryDto {
  category: EmployeeRole | null;
}

/** POST /knowledge/search body. */
export type SearchQueryDto = z.infer<typeof searchSchema>;

/** A single vector-search hit returned by POST /knowledge/search. */
export interface SearchResultDto {
  chunkId: string;
  documentId: string;
  content: string;
  /** Cosine similarity in [0,1]; higher is closer. */
  score: number;
}

// ---------------------------------------------------------------------------
// AI Employee runtime module contracts.
// ---------------------------------------------------------------------------

/** The vertical an AI employee is specialised for. */
export type EmployeeRole =
  | 'SUPPORT'
  | 'SALES'
  | 'RECRUITER'
  | 'HR'
  | 'ACCOUNTANT'
  | 'PROJECT_MANAGER'
  | 'CUSTOM'
  | 'MARKETING';

export const EMPLOYEE_ROLES: readonly EmployeeRole[] = [
  'SUPPORT',
  'SALES',
  'RECRUITER',
  'HR',
  'ACCOUNTANT',
  'PROJECT_MANAGER',
  'CUSTOM',
  'MARKETING',
] as const;

/** Lifecycle status. Only ACTIVE employees accept new messages. */
export type EmployeeStatus = 'ACTIVE' | 'PAUSED' | 'DISABLED';

export const EMPLOYEE_STATUSES: readonly EmployeeStatus[] = [
  'ACTIVE',
  'PAUSED',
  'DISABLED',
] as const;

/** Whether an employee may retrieve from the company knowledge base. */
export type KnowledgeAccess = 'ALL' | 'NONE';

export const KNOWLEDGE_ACCESSES: readonly KnowledgeAccess[] = [
  'ALL',
  'NONE',
] as const;

/**
 * Business departments (used by the onboarding wizard + employee catalog).
 * MARKETING added alongside the MARKETING EmployeeRole — without it, a company
 * could never select "Marketing" during onboarding, so the AI Marketing
 * Employee (and every Marketing workflow template, all of which require an
 * employee with this role) was permanently unreachable from onboarding.
 */
export type Department =
  | 'SALES'
  | 'HR'
  | 'CUSTOMER_SUPPORT'
  | 'RECRUITMENT'
  | 'FINANCE'
  | 'MARKETING';

export const DEPARTMENTS: readonly Department[] = [
  'SALES',
  'HR',
  'CUSTOMER_SUPPORT',
  'RECRUITMENT',
  'FINANCE',
  'MARKETING',
] as const;

/** Author of a conversation message. */
export type MessageRole = 'USER' | 'ASSISTANT' | 'SYSTEM';

// --- Zod schemas (shared with the web forms) -------------------------------

/** POST /employees body. */
export const createEmployeeSchema = z.object({
  name: z.string().min(1, 'Name is required').max(120),
  role: z.enum([
    'SUPPORT',
    'SALES',
    'RECRUITER',
    'HR',
    'ACCOUNTANT',
    'PROJECT_MANAGER',
    'CUSTOM',
    'MARKETING',
  ]),
  persona: z.string().max(2000).optional(),
  model: z.string().max(120).optional(),
});

/**
 * Configurable KPI targets for an AI employee (P1 #6). All optional; a computed
 * "attainment" (actual vs target) is surfaced on the analytics EmployeeKpiDto.
 * tasksPerWeek/approvalsMax are counts; successRatePct is a percent in [0,100].
 */
export interface KpiTargets {
  tasksPerWeek?: number;
  successRatePct?: number;
  approvalsMax?: number;
}

/**
 * Rich AI-employee configuration (Step 5). Shared by the employee settings
 * panel. All fields optional; folded into the PATCH /employees/:id body.
 */
export const employeeConfigSchema = z.object({
  department: z.string().max(120).optional(),
  managerName: z.string().max(120).optional(),
  workingHoursStart: z.string().max(10).optional(),
  workingHoursEnd: z.string().max(10).optional(),
  timezone: z.string().max(80).optional(),
  language: z.string().max(80).optional(),
  knowledgeAccess: z.enum(['ALL', 'NONE']).optional(),
  budgetLimit: z.number().int().min(0).max(100000000).nullable().optional(),
  // Credit system §20 — validate identically to `budgetLimit` (int, [0, ceiling], nullable).
  maxCreditsPerExecution: z.number().int().min(0).max(100000000).nullable().optional(),
  maxCreditsPerTask: z.number().int().min(0).max(100000000).nullable().optional(),
  // Phase 1 safety fix: both were `z.record(...)` — any key at all was accepted
  // and persisted, which is exactly how the settings panel came to write seven
  // flags that no runtime path read. Narrowed to the keys that ARE enforced;
  // zod's default object behaviour strips anything else, so a legacy client
  // still sending `approveOverBudget`/`approveRefunds` no longer stores a flag
  // that does nothing.
  permissions: z
    .object({
      sendEmail: z.boolean().optional(),
      contactCustomers: z.boolean().optional(),
      makePayments: z.boolean().optional(),
      accessKnowledge: z.boolean().optional(),
    })
    .optional(),
  approvalRules: z
    .object({
      requireApprovalForAllTools: z.boolean().optional(),
      requireApprovalForTools: z.array(z.string().min(1).max(120)).max(200).optional(),
      approveExternalMessages: z.boolean().optional(),
      // P3-05 routing is a nested config object owned by the approvals module;
      // passed through untouched rather than re-declared here. `z.custom` (not
      // `z.unknown`) so the inferred form type stays assignable to
      // `ApprovalRules` — otherwise every consumer has to re-cast it, which is
      // how a shape drifts.
      routing: z.custom<ApprovalRoutingConfig>().optional(),
    })
    .optional(),
  // Goals + KPI targets (P1 #6). goals is a free-form checklist of objectives;
  // kpiTargets configures the actual-vs-target attainment shown in analytics.
  goals: z.array(z.string().min(1).max(200)).max(50).optional(),
  kpiTargets: kpiTargetsSchema.nullable().optional(),
});

/** PATCH /employees/:id body (status pause/disable, persona, model, name, rich config). */
export const updateEmployeeSchema = z
  .object({
    name: z.string().min(1).max(120).optional(),
    status: z.enum(['ACTIVE', 'PAUSED', 'DISABLED']).optional(),
    persona: z.string().max(2000).optional(),
    model: z.string().max(120).optional(),
  })
  .merge(employeeConfigSchema);

/** POST /conversations/:id/messages body. */
export const sendMessageSchema = z.object({
  content: z.string().min(1, 'Enter a message').max(4000),
});

export type CreateEmployeeDto = z.infer<typeof createEmployeeSchema>;
export type UpdateEmployeeDto = z.infer<typeof updateEmployeeSchema>;
export type EmployeeConfigDto = z.infer<typeof employeeConfigSchema>;
export type SendMessageDto = z.infer<typeof sendMessageSchema>;

// --- DTOs / API contract types ---------------------------------------------

/** Public shape of an AI employee. */
export interface AiEmployeeDto {
  id: string;
  companyId: string;
  name: string;
  role: EmployeeRole;
  status: EmployeeStatus;
  persona: string | null;
  model: string | null;
  department: string | null;
  managerName: string | null;
  workingHoursStart: string | null;
  workingHoursEnd: string | null;
  timezone: string | null;
  language: string | null;
  knowledgeAccess: KnowledgeAccess;
  budgetLimit: number | null;
  /** Real AI-usage spend so far this calendar month (estimatedCostUsd across
   * this employee's UsageEvent rows) -- enforced against budgetLimit for
   * chat and workflow AI_STEP; null when budgetLimit itself is unset. */
  monthToDateCostUsd: number | null;
  /**
   * Credit system §20 — a per-single-execution credit ceiling, additive
   * alongside `budgetLimit` (the existing MONTHLY dollar cap). Null =
   * unlimited. Not yet enforced by any runtime check (Task 9.8 is the
   * settings-field UI only); a future phase wires the actual gate.
   */
  maxCreditsPerExecution: number | null;
  /** Same, scoped to one task/tool-call rather than a whole run. Null = unlimited. */
  maxCreditsPerTask: number | null;
  /** Capability permissions. Key absent = allowed; `false` = denied at runtime. */
  permissions: EmployeePermissions | null;
  approvalRules: ApprovalRules | null;
  /** Free-form list of objectives for this employee (P1 #6); null when unset. */
  goals: string[] | null;
  /** Configurable KPI targets driving analytics attainment (P1 #6); null when unset. */
  kpiTargets: KpiTargets | null;
  /**
   * Set when the employee was ARCHIVED via `DELETE /employees/:id` (the soft
   * default). Mirrors `Workflow.archivedAt`: history, credentials and audit
   * rows are retained, the employee simply leaves the active roster. Null for a
   * live employee — including one merely PAUSED or DISABLED by hand.
   */
  archivedAt: string | null;
  createdAt: string;
}

/**
 * What `DELETE /employees/:id` would destroy, returned so the caller can decide
 * between archiving and erasing. Mirrors the workflow delete flow's 409 body.
 */
export interface EmployeeDependenciesDto {
  employeeId: string;
  name: string;
  /** Per-employee skill connections — deleting the employee deletes their stored credentials. */
  ownedConnections: number;
  conversations: number;
  memories: number;
  skillGrants: number;
  /** Historical tool-execution audit rows attributed to this employee. */
  skillExecutions: number;
  /** Approval requests raised by this employee (any status). */
  approvalRequests: number;
  /** Approval requests still awaiting a human decision — blocks a hard delete. */
  pendingApprovals: number;
  /** Workflows whose graph names this employee in a node config. */
  referencingWorkflows: number;
  /** Runs of those workflows still in flight — blocks any delete. */
  inFlightRuns: number;
}

/** A conversation thread with one AI employee. */
export interface ConversationDto {
  id: string;
  companyId: string;
  employeeId: string;
  title: string | null;
  createdAt: string;
}

/** S-06: the sensitive-scenario categories `SensitiveScenarioService` detects. */
export type SensitiveScenarioCategory =
  | 'ACCOUNT_DELETION'
  | 'LEGAL_THREAT'
  | 'SECURITY_INCIDENT'
  | 'PII_EXPOSURE'
  | 'IDENTITY_VERIFICATION'
  | 'REFUND'
  | 'HUMAN_REQUESTED'
  | 'HIGH_RISK_SENTIMENT';

/** A detected sensitive scenario — which category, and how it was matched. */
export interface SensitiveScenarioSignal {
  category: SensitiveScenarioCategory;
  method: 'KEYWORD' | 'SENTIMENT';
}

/** Verdict produced by the runtime ValidationService for an answer. */
export interface MessageValidationDto {
  /** True when the answer is backed by retrieved company knowledge. */
  grounded: boolean;
  /** Confidence in the answer, in [0,1]. */
  confidence: number;
  /** True when a human should approve before acting (low confidence / high-stakes role). */
  needsApproval: boolean;
  /** Human-readable rationale for the verdict. */
  notes?: string;
}

/** Structured runtime metadata persisted alongside an assistant message. */
export interface MessageMetadataDto {
  /** The step plan the runtime followed. */
  plan?: string[];
  /** Knowledge chunks cited while drafting the answer. */
  sources?: SearchResultDto[];
  /** Grounding / confidence verdict. */
  validation?: MessageValidationDto;
  /** Skill/tool actions the employee took during the run (empty when none). */
  toolCalls?: ToolCallDto[];
}

/** A single conversation message. */
export interface MessageDto {
  id: string;
  companyId: string;
  conversationId: string;
  role: MessageRole;
  content: string;
  metadata: MessageMetadataDto | null;
  createdAt: string;
}

/** Response of POST /conversations/:id/messages — the full agent run outcome. */
export interface RunResultDto {
  /** The persisted assistant message. */
  message: MessageDto;
  /** Step plan the agent followed. */
  plan: string[];
  /** Knowledge chunks retrieved and cited. */
  sources: SearchResultDto[];
  /** Grounding / confidence verdict. */
  validation: MessageValidationDto;
  /** Skill/tool actions taken during the run (empty when the employee used none). */
  toolCalls: ToolCallDto[];
  /**
   * True when the employee DECLINED the work as outside its role (e.g. an HR
   * employee asked to screen a CV). Chat shows the polite decline as an answer;
   * a workflow step must FAIL on it, because recording a refusal as finished
   * work sends the next step off with nothing.
   */
  outOfScope?: boolean;
  /**
   * Credit system Phase 9, Task 9.7 — the ceiling-based estimate priced at
   * reservation time (before the completion ran), alongside the actual
   * settled figure below. Chat is a single synchronous request/response, so
   * the frontend never sees this before `creditsCharged` — both arrive
   * together — but showing both is what makes the estimate-then-settle
   * relationship honest rather than presenting one number as if it were the
   * whole story.
   */
  estimatedCredits: number | null;
  /**
   * Actual credits settled for this turn's LLM completion. Null when the
   * ledger is disabled/shadow-mode couldn't price the call (never blocks the
   * chat response itself).
   */
  creditsCharged: number | null;
}

// ---------------------------------------------------------------------------
// Continuous Learning module contracts (Step 15).
// ---------------------------------------------------------------------------
// Managers give 👍/👎 feedback on AI outputs (optionally teaching a correction).
// A 👎 with a correction — or an explicit teach — is promoted to a durable FACT
// EmployeeMemory (source 'FEEDBACK') that the runtime recalls on future runs. The
// same durable memories are curated (list / manually teach / forget) here.

/** A manager's rating of an AI output. */
export type FeedbackRating = 'UP' | 'DOWN';

export const FEEDBACK_RATINGS: readonly FeedbackRating[] = ['UP', 'DOWN'] as const;

/** How a memory came to exist: from feedback, taught manually, or a run summary. */
export type MemorySource = 'FEEDBACK' | 'MANUAL' | 'RUN';

/** A durable long-term employee memory (recalled by the runtime by recency). */
export type MemoryKind = 'FACT' | 'SUMMARY';

export const MEMORY_KINDS: readonly MemoryKind[] = ['FACT', 'SUMMARY'] as const;

// --- Zod schemas (shared with the web forms) -------------------------------

/** POST /employees/:id/feedback body. */
export const createFeedbackSchema = z.object({
  conversationId: z.string().min(1).max(60).optional(),
  messageId: z.string().min(1).max(60).optional(),
  rating: z.enum(['UP', 'DOWN']),
  note: z.string().max(2000).optional(),
  /** A corrected/preferred answer — promoted to a durable FACT memory. */
  correction: z.string().max(2000).optional(),
  /** Force promoting `correction` (or `note`) to a durable memory even for 👍. */
  teach: z.boolean().optional(),
});

/** POST /employees/:id/memories body (manually teach a durable memory). */
export const createMemorySchema = z.object({
  kind: z.enum(['FACT', 'SUMMARY']),
  content: z.string().min(1, 'Enter something to teach').max(2000),
});

export type CreateFeedbackDto = z.infer<typeof createFeedbackSchema>;
export type CreateMemoryDto = z.infer<typeof createMemorySchema>;

// --- DTOs / API contract types ---------------------------------------------

/** A single piece of manager feedback on an AI output. */
export interface EmployeeFeedbackDto {
  id: string;
  companyId: string;
  employeeId: string;
  conversationId: string | null;
  messageId: string | null;
  rating: FeedbackRating;
  note: string | null;
  correction: string | null;
  createdAt: string;
}

/** A durable long-term employee memory row. */
export interface EmployeeMemoryDto {
  id: string;
  companyId: string;
  employeeId: string;
  kind: MemoryKind;
  content: string;
  /** Provenance: 'FEEDBACK' | 'MANUAL' | 'RUN'; null for legacy/summary writes. */
  source: MemorySource | null;
  createdAt: string;
}

/** GET /employees/:id/learning response — a compact learning summary. */
export interface LearningSummaryDto {
  feedback: { up: number; down: number; total: number };
  memories: { total: number; byKind: Record<MemoryKind, number> };
  /** Most recent feedback, newest first. */
  recentFeedback: EmployeeFeedbackDto[];
}

// ---------------------------------------------------------------------------
// Onboarding module contracts (Steps 2–5).
// ---------------------------------------------------------------------------
// The AI Onboarding Wizard: capture the company business profile, pick
// departments, then hire AI employees from a code-defined role catalog. The
// company itself remains the tenant; completing the wizard stamps
// company.onboardedAt.

/** A hireable AI-employee role template surfaced in the onboarding catalog. */
export interface EmployeeRoleTemplate {
  role: EmployeeRole;
  suggestedName: string;
  title: string;
  description: string;
  /** Departments this template belongs to (filtered by wizard selection). */
  departments: Department[];
}

/**
 * Business goals per AI-employee role — the canonical source for the onboarding
 * step-3 options AND the server-side goal reconciliation. Business goals are
 * preferences, NEVER authorization (do not consult for RBAC).
 */
export const EMPLOYEE_GOALS = {
  HR: [
    'Recruitment',
    'Candidate Screening',
    'Interview Scheduling',
    'Employee Onboarding',
    'HR Operations',
    'Performance Reviews',
    'Employee Offboarding',
  ],
  MARKETING: [
    'Content Creation',
    'Social Media',
    'Campaign Management',
    'Email Marketing',
    'SEO',
    'Lead Generation',
    'Marketing Analytics',
  ],
} as const satisfies Record<string, readonly string[]>;

/** The AI-employee roles selectable in minimal onboarding. */
export const ONBOARDING_ROLES = ['HR', 'MARKETING'] as const;
export type OnboardingRole = (typeof ONBOARDING_ROLES)[number];

/** The union of goals allowed for a set of selected roles (order-preserving, deduped). */
export function allowedGoalsForRoles(roles: readonly string[]): string[] {
  const goals = EMPLOYEE_GOALS as Record<string, readonly string[]>;
  const out: string[] = [];
  for (const role of roles) {
    for (const goal of goals[role] ?? []) {
      if (!out.includes(goal)) out.push(goal);
    }
  }
  return out;
}

/** GET /onboarding/status response. */
export interface OnboardingStatusDto {
  completed: boolean;
  /** Resumable step marker: NOT_STARTED | COMPANY_SETUP | AI_EMPLOYEE_SELECTION | BUSINESS_GOALS | DEPARTMENTS | COMPLETED. */
  step: string;
  company: { name: string; industry: string | null; size: string | null; website: string | null };
  selectedRoles: string[];
  goals: string[];
  /**
   * The department names ALREADY PERSISTED for this company — read back from
   * the `Department` table, not from a wizard draft.
   *
   * Status used to say nothing about departments while the wizard sent
   * `departments: []` on every signup, so "onboarding complete" was reported
   * for companies that had no organization structure at all. Reading the real
   * rows means the wizard can rehydrate accurately AND the status can never
   * claim a department that does not exist.
   */
  departments: string[];
}

/** POST /onboarding/complete body. */
export const completeOnboardingSchema = z.object({
  business: z
    .object({
      industry: z.string().max(120).optional(),
      size: z.string().max(40).optional(),
      description: z.string().max(2000).optional(),
    })
    .optional(),
  /**
   * Department NAMES to create for this company.
   *
   * Widened from 40 to 120 chars to match `Department.name`'s own limit — the
   * wizard now lets a company type its own names, and "Customer Success &
   * Renewals" is a real department, not an abuse case. Blank entries are
   * dropped server-side rather than becoming empty placeholder rows.
   */
  departments: z.array(z.string().max(120)),
  employees: z.array(
    z.object({
      role: z.enum([
        'SUPPORT',
        'SALES',
        'RECRUITER',
        'HR',
        'ACCOUNTANT',
        'PROJECT_MANAGER',
        'CUSTOM',
        'MARKETING',
      ]),
      name: z.string().max(120).optional(),
    }),
  ),
});

export type CompleteOnboardingDto = z.infer<typeof completeOnboardingSchema>;

/** POST /onboarding/complete response. */
export interface CompleteOnboardingResultDto {
  company: CompanyDto;
  employees: AiEmployeeDto[];
  /**
   * The Department rows the wizard's chosen departments resolved to. Previously
   * `departments` was collected by the wizard, sent, validated — and then
   * silently dropped on the floor. They are now persisted, and returned so the
   * client can prime its org cache without a second round trip.
   */
  departments: DepartmentDto[];
}

// ---------------------------------------------------------------------------
// Skills module contracts.
// ---------------------------------------------------------------------------
// A code-defined catalog of built-in skills, each exposing tools (actions). A
// company INSTALLS a skill; installed skills are ASSIGNED to employees; the
// runtime lets an employee CALL an assigned tool during its "act" step. Every
// execution is logged (audit). Executors are mock/sandbox by default.

/** Grouping used to organise the built-in catalog in the UI. */
export type SkillCategory =
  | 'communication'
  | 'payments'
  | 'development'
  | 'utility'
  | 'crm'
  | 'productivity'
  | 'marketing'
  | 'support'
  | 'project_management';

/**
 * How a skill authenticates against its (real) backend. `api_key` prompts for a
 * secret key; `oauth` is a stubbed connect flow (real OAuth = TODO); `none` needs
 * no connection (mock/sandbox executors run without one either way).
 */
export type SkillConnectionType = 'oauth' | 'api_key' | 'none';

/** Connection descriptor for a catalog skill. */
export interface SkillConnectionDto {
  type: SkillConnectionType;
  /** Human label for the connect action, e.g. "Connect Slack". */
  label?: string;
}

/**
 * Connection/health state of an installed skill acting as a connector.
 * NOT_CONNECTED (initial) · CONNECTED (healthy) · DEGRADED (auth OK but recent
 * egress/health failures — quarantines dependent workflows) · DISCONNECTED
 * (needs re-auth: refresh failed / grant revoked). Transitions are owned solely
 * by ConnectorHealthService (docs §1.7).
 */
export type SkillConnectionStatus =
  | 'NOT_CONNECTED'
  | 'CONNECTED'
  | 'DEGRADED'
  | 'DISCONNECTED';

export const SKILL_CONNECTION_STATUSES: readonly SkillConnectionStatus[] = [
  'NOT_CONNECTED',
  'CONNECTED',
  'DEGRADED',
  'DISCONNECTED',
] as const;

/** A field in a skill's company-specific configuration form. */
export type ConfigFieldType =
  | 'string'
  | 'number'
  | 'boolean'
  | 'select'
  | 'textarea';

/**
 * One data-driven configuration field. The frontend renders an input from its
 * `type`; the backend validates a submitted value against it. `secret:true`
 * fields are stored in `credentials` (masked in responses), never in `config`.
 */
export interface ConfigFieldDto {
  key: string;
  label: string;
  type: ConfigFieldType;
  /** Allowed values for `select` fields. */
  options?: string[];
  /** When true the value is a secret (password input; stored masked). */
  secret?: boolean;
  required?: boolean;
  placeholder?: string;
  help?: string;
}

/** JSON-schema-ish parameter contract for a single tool. */
export interface ToolParametersDto {
  type: 'object';
  properties: Record<
    string,
    { type: string; description?: string; enum?: string[] }
  >;
  required: string[];
}

/** A single action a skill exposes (maps to LLM tool/function calling). */
export interface ToolDefinitionDto {
  name: string;
  description: string;
  parameters: ToolParametersDto;
  /**
   * When true the tool is inherently HIGH-RISK: the runtime pauses it for human
   * approval (via the Approval Center) instead of executing it directly. Absent/
   * false tools execute as normal (unless an employee's approvalRules require it).
   */
  highRisk?: boolean;
  /**
   * True when this tool has NO real executor implementation — calling it can
   * only ever produce a sandbox result. Populated from `RealExecutionSupport`
   * so the UI can say so before a user relies on it, and so the executor can
   * fail closed rather than fabricate a success in a real-execution
   * deployment.
   */
  simulated?: boolean;
  /**
   * Which installed skill owns this tool, when the caller populated it (e.g.
   * SkillsService.getToolsForEmployee tags every tool with its skill). Tool
   * NAMES are only unique within one skill — two different skills can both
   * expose e.g. `send_email` (the generic `email` skill and `gmail` both do).
   * An LLM provider should resolve a returned tool_call's skill from THIS
   * field (the exact tool list it was given) rather than a global, ambiguous
   * name→skill catalog search that would always resolve to whichever skill
   * happens to be first in the catalog, regardless of which one is actually
   * installed/intended.
   */
  skillKey?: string;
}

/** A built-in skill in the (code-defined) catalog. */
export interface SkillDefinitionDto {
  key: string;
  name: string;
  description: string;
  category: SkillCategory;
  tools: ToolDefinitionDto[];
  /** How the skill connects to its (real) backend. */
  connection: SkillConnectionDto;
  /** Company-specific configuration fields (data-driven form). */
  configSchema: ConfigFieldDto[];
  /**
   * Whether this skill can actually reach its real backend.
   *
   * `REAL`      — every tool has a real executor implementation.
   * `PARTIAL`   — some tools are real, others are simulated.
   * `SIMULATED` — NO tool has a real executor. The skill can still be installed
   *               and (for oauth skills) genuinely connected, but every call is
   *               answered by the offline sandbox executor.
   *
   * Exists because hubspot/jira/github/stripe had real OAuth and no real
   * executor, so a customer could connect a live account, see CONNECTED, and
   * watch every write "succeed" without anything leaving the building.
   * Computed from `RealExecutionSupport`, not hand-maintained.
   */
  executionSupport: SkillExecutionSupport;
}

export type SkillExecutionSupport = 'REAL' | 'PARTIAL' | 'SIMULATED';

/** A skill a company has installed (turns a catalog entry on for the tenant). */
export interface InstalledSkillDto {
  id: string;
  companyId: string;
  skillKey: string;
  /** null = company-wide; set = owned by, and only by, that one AiEmployee. */
  employeeId: string | null;
  displayName: string;
  /** Non-secret company-specific settings. */
  config: Record<string, unknown> | null;
  enabled: boolean;
  /** Connection type (mirrors the catalog); null until first set. */
  connectionType: SkillConnectionType | null;
  /** Whether credentials have been supplied / the skill is connected. */
  connectionStatus: SkillConnectionStatus;
  /**
   * True when secret credentials are stored. Raw credentials are NEVER returned
   * — this is the masked indicator the UI uses.
   */
  credentialsSet: boolean;
  createdAt: string;
}

/**
 * Connector health snapshot (Unit B, docs §1.6–1.8). Returned by
 * `GET /connectors/:id/health` and `POST /connectors/:id/health-check` (run a
 * probe now). `status` mirrors the connector's connectionStatus; the other
 * fields expose the passive/active health signals driving the state machine.
 */
export interface ConnectorHealthDto {
  connectorId: string;
  status: SkillConnectionStatus;
  /** Last active-probe timestamp (ISO); null until first probed. */
  lastHealthCheckAt: string | null;
  /** Rolling consecutive egress/probe failure count (reset on success). */
  consecutiveErrors: number;
  /** Last recorded health/egress error message; null when healthy. */
  lastHealthError: string | null;
  /** Cached OAuth access-token expiry (ISO); null for api-key/no-expiry. */
  tokenExpiresAt: string | null;
  /** Why the connector was auto-DISCONNECTED (revoked/invalid_grant); null otherwise. */
  disabledReason: string | null;
}

// --- Skill capabilities & workflow skill-dependencies ----------------------
// Capability-first resolution for the in-chat "connect a skill" experience
// (doc 30 §12). A workflow declares WHAT it needs (a capability, e.g. send
// email) not WHICH provider — so Gmail and (future) Outlook can both satisfy
// EMAIL_SEND without changing any planning logic. The concrete (skillKey→tool)
// mapping + provider registry live server-side (apps/api skills/capabilities.ts);
// only the vocabulary + the machine-readable dependency shape are shared here.

/**
 * Provider-agnostic capability a workflow step can require. Each maps to one or
 * more (skillKey, tool) pairs in the server catalog; more than one skill may
 * satisfy the same capability (multi-provider support).
 */
export type SkillCapability =
  | 'EMAIL_SEND'
  | 'EMAIL_READ'
  | 'CALENDAR_EVENT_CREATE'
  | 'MESSAGING_SEND'
  | 'CRM_WRITE'
  | 'ISSUE_TRACKING_WRITE'
  | 'ISSUE_TRACKING_READ'
  | 'FILE_STORAGE_WRITE'
  | 'FILE_STORAGE_READ'
  | 'PAYMENTS_WRITE'
  | 'PAYMENTS_READ'
  | 'SOCIAL_PUBLISH'
  | 'SUPPORT_REPLY'
  | 'HTTP_REQUEST';

export const SKILL_CAPABILITIES: readonly SkillCapability[] = [
  'EMAIL_SEND',
  'EMAIL_READ',
  'CALENDAR_EVENT_CREATE',
  'MESSAGING_SEND',
  'CRM_WRITE',
  'ISSUE_TRACKING_WRITE',
  'ISSUE_TRACKING_READ',
  'FILE_STORAGE_WRITE',
  'FILE_STORAGE_READ',
  'PAYMENTS_WRITE',
  'PAYMENTS_READ',
  'SOCIAL_PUBLISH',
  'SUPPORT_REPLY',
  'HTTP_REQUEST',
] as const;

/** Human labels for a capability (used by the in-chat Skill card). */
export interface SkillCapabilityMeta {
  id: SkillCapability;
  label: string;
  description: string;
}

export const SKILL_CAPABILITY_META: Record<SkillCapability, SkillCapabilityMeta> = {
  EMAIL_SEND: { id: 'EMAIL_SEND', label: 'Send email', description: 'Send emails on the employee’s behalf.' },
  EMAIL_READ: { id: 'EMAIL_READ', label: 'Read email', description: 'Read recent inbox messages.' },
  CALENDAR_EVENT_CREATE: { id: 'CALENDAR_EVENT_CREATE', label: 'Create calendar events', description: 'Check availability and create meetings.' },
  MESSAGING_SEND: { id: 'MESSAGING_SEND', label: 'Send chat messages', description: 'Post messages to a team chat channel.' },
  CRM_WRITE: { id: 'CRM_WRITE', label: 'Update CRM', description: 'Create or update contacts and deals.' },
  ISSUE_TRACKING_WRITE: { id: 'ISSUE_TRACKING_WRITE', label: 'Manage issues', description: 'Create and update tracked issues.' },
  ISSUE_TRACKING_READ: { id: 'ISSUE_TRACKING_READ', label: 'Read issues', description: 'Read and list tracked issues.' },
  FILE_STORAGE_WRITE: { id: 'FILE_STORAGE_WRITE', label: 'Manage files', description: 'Upload and organise files.' },
  FILE_STORAGE_READ: { id: 'FILE_STORAGE_READ', label: 'Read files', description: 'List and read stored files.' },
  PAYMENTS_WRITE: { id: 'PAYMENTS_WRITE', label: 'Create payments', description: 'Create payment links.' },
  PAYMENTS_READ: { id: 'PAYMENTS_READ', label: 'Read payments', description: 'Review charges and balance.' },
  SOCIAL_PUBLISH: { id: 'SOCIAL_PUBLISH', label: 'Publish social posts', description: 'Schedule or publish social content.' },
  SUPPORT_REPLY: { id: 'SUPPORT_REPLY', label: 'Reply to support', description: 'Respond to customer conversations.' },
  HTTP_REQUEST: { id: 'HTTP_REQUEST', label: 'Call an API', description: 'Make an outbound HTTP request.' },
};

/**
 * Operational state of a required skill inside AI Assist / the Workflow Builder.
 * A SUPERSET of {@link SkillConnectionStatus}: a computed projection that never
 * treats "credentials exist" as "operational".
 *
 * Producible by today's resolver (SkillRequirementsService): READY,
 * NOT_CONNECTED, DEGRADED, DISCONNECTED, ERROR. The remaining values —
 * AUTHORIZING, CONFIGURATION_REQUIRED, VALIDATING, EXPIRED, REVOKED,
 * INSUFFICIENT_PERMISSION — are part of the contract but only emitted once the
 * OAuth-resume + post-connect scope/health-validation slices land (they need a
 * live provider probe that doesn't exist yet). The UI must handle all of them.
 */
export type SkillRequirementStatus =
  | 'READY'
  | 'NOT_CONNECTED'
  | 'AUTHORIZING'
  | 'CONFIGURATION_REQUIRED'
  | 'VALIDATING'
  | 'DEGRADED'
  | 'DISCONNECTED'
  | 'EXPIRED'
  | 'REVOKED'
  | 'INSUFFICIENT_PERMISSION'
  | 'ERROR';

export const SKILL_REQUIREMENT_STATUSES: readonly SkillRequirementStatus[] = [
  'READY',
  'NOT_CONNECTED',
  'AUTHORIZING',
  'CONFIGURATION_REQUIRED',
  'VALIDATING',
  'DEGRADED',
  'DISCONNECTED',
  'EXPIRED',
  'REVOKED',
  'INSUFFICIENT_PERMISSION',
  'ERROR',
] as const;

/**
 * One machine-readable skill dependency of a workflow — derived by scanning the
 * graph's TOOL_ACTION nodes, never re-inferred from conversational text. Backs
 * the in-chat Skill card and the publish-time readiness gate.
 */
export interface WorkflowSkillRequirementDto {
  /** The concrete skill the graph references (e.g. `gmail`). */
  skillKey: string;
  /** Display name from the catalog (e.g. "Gmail"). */
  displayName: string;
  /** OAuth provider group (e.g. `google`, `slack`); null for api-key/none skills. */
  provider: string | null;
  /** Capabilities this dependency provides in the workflow. */
  capabilities: SkillCapability[];
  /** Other installed-catalog skills that could satisfy the same capabilities. */
  compatibleSkillKeys: string[];
  /**
   * Whether the skill needs an authenticated connection (oauth/api_key). A
   * `none`-connection skill (http/scheduling/…) is operational once installed
   * and never blocks publish.
   */
  requiresConnection: boolean;
  /** Every graph-derived dependency is required; the assist layer may mark optional extras. */
  required: boolean;
  status: SkillRequirementStatus;
  /** Raw connector status, or null when the skill isn't installed for the tenant. */
  connectionStatus: SkillConnectionStatus | null;
  connectionType: SkillConnectionType | null;
  installedSkillId: string | null;
  credentialsSet: boolean;
  /** Graph node ids that depend on this skill. */
  nodeIds: string[];
  /**
   * Whether the current member may connect it (OWNER/ADMIN). When false the UI
   * shows "Admin permission needed" instead of a Connect control.
   */
  canManageConnection: boolean;
}

/** All skill dependencies of a workflow + a readiness roll-up. */
export interface WorkflowSkillRequirementsDto {
  requirements: WorkflowSkillRequirementDto[];
  /** Required connectable skills that are not READY. */
  missingRequiredCount: number;
  /** True when every required skill is READY — i.e. the workflow may be published. */
  allRequiredReady: boolean;
}

/** An assignment of an installed skill to a specific AI employee. */
export interface EmployeeSkillDto {
  id: string;
  companyId: string;
  employeeId: string;
  installedSkillId: string;
  createdAt: string;
}

/** Outcome of a single tool call, surfaced in a run + message metadata. */
export interface ToolCallDto {
  skillKey: string;
  tool: string;
  args: Record<string, unknown>;
  result: unknown;
  ok: boolean;
  /**
   * True when the call was NOT executed because it is high-risk and was routed to
   * the Approval Center; `approvalId` is the created PENDING ApprovalRequest.
   */
  pendingApproval?: boolean;
  approvalId?: string;
  /**
   * Why the call failed, when `ok` is false.
   *
   * The `SkillExecution` row always recorded this; the DTO dropped it, so every
   * caller saw only "it failed". That erased the cause at the boundary: a
   * workflow step could report nothing better than `Tool x/y did not succeed`,
   * and `RetryPolicyService` — which classifies by reading the message — filed a
   * provider TIMEOUT as a generic NODE_ERROR, which then drove the wrong backoff
   * and the wrong metric.
   *
   * Already secret-masked by `SkillsService` before it reaches here.
   */
  error?: string;
}

/** Terminal status of a logged skill execution. */
export type SkillExecutionStatus = 'SUCCESS' | 'ERROR';

/** An audited tool execution row. */
export interface SkillExecutionDto {
  id: string;
  companyId: string;
  employeeId: string | null;
  conversationId: string | null;
  skillKey: string;
  tool: string;
  args: Record<string, unknown>;
  result: unknown;
  status: SkillExecutionStatus;
  error: string | null;
  createdAt: string;
}

// --- Zod schemas (shared with the web forms) -------------------------------

/** POST /skills/install body. */
export const installSkillSchema = z.object({
  skillKey: z.string().min(1, 'Skill key is required').max(80),
  /** Owning employee for a per-employee connection; omit for company-wide. */
  employeeId: z.string().min(1).optional(),
  displayName: z.string().min(1).max(120).optional(),
  config: z.record(z.unknown()).optional(),
});

/** PATCH /skills/installed/:id body (enable/disable/config/displayName). */
export const updateInstalledSkillSchema = z.object({
  enabled: z.boolean().optional(),
  displayName: z.string().min(1).max(120).optional(),
  config: z.record(z.unknown()).optional(),
});

/** POST /employees/:id/skills body (assign an installed skill). */
export const assignSkillSchema = z.object({
  installedSkillId: z.string().min(1, 'Installed skill id is required'),
});

/** POST /skills/installed/:id/tools/:tool/execute body (manual execution). */
export const executeToolSchema = z.object({
  args: z.record(z.unknown()),
});

/** PATCH /skills/installed/:id/config body (company-specific settings). */
export const configureSkillSchema = z.object({
  config: z.record(z.unknown()),
});

/** POST /skills/installed/:id/connect body (secret credentials / OAuth token). */
export const connectSkillSchema = z.object({
  credentials: z.record(z.unknown()),
});

export type InstallSkillDto = z.infer<typeof installSkillSchema>;
export type UpdateInstalledSkillDto = z.infer<typeof updateInstalledSkillSchema>;
export type AssignSkillDto = z.infer<typeof assignSkillSchema>;
export type ExecuteToolDto = z.infer<typeof executeToolSchema>;
export type ConfigureSkillDto = z.infer<typeof configureSkillSchema>;
export type ConnectSkillDto = z.infer<typeof connectSkillSchema>;

/**
 * GET /skills/installed/:id/oauth/authorize response. `url` is the provider
 * authorization-code URL (with a signed, stateless `state`) that the browser is
 * redirected to; the provider then calls back to the public /skills/oauth/callback.
 */
export interface OAuthAuthorizeDto {
  url: string;
}

// ---------------------------------------------------------------------------
// Workflow builder module contracts.
// ---------------------------------------------------------------------------
// A no-code engine that chains a TRIGGER through AI/retrieve/tool/wait/branch/
// notify nodes. A Workflow holds a graph `definition` ({nodes, edges}); running
// it spawns a WorkflowRun (async, BullMQ) whose engine walks the graph writing a
// WorkflowStepRun per visited node. Nodes reuse the Knowledge (RETRIEVE), LLM
// (AI_STEP) and Skills (TOOL_ACTION) modules. No vector columns here.

/**
 * Lifecycle of a workflow definition. Only ACTIVE workflows are "live".
 * ARCHIVED is the soft-deleted terminal state (gap G29) — the workflow and its
 * entire run history are retained and remain readable, but it can no longer be
 * run, activated or edited.
 */
export type WorkflowStatus = 'DRAFT' | 'ACTIVE' | 'PAUSED' | 'ARCHIVED';

export const WORKFLOW_STATUSES: readonly WorkflowStatus[] = [
  'DRAFT',
  'ACTIVE',
  'PAUSED',
  'ARCHIVED',
] as const;

/**
 * P1 — lifecycle of one immutable version of a workflow graph (doc 00 §0.7.1,
 * ADR-002). Only a DRAFT version's graph may be edited; PUBLISHED and beyond
 * are frozen so an in-flight run can never have its definition changed
 * underneath it (gap G1).
 */
export type WorkflowVersionStatus =
  | 'DRAFT'
  | 'PUBLISHED'
  | 'DEPRECATED'
  | 'ARCHIVED';

export const WORKFLOW_VERSION_STATUSES: readonly WorkflowVersionStatus[] = [
  'DRAFT',
  'PUBLISHED',
  'DEPRECATED',
  'ARCHIVED',
] as const;

/** P1 — coarse grouping for the workflow library/marketplace (doc 00 §0.7.1). */
export type WorkflowCategory =
  | 'HR'
  | 'RECRUITMENT'
  | 'MARKETING'
  | 'SALES'
  | 'SUPPORT'
  | 'FINANCE'
  | 'OPERATIONS'
  | 'IT'
  | 'COMPLIANCE'
  | 'CUSTOM';

export const WORKFLOW_CATEGORIES: readonly WorkflowCategory[] = [
  'HR',
  'RECRUITMENT',
  'MARKETING',
  'SALES',
  'SUPPORT',
  'FINANCE',
  'OPERATIONS',
  'IT',
  'COMPLIANCE',
  'CUSTOM',
] as const;

/** P1 — one frozen version of a workflow graph. */
export interface WorkflowVersionDto {
  id: string;
  companyId: string;
  workflowId: string;
  version: number;
  status: WorkflowVersionStatus;
  definition: WorkflowDefinition;
  publishedAt: string | null;
  publishedById: string | null;
  changeNote: string | null;
  createdAt: string;
}

/** Result of `POST /workflows/:id/publish`. */
export interface PublishWorkflowResultDto {
  version: WorkflowVersionDto;
  /**
   * True when the draft was byte-identical to the current PUBLISHED version, so
   * no new version was created. Publishing is idempotent — clicking twice must
   * not produce v2 and v3 with the same graph.
   */
  unchanged: boolean;
  /**
   * True when the same request also activated the workflow (`activate: true`).
   * The UX plan collapses Publish and Activate into one customer-facing action,
   * but the two remain separate server-side operations with separate audit
   * entries — this only reports whether the second one ran.
   */
  activated: boolean;
  /** The workflow AFTER activation; null when `activate` was not requested. */
  workflow: WorkflowDto | null;
  /**
   * Why activation was refused, when `activate` was requested but did not
   * happen. Null otherwise.
   *
   * Publish and activate enforce DIFFERENT rules — publish checks the graph is
   * valid and its skills connected, activate additionally requires a runnable
   * step and a complete trigger. So the second half can legitimately fail after
   * the first half committed. Reporting that as a bare HTTP error would tell the
   * caller "it failed" while a new immutable version had in fact been published:
   * the client would show the wrong state and the user would republish. This
   * field exists so the response can say exactly what happened instead.
   */
  activationError: string | null;
}

// ---------------------------------------------------------------------------
// Publish readiness preflight (UX plan §12/§13) — a NON-MUTATING dry run of the
// checks publish + activate would perform, so the Review & Publish surface can
// show what is wrong BEFORE the user commits, instead of making them press a
// separate [Validate] button and read a thrown error.
// ---------------------------------------------------------------------------

/** How badly a readiness issue blocks. Only BLOCKER prevents publishing. */
export type WorkflowReadinessSeverity = 'BLOCKER' | 'WARNING';

/** What the UI should offer to fix an issue with, when there is a direct action. */
export interface WorkflowReadinessFix {
  kind: 'CONNECT_SKILL' | 'OPEN_NODE' | 'OPEN_TRIGGER';
  /** Skill key for CONNECT_SKILL, node id for OPEN_NODE; absent for OPEN_TRIGGER. */
  target?: string;
}

export interface WorkflowReadinessIssueDto {
  /** Stable machine code (e.g. SKILL_NOT_CONNECTED); the UI keys behaviour off this. */
  code: string;
  severity: WorkflowReadinessSeverity;
  /** Plain-language, actionable. Shown verbatim to a non-technical operator. */
  message: string;
  nodeId: string | null;
  fix: WorkflowReadinessFix | null;
}

/** One line of the review checklist (UX plan §13). */
export interface WorkflowReadinessCheckDto {
  key:
    | 'STRUCTURE'
    | 'TRIGGER'
    | 'NODE_CONFIG'
    | 'AI_EMPLOYEE'
    | 'SKILLS'
    | 'APPROVAL'
    | 'SCHEDULE';
  label: string;
  status: 'PASS' | 'FAIL' | 'WARN';
}

/** The human-readable summary of what is about to be published. */
export interface WorkflowReadinessSummaryDto {
  name: string;
  /** e.g. "Every Monday · 09:00" or "Manual — you start it". */
  triggerSummary: string;
  /** Employee ids referenced by AI_EMPLOYEE_STEP / TOOL_ACTION nodes. */
  employeeIds: string[];
  skillKeys: string[];
  /** Number of APPROVAL nodes; 0 when the workflow needs no sign-off. */
  approvalCount: number;
  /** Steps excluding the trigger. */
  stepCount: number;
  /** True when any node can perform a real external action (UX plan §57). */
  hasExternalActions: boolean;
}

/** Result of `GET /workflows/:id/readiness`. */
export interface WorkflowReadinessDto {
  workflowId: string;
  /** False when any issue is a BLOCKER. */
  ready: boolean;
  checks: WorkflowReadinessCheckDto[];
  issues: WorkflowReadinessIssueDto[];
  summary: WorkflowReadinessSummaryDto;
}

/**
 * The subset a client may set directly via `PATCH /workflows/:id`.
 *
 * ARCHIVED is deliberately EXCLUDED: it is reachable only through
 * `DELETE /workflows/:id`, which refuses (409) while any run is still
 * PENDING/RUNNING/WAITING. Allowing PATCH to set it would bypass that guard and
 * strand in-flight runs against an archived workflow.
 */
export type SettableWorkflowStatus = Exclude<WorkflowStatus, 'ARCHIVED'>;

export const SETTABLE_WORKFLOW_STATUSES: readonly SettableWorkflowStatus[] = [
  'DRAFT',
  'ACTIVE',
  'PAUSED',
] as const;

/**
 * How an ACTIVE workflow is invoked (Steps 8/9/11). MANUAL is the default and
 * preserves the existing POST /workflows/:id/run path; the others are
 * event-driven (a repeatable BullMQ job, a public webhook, or an internal event).
 */
export type TriggerType = 'MANUAL' | 'SCHEDULE' | 'WEBHOOK' | 'EVENT';

export const TRIGGER_TYPES: readonly TriggerType[] = [
  'MANUAL',
  'SCHEDULE',
  'WEBHOOK',
  'EVENT',
] as const;

/**
 * Comparison operators for the EVENT condition DSL (docs §5.2 — "richer filters").
 * Distinct from `ConditionOp` (the narrower CONDITION-node operator set) because
 * this DSL adds gte/lte/exists/in and is evaluated against a fired event payload,
 * not a workflow run context. See `Condition` + the server `evaluateConditions`.
 */
export type EventConditionOp =
  | 'eq'
  | 'neq'
  | 'gt'
  | 'gte'
  | 'lt'
  | 'lte'
  | 'contains'
  | 'exists'
  | 'in';

export const EVENT_CONDITION_OPS: readonly EventConditionOp[] = [
  'eq',
  'neq',
  'gt',
  'gte',
  'lt',
  'lte',
  'contains',
  'exists',
  'in',
] as const;

/**
 * One predicate an EVENT-triggered workflow evaluates against a fired event
 * payload (`{ eventId, subject, data }`). `path` is a safe dotted lookup (no eval,
 * prototype-pollution guarded); a workflow fires only if ALL of its conditions
 * pass. `value` is omitted for the `exists` op (which only checks truthy presence).
 */
export interface Condition {
  path: string;
  op: EventConditionOp;
  value?: unknown;
}

/**
 * Trigger configuration persisted on a workflow. Shape depends on triggerType:
 * SCHEDULE needs `everyMs` (≥15000) OR `cron`; EVENT needs `eventType` (+ optional
 * `conditions` for richer payload filtering); WEBHOOK/MANUAL carry no config.
 */
export interface TriggerConfig {
  /** SCHEDULE: repeat interval in ms (min 15000). */
  everyMs?: number;
  /** SCHEDULE: cron expression (alternative to everyMs). */
  cron?: string;
  /** EVENT: the internal event name this workflow listens for. */
  eventType?: string;
  /**
   * EVENT: optional predicate list — the workflow fires only when every condition
   * passes against the fired payload. Empty/absent → always fire (back-compat).
   */
  conditions?: Condition[];
  /**
   * EVENT: restrict this trigger to ONE specific connector (InstalledSkill.id) —
   * e.g. one employee's own Gmail connection. Absent → matches every connector
   * of this eventType (today's exact behavior, unchanged).
   */
  connectorId?: string;
}

/**
 * Terminal/interim status of a single workflow run. WAITING is a paused state: a
 * run that reached an APPROVAL node has created a PENDING approval request and is
 * suspended until a manager approves (→ RUNNING again → COMPLETED) or rejects
 * (→ FAILED). Runs without an APPROVAL node never enter WAITING.
 */
export type WorkflowRunStatus =
  | 'PENDING'
  | 'RUNNING'
  | 'WAITING'
  | 'COMPLETED'
  | 'FAILED'
  // P1 durable state machine (doc 00 §0.7.1). CANCELLED uses the double-L
  // spelling per doc 00; note the schema already carries both spellings
  // Decision D4 settled: double-L `CANCELLED` is canonical everywhere.
  | 'CANCELLED'
  | 'COMPENSATING'
  | 'TIMED_OUT';

export const WORKFLOW_RUN_STATUSES: readonly WorkflowRunStatus[] = [
  'PENDING',
  'RUNNING',
  'WAITING',
  'COMPLETED',
  'FAILED',
  'CANCELLED',
  'COMPENSATING',
  'TIMED_OUT',
] as const;

/** Status of a single step (one visited node) within a run. */
export type StepRunStatus =
  | 'PENDING'
  | 'RUNNING'
  | 'COMPLETED'
  | 'FAILED'
  | 'SKIPPED'
  // P1: failed with attempts remaining; durable wait / awaiting approval;
  // side effect rolled back by a saga compensation.
  | 'RETRYING'
  | 'WAITING'
  | 'COMPENSATED';

export const STEP_RUN_STATUSES: readonly StepRunStatus[] = [
  'PENDING',
  'RUNNING',
  'COMPLETED',
  'FAILED',
  'SKIPPED',
  'RETRYING',
  'WAITING',
  'COMPENSATED',
] as const;

/** The kind of a workflow node. `config` shape depends on this. */
export type NodeType =
  // EXISTING 8 — semantics unchanged (ADR-004).
  | 'TRIGGER'
  | 'RETRIEVE'
  | 'AI_STEP'
  | 'TOOL_ACTION'
  | 'WAIT'
  | 'CONDITION'
  | 'NOTIFY'
  | 'APPROVAL'
  // P2 — added per doc 00 §0.7.1 and the frozen MVP contract (doc 26 §3).
  | 'AI_EMPLOYEE_STEP'
  | 'SWITCH'
  | 'PARALLEL'
  | 'JOIN'
  | 'LOOP'
  | 'TERMINATE'
  | 'SET_VARIABLE'
  | 'TRANSFORM'
  | 'MEMORY_READ'
  | 'MEMORY_WRITE'
  | 'NOOP';

export const NODE_TYPES: readonly NodeType[] = [
  'TRIGGER',
  'RETRIEVE',
  'AI_STEP',
  'TOOL_ACTION',
  'WAIT',
  'CONDITION',
  'NOTIFY',
  'APPROVAL',
  'AI_EMPLOYEE_STEP',
  'SWITCH',
  'PARALLEL',
  'JOIN',
  'LOOP',
  'TERMINATE',
  'SET_VARIABLE',
  'TRANSFORM',
  'MEMORY_READ',
  'MEMORY_WRITE',
  'NOOP',
] as const;

/**
 * P2 — variable scope (doc 00 §0.7.1).
 *
 * SECRET is never writable from a workflow and ENVIRONMENT is read-only at
 * runtime: a graph that could write a secret would persist it into the
 * immutable version JSON, which is surfaced in run history and DLQ dumps.
 */
export type VariableScope =
  | 'INPUT'
  | 'RUNTIME'
  | 'WORKFLOW'
  | 'GLOBAL'
  | 'ENVIRONMENT'
  | 'SECRET'
  | 'OUTPUT';

export const VARIABLE_SCOPES: readonly VariableScope[] = [
  'INPUT',
  'RUNTIME',
  'WORKFLOW',
  'GLOBAL',
  'ENVIRONMENT',
  'SECRET',
  'OUTPUT',
] as const;

/** Scopes a workflow graph may WRITE. */
export const WRITABLE_VARIABLE_SCOPES: readonly VariableScope[] = [
  'RUNTIME',
  'WORKFLOW',
  'OUTPUT',
] as const;

/** P2 — declared variable value type, for validation + UI form generation. */
export type VariableType =
  | 'string'
  | 'number'
  | 'boolean'
  | 'json'
  | 'date'
  | 'array'
  | 'secret';

export const VARIABLE_TYPES: readonly VariableType[] = [
  'string',
  'number',
  'boolean',
  'json',
  'date',
  'array',
  'secret',
] as const;

/**
 * P2 — the CLOSED set of TRANSFORM operations.
 *
 * Closed on purpose. An arbitrary-expression node would be remote code
 * execution inside a multi-tenant runtime; if authors need more, extend this
 * set rather than adding an evaluator.
 */
export type TransformOp =
  | 'jsonPath'
  | 'map'
  | 'filter'
  | 'join'
  | 'split'
  | 'toNumber'
  | 'toString'
  | 'default';

export const TRANSFORM_OPS: readonly TransformOp[] = [
  'jsonPath',
  'map',
  'filter',
  'join',
  'split',
  'toNumber',
  'toString',
  'default',
] as const;

/** Comparison operators available to a CONDITION node. */
export type ConditionOp = 'eq' | 'neq' | 'contains' | 'gt' | 'lt';

export const CONDITION_OPS: readonly ConditionOp[] = [
  'eq',
  'neq',
  'contains',
  'gt',
  'lt',
] as const;

/** One node in a workflow graph. Templates use `{{a.b.c}}` context lookups. */
export interface WorkflowNode {
  id: string;
  type: NodeType;
  name?: string;
  config: Record<string, unknown>;
  /**
   * World-space canvas position (Workflow Builder). Optional + additive: nodes
   * authored before the builder — or by the API/templates — carry none, and the
   * canvas dagre-lays-out any node without one. Persisted through Save so a
   * manual arrangement survives a reload.
   */
  position?: { x: number; y: number };
  /**
   * Author-disabled step (Workflow Builder "Deactivate"). Optional + additive:
   * absent means enabled, so every existing definition is unaffected. The engine
   * SKIPS a disabled node — it records a SKIPPED step row and continues down the
   * node's FIRST outgoing edge — so this is a real execution change, not just a
   * visual one. A TRIGGER may not be disabled (rejected at validation): the graph
   * would have no root.
   */
  disabled?: boolean;
}

/** A directed edge. `branch` selects a CONDITION outcome ('true'/'false'). */
/**
 * The two branch labels a CONDITION node can emit.
 *
 * Exported so code that only ever deals with CONDITION keeps exhaustiveness
 * checking, which was lost when `WorkflowEdge.branch` widened to `string` for
 * SWITCH's author-named cases:
 *
 *   const label: ConditionBranch = result ? 'true' : 'false';
 *   switch (label) { case 'true': …; case 'false': … }  // still exhaustive
 */
export type ConditionBranch = 'true' | 'false';

export const CONDITION_BRANCHES: readonly ConditionBranch[] = [
  'true',
  'false',
] as const;

/** Narrow an arbitrary edge label to a CONDITION branch, or undefined. */
export function asConditionBranch(
  branch: string | undefined,
): ConditionBranch | undefined {
  return branch === 'true' || branch === 'false' ? branch : undefined;
}

export interface WorkflowEdge {
  from: string;
  to: string;
  /**
   * Edge label used for branch routing.
   *
   * Widened from `'true' | 'false'` in P2: SWITCH selects an author-named case
   * (e.g. `'advance'`), so the label has to be a free string. CONDITION still
   * emits only `'true'`/`'false'`, so every existing graph and every consumer
   * comparing against those literals keeps working — this is a widening, not a
   * breaking change.
   */
  branch?: string;
}

/** The full graph persisted on a workflow. */
export interface WorkflowDefinition {
  nodes: WorkflowNode[];
  edges: WorkflowEdge[];
}

// --- Per-node config shapes (documentation + FE editor convenience) --------

/** TRIGGER: no configuration (seeds context.trigger with the run payload). */
export type TriggerNodeConfig = Record<string, never>;

/** RETRIEVE: knowledge search. `query` is a template; results → context[outputKey]. */
export interface RetrieveNodeConfig {
  query: string;
  k?: number;
  outputKey: string;
}

/** AI_STEP: LLM completion of a templated prompt; text → context[outputKey]. */
export interface AiStepNodeConfig {
  prompt: string;
  employeeId?: string;
  outputKey: string;
}

/** TOOL_ACTION: run a skill tool; each arg value is a template. Result → context[outputKey]. */
export interface ToolActionNodeConfig {
  skillKey: string;
  tool: string;
  args: Record<string, string>;
  outputKey: string;
  /** Run as this employee's own connection (falls back to the company-wide one). */
  employeeId?: string;
}

/** WAIT: bounded delay (capped by the engine). */
export interface WaitNodeConfig {
  durationMs: number;
}

/** CONDITION: compare a templated `left` against a literal `right`. */
export interface ConditionNodeConfig {
  left: string;
  op: ConditionOp;
  right: string;
}

/** NOTIFY: record a templated message in the step output (log-style). */
export interface NotifyNodeConfig {
  message: string;
}

/**
 * APPROVAL: pause the run and open a WORKFLOW-kind approval request in the
 * Approval Center. The run suspends (WAITING) until a manager approves (resume)
 * or rejects (fail). `message` is shown to the approver (defaulted if absent).
 *
 * `autoApprove: true` skips the human gate entirely — the step still runs and
 * appears in the run log (for audit), but resolves immediately with no PENDING
 * ApprovalRequest and no pause. Lets a company that trusts its upstream
 * CONDITION ("criteria matched") go straight to the downstream action, while a
 * company that wants a manager in the loop leaves this off (the default).
 */
// --- P3-05 §8.1 approval routing -------------------------------------------

/** How an approval level resolves WHO must decide (doc 08 §8.1.5). */
export type ApproverRuleType =
  | 'USER'
  | 'ROLE'
  | 'DEPARTMENT'
  | 'TEAM'
  | 'EMPLOYEE_MANAGER'
  | 'ANY_ADMIN';

export const APPROVER_RULE_TYPES: readonly ApproverRuleType[] = [
  'USER',
  'ROLE',
  'DEPARTMENT',
  'TEAM',
  'EMPLOYEE_MANAGER',
  'ANY_ADMIN',
] as const;

/** What happens once a level's escalation chain is exhausted with no decision. */
export type ApprovalOnTimeout = 'ESCALATE' | 'AUTO_APPROVE' | 'AUTO_REJECT' | 'NONE';

/** One fallback hop within a level's escalation chain (doc 08 §8.1.7). */
export interface ApprovalEscalationStep {
  rule: ApproverRuleType;
  /**
   * userId | Role value | Department.id | Team.id. Omitted for EMPLOYEE_MANAGER/ANY_ADMIN.
   * For a WORKFLOW-kind APPROVAL node only, may be a `{{a.b.c}}` template resolved against
   * the run context at pause time.
   */
  target?: string;
  /** Minutes at this step before moving to the next escalation hop (or the level's onTimeout). */
  slaMinutes?: number;
}

/** One business-required sequential sign-off step. */
export interface ApprovalRoutingLevel extends ApprovalEscalationStep {
  /** Ordered fallback chain if the level's own assignee doesn't decide within slaMinutes. */
  escalationChain?: ApprovalEscalationStep[];
  /** What happens once the chain (if any) is exhausted. Default 'NONE'. */
  onTimeout?: ApprovalOnTimeout;
}

/** The full routing declaration on an APPROVAL node or an employee's approvalRules. */
export interface ApprovalRoutingConfig {
  /** Sequential; empty/absent = legacy unrouted behaviour (today's exact "any admin" rule). */
  levels: ApprovalRoutingLevel[];
  /** Caps runaway escalation chains. Default 3. */
  maxEscalations?: number;
  /** Chain-wide fallback when a level doesn't specify its own onTimeout. Default 'NONE'. */
  defaultOnTimeout?: ApprovalOnTimeout;
}

/** Result of resolving one routing step to a concrete decider (ApprovalRoutingService). */
export interface ResolvedAssignee {
  assigneeUserId?: string;
  approverRuleType: ApproverRuleType;
  approverRuleValue?: string;
}

/** Internal shape of `ApprovalRequest.routingSnapshot` (never serialised to a DTO). */
export interface RoutingSnapshot {
  levels: ApprovalRoutingLevel[];
  maxEscalations: number;
  defaultOnTimeout: ApprovalOnTimeout;
}

export interface ApprovalNodeConfig {
  message?: string;
  autoApprove?: boolean;
  /** P3-05 §8.1 — who must decide, multi-level sign-off, SLA/escalation. */
  routing?: ApprovalRoutingConfig;
}

// --- Zod schemas (shared with the web forms) -------------------------------
// workflowDefinitionSchema / conditionSchema / triggerConfigSchema are defined
// in ./shared-schemas (imported + re-exported above) and used below.

/** POST /workflows body. */
export const createWorkflowSchema = z.object({
  name: z.string().min(1, 'Name is required').max(160),
  description: z.string().max(2000).optional(),
  definition: workflowDefinitionSchema.optional(),
  /**
   * WAVE 2 §2.1 — the department axis. Until now `category` could only be set by
   * a template install, which meant department isolation had nothing to isolate
   * on for hand-authored workflows.
   */
  category: z.enum(WORKFLOW_CATEGORIES as unknown as [string, ...string[]]).optional(),
});

/**
 * PATCH /workflows/:id body (name/description/definition/status/trigger).
 * `expectedUpdatedAt` is an OPTIONAL optimistic-concurrency guard: pass the
 * `updatedAt` you last read (from GET) and the server 409s if someone else
 * saved in between, instead of silently overwriting their change (two people/
 * tabs editing the same workflow otherwise had no conflict signal at all).
 */
export const updateWorkflowSchema = z.object({
  name: z.string().min(1).max(160).optional(),
  description: z.string().max(2000).optional(),
  definition: workflowDefinitionSchema.optional(),
  status: z.enum(['DRAFT', 'ACTIVE', 'PAUSED']).optional(),
  triggerType: z.enum(['MANUAL', 'SCHEDULE', 'WEBHOOK', 'EVENT']).optional(),
  triggerConfig: triggerConfigSchema.optional(),
  expectedUpdatedAt: z.string().optional(),
  /** WAVE 2 §2.1 — recategorise; `null` makes the workflow company-wide again. */
  category: z
    .enum(WORKFLOW_CATEGORIES as unknown as [string, ...string[]])
    .nullable()
    .optional(),
});

/** POST /workflows/:id/run body (optional trigger payload). */
export const runWorkflowSchema = z.object({
  trigger: z.record(z.unknown()).optional(),
  /** Test mode: TOOL_ACTION steps produce a preview instead of really
   * calling the skill (no real email/event/etc, no SkillExecution row). */
  dryRun: z.boolean().optional(),
});

/** POST /workflows/events body — fire an internal event to EVENT-triggered flows. */
export const fireEventSchema = z.object({
  eventType: z.string().min(1).max(120),
  payload: z.record(z.unknown()).optional(),
  /** Restrict which connector-scoped triggers this fire can match (see TriggerConfig.connectorId). */
  connectorId: z.string().optional(),
});

export type CreateWorkflowDto = z.infer<typeof createWorkflowSchema>;
export type UpdateWorkflowDto = z.infer<typeof updateWorkflowSchema>;
export type RunWorkflowDto = z.infer<typeof runWorkflowSchema>;
export type FireEventDto = z.infer<typeof fireEventSchema>;

// --- DTOs / API contract types ---------------------------------------------

/** Public shape of a workflow. */
export interface WorkflowDto {
  id: string;
  companyId: string;
  name: string;
  description: string | null;
  status: WorkflowStatus;
  definition: WorkflowDefinition;
  triggerType: TriggerType;
  triggerConfig: TriggerConfig | null;
  /** Present (for WEBHOOK triggers) once the workflow has been activated. */
  webhookToken: string | null;
  activatedAt: string | null;
  createdAt: string;
  updatedAt: string;
  /** The creator (P3-06); may manage the workflow's permissions. Null on legacy rows. */
  ownerUserId: string | null;
  /** The currently-published version id (null until first publish). */
  activeVersionId: string | null;
  /** The in-progress draft version id (null when no unsaved draft version exists). */
  draftVersionId: string | null;
  /** Library/marketplace grouping (HR, MARKETING, …); null if uncategorised. */
  category: WorkflowCategory | null;
  /**
   * Non-blocking structural warnings computed from `definition` (e.g. a step
   * with no incoming edge — dead code, unreachable from the TRIGGER). Never
   * prevents a save; purely informational for the builder UI.
   */
  warnings: string[];
}

/** One turn in the AI-workflow-generation chat (never persisted). */
export interface GenerateWorkflowMessageDto {
  role: 'user' | 'assistant';
  content: string;
}

/** POST /workflows/generate body — the whole chat so far, sent each turn. */
export interface GenerateWorkflowDto {
  messages: GenerateWorkflowMessageDto[];
}

/** A node in a generated draft the AI couldn't confidently resolve. */
export interface UnresolvedWorkflowNodeDto {
  nodeId: string;
  reason: string;
}

/**
 * Response of POST /workflows/generate. `question` means the AI needs more
 * info before it can draft anything (send it back as the next `assistant`
 * message + the user's reply as the next `user` message). `draft` is a
 * ready-to-review definition — `unresolvedNodes` lists any step the AI
 * couldn't confidently fill in (see docs/specs/2026-07-13-ai-workflow-generator-design.md).
 */
export type GenerateWorkflowResultDto =
  | { type: 'question'; message: string }
  | {
      type: 'draft';
      definition: WorkflowDefinition;
      unresolvedNodes: UnresolvedWorkflowNodeDto[];
    };

/** Result of firing an internal event (POST /workflows/events). */
export interface FireEventResultDto {
  eventType: string;
  /** How many ACTIVE EVENT workflows matched and were enqueued. */
  count: number;
  runIds: string[];
}

/** One visited node's execution record within a run. */
export interface WorkflowStepRunDto {
  id: string;
  companyId: string;
  runId: string;
  nodeId: string;
  type: string;
  status: StepRunStatus;
  /** 1-based attempt number for this step (retries increment it). */
  attempt: number;
  input: unknown;
  output: unknown;
  error: string | null;
  startedAt: string | null;
  finishedAt: string | null;
  createdAt: string;
  /**
   * Credit system Phase 9, Task 9.6 — actual credits settled for this step's
   * one reservation. Null for a control-flow node (WAIT/CONDITION/etc, which
   * has no reservation) and for a step still in flight.
   */
  creditsCharged: number | null;
}

/** A single execution of a workflow. `steps` is included when polling one run. */
export interface WorkflowRunDto {
  id: string;
  companyId: string;
  workflowId: string;
  /**
   * The parent workflow's name, joined in by the cross-workflow runs list
   * (`GET /workflows/runs`) so the operations table doesn't need one request per
   * row. Absent on the per-workflow endpoints, where the name is already known.
   */
  workflowName?: string;
  status: WorkflowRunStatus;
  /** How the run was triggered: MANUAL | SCHEDULE | WEBHOOK | EVENT. */
  source: string;
  /** Test mode: TOOL_ACTION steps in this run were previewed, not really executed. */
  dryRun: boolean;
  trigger: Record<string, unknown> | null;
  context: Record<string, unknown> | null;
  /**
   * The CanonicalEvent id that triggered this run (EVENT source, join key for
   * lineage); null for manual/schedule/webhook runs.
   */
  triggerEventId: string | null;
  /**
   * Correlation id tying event→run→steps in logs/tracing (docs §9). Defaults to
   * the triggering eventId for EVENT runs; a generated id otherwise.
   */
  correlationId: string | null;
  error: string | null;
  /**
   * Coarse failure category when `status` is FAILED (e.g. NODE_ERROR,
   * AUTHORIZATION_DENIED, TIMEOUT) — a free string, since the class set is
   * code-defined. Null unless the run failed.
   */
  failureClass: string | null;
  /** The node the run will resume from when a WAITING approval is decided; else null. */
  resumeNodeId: string | null;
  /** The user who started this run (MANUAL runs); null for automated triggers. */
  startedByUserId: string | null;
  /** The pinned WorkflowVersion this run executed; null for pre-versioning runs. */
  workflowVersionId: string | null;
  startedAt: string | null;
  finishedAt: string | null;
  createdAt: string;
  /** Credit system Phase 8's own configured cap for this run; null = unlimited. */
  creditLimit: number | null;
  /** Sum of every settled step's `creditsCharged` so far this run. */
  totalCreditsCharged: number;
  steps?: WorkflowStepRunDto[];
}

/**
 * Event→run lineage (docs §9, eventId↔runId correlation): a CanonicalEvent plus
 * the WorkflowRun(s) it triggered (joined on `triggerEventId`), each carrying its
 * status and step summary. Full OTel span propagation across queue hops = TARGET.
 */
export interface EventLineageDto {
  event: CanonicalEventDto;
  runs: WorkflowRunDto[];
}

// ---------------------------------------------------------------------------
// Approval Center module contracts (Step 11).
// ---------------------------------------------------------------------------
// When an AI employee's runtime wants to run a HIGH-RISK tool (per the catalog
// tool's `highRisk` flag OR the employee's `approvalRules`), the action is NOT
// executed. Instead an ApprovalRequest (PENDING) captures the proposed tool call
// and a manager reviews it in the Approval Center: Approve (→ execute now),
// Reject (→ skip), or Modify (→ edit args then execute). Every executed approval
// still logs a SkillExecution (via the Skills module's runTool).

/** Lifecycle of an approval request. Only PENDING requests can be decided. */
export type ApprovalStatus =
  | 'PENDING'
  | 'APPROVED'
  | 'REJECTED'
  // P3-05 §8.2 — routed level escalated to the next tier / SLA-expired (both terminal for the row).
  | 'ESCALATED'
  | 'EXPIRED';

export const APPROVAL_STATUSES: readonly ApprovalStatus[] = [
  'PENDING',
  'APPROVED',
  'REJECTED',
  'ESCALATED',
  'EXPIRED',
] as const;

/**
 * What an approval request gates. TOOL (default) is a high-risk skill/tool call
 * from an AI employee — approving EXECUTES it. WORKFLOW is a paused workflow run
 * that reached an APPROVAL node — approving RESUMES the run, rejecting FAILS it
 * (no tool is executed; `skillKey`/`tool` are null, `workflowRunId` is set).
 */
export type ApprovalKind = 'TOOL' | 'WORKFLOW';

export const APPROVAL_KINDS: readonly ApprovalKind[] = [
  'TOOL',
  'WORKFLOW',
] as const;

/**
 * Per-employee approval policy (persisted on `AiEmployee.approvalRules`). A tool
 * needs approval when `requireApprovalForAllTools` is set, OR when
 * `requireApprovalForTools` includes its skill key (`"slack"`) or a fully
 * qualified `"skillKey:tool"` (`"slack:send_message"`).
 */
export interface ApprovalRules {
  requireApprovalForAllTools?: boolean;
  requireApprovalForTools?: string[];
  /**
   * Phase 1 safety fix — route every EXTERNAL-ACTION tool (one that sends to a
   * person, mutates an external system or egresses data) to a human, without
   * having to enumerate them in `requireApprovalForTools`.
   *
   * This flag was already written by the Employee Settings panel ("Require
   * approval for external messages") but no policy read it, so ticking it did
   * nothing. It maps onto the SAME `isExternalActionTool` set the chat ACT loop
   * already uses — no new vocabulary, no new gate.
   */
  approveExternalMessages?: boolean;
  /** P3-05 §8.1 — routing for TOOL-kind approvals this employee raises. */
  routing?: ApprovalRoutingConfig;
}

/**
 * The approval-rule flags the Employee Settings panel may write.
 *
 * `approveOverBudget` and `approveRefunds` were REMOVED in the Phase 1 safety
 * fix: `budgetLimit` is a hard block today (not an approval trigger) and no
 * refund tool exists in the skill catalog, so neither had semantics that could
 * be enforced without inventing product behaviour. They were checkboxes that
 * wrote JSON nothing read. See `docs/status/ORLIXA_PRODUCTION_KILL_CRITIC_AUDIT.md` §7.
 */
export const APPROVAL_RULE_FLAG_KEYS = ['approveExternalMessages'] as const;
export type ApprovalRuleFlagKey = (typeof APPROVAL_RULE_FLAG_KEYS)[number];

/**
 * Per-employee capability permissions (the Employee Settings "Permissions"
 * checkboxes).
 *
 * SEMANTICS — deliberately three-valued, and the reason matters:
 *   `undefined` (key absent) = ALLOWED. Every employee created before this
 *                              existed has no permissions object, and an
 *                              upgrade must not silently revoke live tools.
 *   `true`                   = ALLOWED (explicitly granted).
 *   `false`                  = DENIED. Enforced at `SkillsService.runTool`,
 *                              the single choke point every execution path
 *                              (chat, AI_STEP, TOOL_ACTION) goes through.
 *
 * Each key resolves to a set of `SkillCapability` values through
 * `EMPLOYEE_PERMISSION_CAPABILITIES` (api-side), so a new provider for an
 * existing capability is covered automatically.
 */
export interface EmployeePermissions {
  /** Gates EMAIL_SEND. */
  sendEmail?: boolean;
  /** Gates the "reaches a person" capabilities: EMAIL_SEND, MESSAGING_SEND, SUPPORT_REPLY. */
  contactCustomers?: boolean;
  /** Gates PAYMENTS_WRITE. */
  makePayments?: boolean;
  /** Gates knowledge retrieval, alongside the existing `knowledgeAccess` enum. */
  accessKnowledge?: boolean;
}

export const EMPLOYEE_PERMISSION_KEYS = [
  'sendEmail',
  'contactCustomers',
  'makePayments',
  'accessKnowledge',
] as const;
export type EmployeePermissionKey = (typeof EMPLOYEE_PERMISSION_KEYS)[number];

/** Public shape of an approval request. */
export interface ApprovalRequestDto {
  id: string;
  companyId: string;
  /** TOOL (high-risk tool call) or WORKFLOW (paused workflow run). */
  kind: ApprovalKind;
  employeeId: string | null;
  conversationId: string | null;
  /** Set for WORKFLOW-kind requests: the paused run this decision resumes/fails. */
  workflowRunId: string | null;
  /** Null for WORKFLOW-kind requests (no tool is gated). */
  skillKey: string | null;
  /** Null for WORKFLOW-kind requests (no tool is gated). */
  tool: string | null;
  args: Record<string, unknown>;
  result: unknown;
  description: string | null;
  status: ApprovalStatus;
  decidedById: string | null;
  decidedAt: string | null;
  note: string | null;
  createdAt: string;
  // --- P3-05 §8.1 routing + multi-level chains (routingSnapshot deliberately excluded) ---
  chainId: string;
  level: number;
  escalationTier: number;
  assigneeUserId: string | null;
  approverRuleType: ApproverRuleType | null;
  approverRuleValue: string | null;
  dueAt: string | null;
  slaMinutes: number | null;
  timeoutPolicy: string | null;
  autoDecided: boolean;
  escalatedToId: string | null;
}

// --- Zod schemas (shared with the web forms) -------------------------------

/** POST /approvals/:id/approve|reject body (optional reviewer note). */
export const decideApprovalSchema = z.object({
  note: z.string().max(2000).optional(),
});

/** POST /approvals/:id/modify body (edited args + optional note). */
export const modifyApprovalSchema = z.object({
  args: z.record(z.unknown()),
  note: z.string().max(2000).optional(),
});

export type DecideApprovalDto = z.infer<typeof decideApprovalSchema>;
export type ModifyApprovalDto = z.infer<typeof modifyApprovalSchema>;

// --- Analytics / KPI dashboard ---------------------------------------------
// Read-only aggregation over EXISTING data (SkillExecution, Message/Conversation,
// WorkflowRun, ApprovalRequest, AiEmployee). No new persisted models. `range`
// bounds the activity-style metrics by their relevant `createdAt`; current-state
// counts (employees / pending approvals) are point-in-time. Derived money/time
// figures are ILLUSTRATIVE estimates (see analytics.constants.ts).

/** Time window for a KPI query. `all` = no lower bound. */
export type AnalyticsRange = 'today' | '7d' | '30d' | 'all';

export const ANALYTICS_RANGES: readonly AnalyticsRange[] = [
  'today',
  '7d',
  '30d',
  'all',
] as const;

/** Company-wide KPIs for the selected range. */
export interface OverviewDto {
  range: AnalyticsRange;
  // Raw counts (range-bounded by createdAt).
  toolActions: number;
  toolSuccess: number;
  toolErrors: number;
  conversations: number;
  assistantMessages: number;
  workflowRuns: number;
  workflowCompleted: number;
  workflowFailed: number;
  // Current-state counts (point-in-time, not range-bounded).
  pendingApprovals: number;
  employees: number;
  activeEmployees: number;
  // Derived ILLUSTRATIVE estimates.
  tasksCompleted: number;
  hoursSaved: number;
  costSavings: number;
  successRate: number | null;
  utilization: number;
}

/**
 * Attainment of an employee's configured KPI targets (P1 #6): actual measured
 * against target, as a percent. Each field is null when its target is unset (or,
 * for successRate, when there are no tool actions to measure). The whole object
 * is null when the employee has no kpiTargets configured. ILLUSTRATIVE.
 */
export interface KpiAttainmentDto {
  /** tasksCompleted ÷ kpiTargets.tasksPerWeek × 100 (percent of target). */
  tasksPct: number | null;
  /** actual success rate ÷ kpiTargets.successRatePct × 100 (percent of target). */
  successRatePct: number | null;
  /** pendingApprovals ÷ kpiTargets.approvalsMax × 100 (percent of the cap used). */
  approvalsPct: number | null;
  /** Actual success rate in [0,100] for reference; null when no tool actions. */
  successRateActual: number | null;
}

/** Per-employee KPI row. */
export interface EmployeeKpiDto {
  employeeId: string;
  name: string;
  role: EmployeeRole;
  status: EmployeeStatus;
  toolActions: number;
  toolSuccess: number;
  toolErrors: number;
  conversations: number;
  assistantMessages: number;
  pendingApprovals: number;
  // Derived ILLUSTRATIVE estimates (this employee only).
  tasksCompleted: number;
  hoursSaved: number;
  // Configurable KPI targets + computed attainment (P1 #6). Both null when the
  // employee has no targets set (null-safe: existing dashboards unaffected).
  kpiTargets: KpiTargets | null;
  attainment: KpiAttainmentDto | null;
}

/** One grouped activity count in the "Today's AI Activity" feed. */
export interface ActivityItemDto {
  label: string;
  count: number;
}

/** Activity feed entry for a single employee (grouped skill/tool + message counts). */
export interface ActivityFeedDto {
  employeeId: string;
  employee: string;
  role: EmployeeRole;
  items: ActivityItemDto[];
}

// ---------------------------------------------------------------------------
// Billing & Subscription module contracts (Steps 1 + 13).
// ---------------------------------------------------------------------------
// One subscription per company (default STARTER/ACTIVE, created at
// registration). A code-defined PLAN_CATALOG (see api billing.plans.ts) is the
// source of truth for prices/limits/features. The active BillingProvider is
// swappable (mock by default, Stripe opt-in). Plan limits are SOFT: usage is
// surfaced with an "over limit" hint but nothing is blocked. Prices are
// ILLUSTRATIVE (from the proposal); ENTERPRISE is custom (null price).

/** Subscription plan tiers. */
export type Plan = 'STARTER' | 'PRO' | 'BUSINESS' | 'ENTERPRISE';

export const PLANS: readonly Plan[] = [
  'STARTER',
  'PRO',
  'BUSINESS',
  'ENTERPRISE',
] as const;

/** Lifecycle of a subscription. */
/**
 * Decision D4 (settled 2026-08-01): the canonical spelling is the DOUBLE-L
 * `CANCELLED`, matching `SlotStatus` / `WorkflowRunStatus` and doc 00 §0.7.1.
 *
 * `'CANCELED'` remains in the union only because Postgres cannot drop an enum
 * value, so historical rows could still carry it. Never WRITE it — read-only
 * legacy. `isCancelledSubscription()` handles both so no caller has to remember.
 */
export type SubscriptionStatus =
  | 'ACTIVE'
  | 'PAST_DUE'
  | 'CANCELLED'
  /** @deprecated legacy single-L spelling. Read-only; never write. */
  | 'CANCELED';

/** True for either spelling — use this instead of comparing to a literal. */
export function isCancelledSubscription(status: SubscriptionStatus): boolean {
  return status === 'CANCELLED' || status === 'CANCELED';
}

export const SUBSCRIPTION_STATUSES: readonly SubscriptionStatus[] = [
  'ACTIVE',
  'PAST_DUE',
  'CANCELLED',
  // Legacy spelling kept last so UIs iterating this list show the canonical
  // value first.
  'CANCELED',
] as const;

/** One entry in the (code-defined) plan catalog. */
export interface PlanDto {
  plan: Plan;
  name: string;
  /** Illustrative monthly price in USD; null = custom (ENTERPRISE). */
  priceMonthlyUsd: number | null;
  /** Soft cap on AI employees; null = unlimited. */
  maxEmployees: number | null;
  features: string[];
  /**
   * Credit system Phase 7 (Subscription Credits), Task 7.1 (§35.4/Master
   * List #15 Option C) — recurring monthly credit allotment granted on each
   * billing-cycle renewal. `null` = no recurring grant (STARTER: a $0 tier
   * doesn't get a recurring trickle on top of its one-time signup grant).
   */
  includedCreditsPerMonth: number | null;
}

/** Public shape of a company's subscription. */
export interface SubscriptionDto {
  id: string;
  companyId: string;
  plan: Plan;
  status: SubscriptionStatus;
  /** Which BillingProvider owns it ("mock" | "stripe"). */
  provider: string;
  currentPeriodEnd: string | null;
  createdAt: string;
  updatedAt: string;
  /**
   * Present only when a (Stripe) provider returns a hosted checkout URL for a
   * plan change; the mock provider switches immediately and omits this. TODO.
   */
  checkoutUrl?: string | null;
}

/**
 * On-the-fly usage snapshot (no usage table). Counts are computed from existing
 * data; `tokens`/`voiceMinutes` are placeholders (0) until real metering (TODO).
 * `overEmployeeLimit` is a SOFT, informational flag — nothing is blocked.
 */
export interface UsageDto {
  plan: Plan;
  /** Soft cap for the current plan; null = unlimited. */
  maxEmployees: number | null;
  employees: number;
  installedSkills: number;
  /** SkillExecution SUCCESS + assistant Messages + WorkflowRun COMPLETED. */
  tasks: number;
  /** Real total prompt+completion tokens across all LLM calls (all-time). */
  tokens: number;
  /** Illustrative estimate (usage/usage-rates.ts flat rate table), not an exact bill. */
  estimatedCostUsd: number;
  /** Not implemented -- no voice feature exists yet. */
  voiceMinutes: number;
  overEmployeeLimit: boolean;
}

// --- Zod schemas (shared with the web forms) -------------------------------

/** POST /billing/subscription body (change plan). */
export const changePlanSchema = z.object({
  plan: z.enum(['STARTER', 'PRO', 'BUSINESS', 'ENTERPRISE']),
});

export type ChangePlanDto = z.infer<typeof changePlanSchema>;

// ---------------------------------------------------------------------------
// Marketplace expansion module contracts (Step 14).
// ---------------------------------------------------------------------------
// A UNIFIED, code-defined catalog to install more AI Employees, Workflow
// Templates, and Skills into a tenant. There are NO new persistence models:
// installs DELEGATE to the existing Employees / Workflows / Skills services.
// Skills reuse the existing SkillDefinitionDto catalog (not duplicated here).

/** A hireable AI-employee template surfaced in the marketplace. */
export interface EmployeeTemplateDto {
  /** Stable install key (unique across the marketplace). */
  key: string;
  /** Suggested display name for the hired employee (e.g. "SalesAI"). */
  name: string;
  /** The employee vertical the template maps to. */
  role: EmployeeRole;
  /** Concise role instruction seeded onto the created employee's persona. */
  persona: string;
  /** UI grouping label (e.g. "Sales", "Legal"). */
  category: string;
  /** Catalog skill keys this template pairs well with (advisory only). */
  suggestedSkills: string[];
  /** Marketing blurb shown on the template card. */
  description: string;
}

/** A ready-to-install workflow template surfaced in the marketplace. */
export interface WorkflowTemplateDto {
  /** Stable install key (unique across the marketplace). */
  key: string;
  name: string;
  description: string;
  /** UI grouping label (e.g. "Recruiting"). */
  category: string;
  /** The full graph installed verbatim (valid: starts with a TRIGGER). */
  definition: WorkflowDefinition;
}

/** GET /marketplace response — the unified, code-defined catalog. */
export interface MarketplaceCatalogDto {
  employees: EmployeeTemplateDto[];
  /**
   * `workflows` was REMOVED in Phase 4.
   *
   * Two systems installed workflow templates. The DB-backed `WorkflowTemplate`
   * (`/workflow-templates`) is authoritative — it has versioning, provenance,
   * idempotent installs, prerequisite checks and node-vocabulary validation;
   * this code catalog had none of them. Keeping both meant two answers to
   * "which templates exist", which is the duplication Phase 4 §4 removes.
   */
  /** Reuses the existing Skills catalog verbatim. */
  skills: SkillDefinitionDto[];
}

// --- Zod schemas (shared with the web forms) -------------------------------

/** POST /marketplace/employees/:key/install body (optional name override). */
export const installEmployeeSchema = z.object({
  name: z.string().min(1).max(120).optional(),
});

export type InstallEmployeeDto = z.infer<typeof installEmployeeSchema>;

// ---------------------------------------------------------------------------
// Organization module contracts (Security Policies / Teams / Departments, P1 #7).
// ---------------------------------------------------------------------------
// Company-scoped org structure: Departments group Teams; a single SecurityPolicy
// per company holds tenant security settings. All tenant-scoped by companyId.
// Mutations are OWNER/ADMIN only; reads are open to any authenticated member.
// LIGHT enforcement today: passwordMinLength (POST /users + register default) and
// allowedEmailDomains (POST /users). mfaRequired/sessionTimeoutMinutes/
// dataRetentionDays are STORED only (enforcement = documented TODO).

/** A department groups teams within a company. */
export interface DepartmentDto {
  id: string;
  companyId: string;
  name: string;
  description: string | null;
  /**
   * WAVE 2 §2.1 — the resource scopes this department may act on
   * (WorkflowCategory / EmployeeRole / knowledge-category names).
   * EMPTY = unrestricted, which is the default for every department.
   */
  scopes: string[];
  /**
   * How many people are placed in this department right now.
   *
   * Carried on the list DTO rather than fetched per row: the management screen
   * needs it for every department at once, and — more importantly — it is what
   * makes the consequence of a delete visible BEFORE the click.
   */
  memberCount: number;
  /** Teams assigned to this department (a delete unassigns them, never deletes them). */
  teamCount: number;
  createdAt: string;
}

/**
 * What removing a department would affect. Returned before the delete so the
 * caller can choose deliberately, mirroring `EmployeeDependenciesDto`.
 */
export interface DepartmentDependenciesDto {
  departmentId: string;
  name: string;
  /** Users placed here. Deleting without reassigning makes every one of them company-wide. */
  members: Array<{ id: string; name: string; email: string; role: Role }>;
  /** Teams pointing at this department; they survive a delete, unassigned. */
  teams: Array<{ id: string; name: string }>;
  /** The scopes that would stop being enforced. Empty = the department restricted nothing. */
  scopes: string[];
  /**
   * True when deleting would WIDEN someone's access — i.e. the department
   * actually restricts something and has at least one member. This is the case
   * that must never happen silently.
   */
  wouldWidenAccess: boolean;
}

/**
 * Department name presets offered by the onboarding wizard and the "add
 * department" form.
 *
 * PURELY A UI CONVENIENCE. Nothing in the authorization policy reads this list:
 * a department restricts access only through its own `scopes`, and a preset is
 * created with none, exactly like a hand-typed one. Companies are free to
 * ignore every entry here and type their own.
 */
export const DEPARTMENT_PRESETS: readonly string[] = [
  'Sales',
  'Marketing',
  'HR',
  'Recruitment',
  'Customer Support',
  'Finance',
  'Engineering',
  'Operations',
  'Legal',
] as const;

/** A team, optionally belonging to a department (department delete → SetNull). */
export interface TeamDto {
  id: string;
  companyId: string;
  name: string;
  departmentId: string | null;
  createdAt: string;
}

/** The single security policy for a company (created with defaults on first read). */
export interface SecurityPolicyDto {
  id: string;
  companyId: string;
  /** Minimum password length enforced on user creation / registration. */
  passwordMinLength: number;
  /** Whether MFA is required (STORED only — enforcement is a TODO). */
  mfaRequired: boolean;
  /** Session timeout in minutes; 0 = no timeout (STORED only — TODO). */
  sessionTimeoutMinutes: number;
  /** Allowed email domains for new users; empty = no restriction. */
  allowedEmailDomains: string[];
  /** Data retention window in days; 0 = keep forever (STORED only — TODO). */
  dataRetentionDays: number;
  createdAt: string;
  updatedAt: string;
}

// --- Zod schemas (shared with the web forms) -------------------------------

/** POST /departments body. */
export const createDepartmentSchema = z.object({
  name: z.string().min(1, 'Name is required').max(120),
  description: z.string().max(2000).optional(),
  /** WAVE 2 §2.1 — omit or leave empty for an unrestricted department. */
  scopes: z.array(z.string().min(1).max(60)).max(50).optional(),
});

/** PATCH /departments/:id body. */
export const updateDepartmentSchema = z.object({
  name: z.string().min(1).max(120).optional(),
  description: z.string().max(2000).nullable().optional(),
  /** Replaces the whole list; `[]` turns department isolation OFF again. */
  scopes: z.array(z.string().min(1).max(60)).max(50).optional(),
});

/** POST /teams body (optional departmentId). */
export const createTeamSchema = z.object({
  name: z.string().min(1, 'Name is required').max(120),
  departmentId: z.string().min(1).max(60).nullable().optional(),
});

/** PATCH /teams/:id body (optional name / departmentId). */
export const updateTeamSchema = z.object({
  name: z.string().min(1).max(120).optional(),
  departmentId: z.string().min(1).max(60).nullable().optional(),
});

/** PATCH /security-policy body (all fields optional). passwordMinLength floor 8. */
export const updateSecurityPolicySchema = z.object({
  passwordMinLength: z.number().int().min(8).max(128).optional(),
  mfaRequired: z.boolean().optional(),
  sessionTimeoutMinutes: z.number().int().min(0).max(100000).optional(),
  allowedEmailDomains: z.array(z.string().min(1).max(255)).max(100).optional(),
  dataRetentionDays: z.number().int().min(0).max(100000).optional(),
});

export type CreateDepartmentDto = z.infer<typeof createDepartmentSchema>;
export type UpdateDepartmentDto = z.infer<typeof updateDepartmentSchema>;
export type CreateTeamDto = z.infer<typeof createTeamSchema>;
export type UpdateTeamDto = z.infer<typeof updateTeamSchema>;
export type UpdateSecurityPolicyDto = z.infer<typeof updateSecurityPolicySchema>;

// ---------------------------------------------------------------------------
// Connector Event Ingestion (Unit A) contracts.
// ---------------------------------------------------------------------------
// The per-provider event pipeline (docs/architecture/connector-event-workflow-
// architecture.md §2.4/§3/§4): a SIGNED provider webhook hits the "dumb, fast"
// ingestion edge → a RawEvent is persisted append-only + a normalization job
// enqueued (BullMQ `event-normalize`) → a provider MAPPER turns it into the
// provider-agnostic CanonicalEvent below → WorkflowsService.fireEvent drives
// ACTIVE EVENT workflows. Downstream code knows ONLY this canonical vocabulary,
// never a provider's native shape.

/**
 * The controlled, versioned canonical vocabulary every provider mapper
 * normalizes into. Workflows subscribe to these values (an EVENT trigger's
 * `triggerConfig.eventType`), never to a provider's native event name. UNKNOWN
 * is the catch-all for an event we received but do not (yet) map.
 */
export type CanonicalEventType =
  | 'NEW_EMAIL'
  | 'EMAIL_REPLIED'
  | 'NEW_LEAD'
  | 'LEAD_STAGE_CHANGED'
  | 'NEW_PAYMENT'
  | 'PAYMENT_FAILED'
  | 'NEW_JIRA_ISSUE'
  | 'JIRA_ISSUE_UPDATED'
  | 'NEW_GITHUB_PR'
  | 'NEW_GITHUB_ISSUE'
  | 'NEW_TICKET'
  | 'TICKET_REPLIED'
  | 'NEW_PROJECT_ISSUE'
  | 'PROJECT_ISSUE_UPDATED'
  // Plan §16/§17 — the two lifecycle changes BOTH the Chatwoot and Plane
  // sections list as required, and which previously fell to UNKNOWN so no
  // workflow could trigger on them. Provider-neutral on purpose: "someone was
  // assigned" and "the state moved" mean the same thing to an automation
  // whether the record is a support conversation or a project issue.
  | 'ASSIGNMENT_CHANGED'
  | 'STATUS_CHANGED'
  | 'NEW_DOCUMENT'
  | 'NEW_CANDIDATE'
  | 'UNKNOWN';

export const CANONICAL_EVENT_TYPES: readonly CanonicalEventType[] = [
  'NEW_EMAIL',
  'EMAIL_REPLIED',
  'NEW_LEAD',
  'LEAD_STAGE_CHANGED',
  'NEW_PAYMENT',
  'PAYMENT_FAILED',
  'NEW_JIRA_ISSUE',
  'JIRA_ISSUE_UPDATED',
  'NEW_GITHUB_PR',
  'NEW_GITHUB_ISSUE',
  'NEW_TICKET',
  // WAVE 3 §3.4 — a customer replied on an existing support conversation.
  'TICKET_REPLIED',
  'ASSIGNMENT_CHANGED',
  'STATUS_CHANGED',
  // WAVE 3 §3.5 — Plane project-tracker issues. Deliberately NOT reusing the
  // Jira types: a workflow that triggers on "a Jira issue was created" must not
  // start firing for Plane the day Plane is connected.
  'NEW_PROJECT_ISSUE',
  'PROJECT_ISSUE_UPDATED',
  'NEW_DOCUMENT',
  'NEW_CANDIDATE',
  'UNKNOWN',
] as const;

/** Lifecycle of a raw provider event as it moves through normalization. */
export type RawEventStatus = 'RECEIVED' | 'NORMALIZED' | 'FAILED' | 'SKIPPED';

export const RAW_EVENT_STATUSES: readonly RawEventStatus[] = [
  'RECEIVED',
  'NORMALIZED',
  'FAILED',
  'SKIPPED',
] as const;

/** Which append-only log the connector-events observability endpoint reads. */
export type ConnectorEventKind = 'raw' | 'canonical';

/**
 * A raw provider event as received at the ingestion edge (append-only audit).
 * The verbatim `headers`/`payload` are intentionally omitted from the list DTO —
 * this is the lightweight shape the observability endpoints return.
 */
export interface RawEventDto {
  id: string;
  companyId: string;
  connectorId: string;
  provider: string;
  externalId: string | null;
  signatureVerified: boolean;
  status: RawEventStatus;
  error: string | null;
  receivedAt: string;
}

/** A provider-agnostic canonical event envelope (§3.1). */
export interface CanonicalEventDto {
  id: string;
  companyId: string;
  connectorId: string;
  rawEventId: string | null;
  provider: string;
  type: CanonicalEventType;
  dedupeKey: string;
  occurredAt: string | null;
  receivedAt: string;
  subject: Record<string, unknown> | null;
  data: Record<string, unknown> | null;
  schemaVersion: string;
}

/**
 * Response from the ingestion edge (POST /connectors/:connectorId/webhook).
 * A freshly-accepted event returns 202 with `deduped:false`; a re-delivery of an
 * already-seen event returns 200 with `deduped:true` (idempotent no-op).
 */
export interface WebhookAcceptedDto {
  received: boolean;
  deduped: boolean;
  rawEventId: string | null;
}

// ============================================================================
// Resilience (Unit C) — circuit breakers, DLQ + replay, rate limiting.
// Backend infra in apps/api `common/resilience`; these are the shared shapes the
// admin DLQ/health surface returns. See docs §4.4 (retries/DLQ/idempotency) and
// §9 (circuit breakers, rate limiting).
// ============================================================================

/**
 * Per-connector circuit-breaker state (egress, docs §9). CLOSED = healthy;
 * OPEN = failing fast (provider is shedding load, calls are NOT made); HALF_OPEN
 * = a single probe is allowed after the cooldown to test recovery.
 */
export type CircuitState = 'CLOSED' | 'OPEN' | 'HALF_OPEN';

export const CIRCUIT_STATES: readonly CircuitState[] = [
  'CLOSED',
  'OPEN',
  'HALF_OPEN',
] as const;

/**
 * A single dead-lettered (failed, retries-exhausted) BullMQ job, as surfaced by
 * the admin DLQ endpoints. `companyId` is read from the job payload and is used
 * to tenant-scope the view (an admin only ever sees their own company's jobs).
 * `data` carries the (non-secret) job payload — connector/document/run ids.
 */
export interface DlqJobDto {
  /** BullMQ job id. */
  id: string;
  /** Which queue the job belongs to (e.g. `workflow-run`). */
  queue: string;
  /** Job name within the queue (e.g. `run`, `ingest`, `normalize`). */
  name: string;
  /** Tenant the job belongs to (from the payload); null when the payload has none. */
  companyId: string | null;
  /** How many attempts were made before the job was dead-lettered. */
  attemptsMade: number;
  /** The last failure reason recorded by BullMQ. */
  failedReason: string | null;
  /** Enqueue time (epoch ms), null if unavailable. */
  timestamp: number | null;
  /** When the job last finished/failed (epoch ms), null if unavailable. */
  finishedOn: number | null;
  /** The (non-secret) job payload. */
  data: Record<string, unknown> | null;
}

/**
 * Circuit-breaker state for one connector (InstalledSkill), surfaced by the
 * admin health panel. Read-only snapshot; the reported `state` reflects an
 * elapsed cooldown (OPEN→HALF_OPEN) without mutating the stored value.
 */
export interface ConnectorCircuitDto {
  connectorId: string;
  skillKey: string;
  state: CircuitState;
}

/**
 * Per-queue count of dead-lettered (failed) jobs for the caller's company,
 * surfaced by `GET /admin/dlq/summary` for monitoring / alerting on DLQ growth
 * (docs §9). Counts are company-scoped (a bounded scan of each queue's failed
 * set filtered by payload companyId — BullMQ's own counters are not tenant-aware).
 */
export interface DlqSummaryEntryDto {
  queue: string;
  /** Failed jobs belonging to the company in this queue. */
  failed: number;
}

// ---------------------------------------------------------------------------
// Interview Scheduling (bulk-hiring slot pool) contracts.
// ---------------------------------------------------------------------------

export type SlotStatus = 'OPEN' | 'BOOKED' | 'CANCELLED';

export interface InterviewSlotDto {
  id: string;
  companyId: string;
  start: string;
  end: string;
  status: SlotStatus;
  bookedFor: string | null;
  workflowRunId: string | null;
  calendarEventId: string | null;
  meetLink: string | null;
  cancelReason: string | null;
  createdAt: string;
}

export interface SlotSummaryDto {
  open: number;
  booked: number;
  cancelled: number;
}

export const generateSlotsSchema = z.object({
  startDate: z.string().min(1),
  endDate: z.string().min(1),
  daysOfWeek: z.array(z.number().int().min(0).max(6)).min(1).max(7),
  dailyStartHour: z.number().int().min(0).max(23),
  dailyEndHour: z.number().int().min(0).max(23),
  slotMinutes: z.number().int().min(5).max(480),
});
export type GenerateSlotsDto = z.infer<typeof generateSlotsSchema>;

export const addSlotSchema = z.object({
  start: z.string().min(1),
  end: z.string().min(1),
});
export type AddSlotDto = z.infer<typeof addSlotSchema>;

export const blockDateSchema = z.object({
  date: z.string().min(1),
});
export type BlockDateDto = z.infer<typeof blockDateSchema>;

export const rescheduleSlotSchema = z.object({
  title: z.string().max(200).optional(),
});
export type RescheduleSlotDto = z.infer<typeof rescheduleSlotSchema>;

/** Result of atomically claiming the next OPEN slot and scheduling a real Calendar event. */
export interface ClaimAndScheduleResultDto {
  claimed: boolean;
  slotId?: string;
  start?: string;
  end?: string;
  meetLink?: string | null;
  htmlLink?: string | null;
  error?: string;
}

/** Result of POST /scheduling/slots/:id/reschedule. */
export interface RescheduleResultDto {
  oldSlotId: string;
  newSlot: ClaimAndScheduleResultDto;
}

// --- Audit log ---------------------------------------------------------

/**
 * A single who-did-what entry (founder-market-readiness-audit.md §6/§4).
 * actorUserId/actorName are both null for the (rare) system-initiated entry.
 */
export interface AuditLogDto {
  id: string;
  companyId: string;
  actorUserId: string | null;
  /** Resolved at read time from the current Users table; null if the actor
   * no longer exists (deleted) or the entry has no actor. */
  actorName: string | null;
  action: string;
  entityType: string;
  entityId: string | null;
  metadata: Record<string, unknown> | null;
  createdAt: string;
}

// ---------------------------------------------------------------------------
// HR STAFF RECORDS (Wave P3-01)
// The customer's human workforce. Status/type fields are strings (documented
// vocabularies, no DB enums — a new value needs no migration). Special-category
// and personal PII (LeaveRequest.reason, PerformanceReview.aiDraft/finalReview,
// StaffMember.personalEmail/phone, StaffDocument.fileName) is encrypted at rest;
// these DTOs always carry the DECRYPTED plaintext (only OWNER/ADMIN read HR).
// ---------------------------------------------------------------------------

/** Employment status vocabulary for a StaffMember. */
export const STAFF_STATUSES = [
  'CANDIDATE',
  'ONBOARDING',
  'ACTIVE',
  'ON_LEAVE',
  'EXITING',
  'EXITED',
] as const;
export type StaffStatus = (typeof STAFF_STATUSES)[number];

export const EMPLOYMENT_TYPES = [
  'FULL_TIME',
  'PART_TIME',
  'CONTRACT',
  'INTERN',
] as const;
export type EmploymentType = (typeof EMPLOYMENT_TYPES)[number];

export interface StaffMemberDto {
  id: string;
  companyId: string;
  userId: string | null;
  employeeCode: string | null;
  fullName: string;
  workEmail: string | null;
  /** 🔒 decrypted from ciphertext at rest. */
  personalEmail: string | null;
  /** 🔒 decrypted from ciphertext at rest. */
  phone: string | null;
  departmentId: string | null;
  managerStaffId: string | null;
  jobTitle: string | null;
  employmentType: string | null;
  status: string;
  hiredAt: string | null;
  exitedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface CreateStaffMemberDto {
  fullName: string;
  employeeCode?: string | null;
  userId?: string | null;
  workEmail?: string | null;
  personalEmail?: string | null;
  phone?: string | null;
  departmentId?: string | null;
  managerStaffId?: string | null;
  jobTitle?: string | null;
  employmentType?: string | null;
  status?: string;
  hiredAt?: string | null;
}

export interface UpdateStaffMemberDto {
  fullName?: string;
  employeeCode?: string | null;
  userId?: string | null;
  workEmail?: string | null;
  personalEmail?: string | null;
  phone?: string | null;
  departmentId?: string | null;
  managerStaffId?: string | null;
  jobTitle?: string | null;
  employmentType?: string | null;
  status?: string;
  hiredAt?: string | null;
  exitedAt?: string | null;
}

export const LEAVE_TYPES = [
  'ANNUAL',
  'SICK',
  'UNPAID',
  'PARENTAL',
  'OTHER',
] as const;
export type LeaveType = (typeof LEAVE_TYPES)[number];

export const LEAVE_STATUSES = [
  'PENDING',
  'APPROVED',
  'REJECTED',
  'CANCELLED',
] as const;
export type LeaveStatus = (typeof LEAVE_STATUSES)[number];

export interface LeaveRequestDto {
  id: string;
  companyId: string;
  staffId: string;
  leaveType: string;
  startDate: string;
  endDate: string;
  days: number;
  /** 🔒🔒 special-category (health) — decrypted from ciphertext at rest. */
  reason: string | null;
  status: string;
  approvalRequestId: string | null;
  decidedAt: string | null;
  createdAt: string;
}

export interface CreateLeaveRequestDto {
  staffId: string;
  leaveType: string;
  startDate: string;
  endDate: string;
  days: number;
  reason?: string | null;
}

export interface DecideLeaveRequestDto {
  status: string;
}

export const STAFF_DOCUMENT_TYPES = [
  'ID',
  'VISA',
  'CONTRACT',
  'CERTIFICATE',
  'OTHER',
] as const;
export type StaffDocumentType = (typeof STAFF_DOCUMENT_TYPES)[number];

export interface StaffDocumentDto {
  id: string;
  companyId: string;
  staffId: string;
  docType: string;
  storageKey: string;
  /** 🔒 decrypted from ciphertext at rest. */
  fileName: string;
  mimeType: string;
  verifiedAt: string | null;
  verifiedByUserId: string | null;
  aiConfidence: number | null;
  expiresAt: string | null;
  createdAt: string;
}

export interface CreateStaffDocumentDto {
  staffId: string;
  docType: string;
  storageKey: string;
  fileName: string;
  mimeType: string;
  aiConfidence?: number | null;
  expiresAt?: string | null;
}

export const PERFORMANCE_REVIEW_STATUSES = [
  'DRAFT',
  'IN_REVIEW',
  'SHARED',
  'ACKNOWLEDGED',
] as const;
export type PerformanceReviewStatus =
  (typeof PERFORMANCE_REVIEW_STATUSES)[number];

export interface PerformanceReviewDto {
  id: string;
  companyId: string;
  staffId: string;
  periodStart: string;
  periodEnd: string;
  reviewerUserId: string | null;
  /** 🔒 decrypted from ciphertext at rest. */
  aiDraft: string | null;
  /** 🔒 decrypted from ciphertext at rest. */
  finalReview: string | null;
  rating: number | null;
  status: string;
  createdAt: string;
}

export interface CreatePerformanceReviewDto {
  staffId: string;
  periodStart: string;
  periodEnd: string;
  reviewerUserId?: string | null;
  aiDraft?: string | null;
  finalReview?: string | null;
  rating?: number | null;
  status?: string;
}

export interface UpdatePerformanceReviewDto {
  aiDraft?: string | null;
  finalReview?: string | null;
  rating?: number | null;
  status?: string;
}

export const ONBOARDING_OWNER_TYPES = ['AI_EMPLOYEE', 'HUMAN'] as const;
export type OnboardingOwnerType = (typeof ONBOARDING_OWNER_TYPES)[number];

export interface OnboardingTaskDto {
  id: string;
  companyId: string;
  staffId: string;
  title: string;
  ownerType: string;
  ownerId: string | null;
  dueAt: string | null;
  completedAt: string | null;
  runId: string | null;
  createdAt: string;
}

export interface CreateOnboardingTaskDto {
  staffId: string;
  title: string;
  ownerType: string;
  ownerId?: string | null;
  dueAt?: string | null;
  runId?: string | null;
}

export const ATTENDANCE_STATUSES = [
  'PRESENT',
  'ABSENT',
  'LATE',
  'HALF_DAY',
  'ON_LEAVE',
] as const;
export type AttendanceStatus = (typeof ATTENDANCE_STATUSES)[number];

export interface AttendanceRecordDto {
  id: string;
  companyId: string;
  staffId: string;
  date: string;
  status: string;
  note: string | null;
  createdAt: string;
}

export interface CreateAttendanceRecordDto {
  staffId: string;
  date: string;
  status: string;
  note?: string | null;
}

/** Result of one HR data-retention sweep (honours SecurityPolicy.dataRetentionDays). */
export interface HrRetentionResultDto {
  /** ISO cut-off basis the sweep ran against. */
  ranAt: string;
  /** Companies with a positive dataRetentionDays that were processed. */
  companiesProcessed: number;
  deleted: {
    leaveRequests: number;
    attendanceRecords: number;
    staffDocuments: number;
    performanceReviews: number;
    onboardingTasks: number;
  };
}

// ---------------------------------------------------------------------------
// WORKFLOW TEMPLATES (Wave P3-02)
// Installable, parameterised workflow blueprints. Install performs a deep COPY
// into the tenant (provenance recorded, no live link) → DRAFT workflow + v1
// PUBLISHED version. See docs/architecture/workflow-system/19-workflow-templates-spec.md.
// ---------------------------------------------------------------------------

/** How a template parameter binds to a tenant resource rather than a literal. */
export const TEMPLATE_PARAMETER_BINDS = [
  'skill',
  'employee',
  'knowledgeCategory',
  'channel',
] as const;
export type TemplateParameterBind = (typeof TEMPLATE_PARAMETER_BINDS)[number];

/** doc 19 §6.3 — one install-time input a template declares. */
export interface TemplateParameter {
  key: string;
  label: string;
  type: VariableType; // 00 §0.7.1
  required: boolean;
  default?: unknown;
  /** Bind to a tenant resource (a template can't hardcode an employee id). */
  binds?: TemplateParameterBind;
  help?: string;
}

/** Tenant prerequisites an install verifies before creating anything. */
export interface WorkflowTemplateRequires {
  /** skillKeys that must be installed for the company. */
  skills: string[];
  employeeRoles: EmployeeRole[];
  minPlan?: Plan;
}

/** doc 19 §8 — the authoring shape of a template (definition carries {{param.*}}). */
export interface WorkflowTemplateManifest {
  key: string;
  version: number;
  name: string;
  description: string;
  category: WorkflowCategory;
  parameters: TemplateParameter[];
  requires: WorkflowTemplateRequires;
  definition: WorkflowDefinition;
}

/**
 * GET /workflow-templates + /workflow-templates/:id/parameters response. The
 * DB-backed, parameterised template (distinct from the marketplace-lite
 * `WorkflowTemplateDto`). `definition` is intentionally omitted — it is internal.
 */
export interface WorkflowTemplateSummaryDto {
  id: string;
  /** null = first-party / trusted; non-null = tenant-authored. */
  companyId: string | null;
  key: string;
  version: number;
  name: string;
  description: string | null;
  category: WorkflowCategory;
  parameters: TemplateParameter[];
  requires: WorkflowTemplateRequires;
  status: string; // WorkflowVersionStatus
  createdAt: string;
}

/** POST /workflow-templates/:id/install body. */
export interface InstallWorkflowTemplateDto {
  /** Override the installed workflow's name; defaults to the template name. */
  name?: string;
  /** Values for the template's declared parameters. */
  parameters?: Record<string, unknown>;
}

/** POST /workflow-templates body — author a tenant-owned (third-party) template. */
export interface CreateWorkflowTemplateDto {
  key: string;
  version?: number;
  name: string;
  description?: string;
  category: WorkflowCategory;
  parameters?: TemplateParameter[];
  requires?: Partial<WorkflowTemplateRequires>;
  definition: WorkflowDefinition;
}

// ---------------------------------------------------------------------------
// WORKFLOW PERMISSIONS (Wave P3-06) — doc 09 §9.C.5
// Per-workflow access-control grants. `RUN` is enforced at enqueue (doc 16 §21);
// a workflow with no grants is open to any member (back-compat).
// ---------------------------------------------------------------------------

export const WORKFLOW_PERMISSION_SUBJECT_TYPES = [
  'USER',
  'ROLE',
  'DEPARTMENT',
  'TEAM',
  'EMPLOYEE',
] as const;
export type WorkflowPermissionSubjectType =
  (typeof WORKFLOW_PERMISSION_SUBJECT_TYPES)[number];

export const WORKFLOW_PERMISSION_ACTIONS = [
  'VIEW',
  'EDIT_GRAPH',
  'UPDATE',
  'PUBLISH',
  'RUN',
  'DELETE',
  'MANAGE_PERMISSIONS',
] as const;
export type WorkflowPermissionAction =
  (typeof WORKFLOW_PERMISSION_ACTIONS)[number];

export interface WorkflowPermissionDto {
  id: string;
  companyId: string;
  workflowId: string;
  subjectType: WorkflowPermissionSubjectType;
  /** User.id | Role value | Department.id | Team.id | AiEmployee.id (by subjectType). */
  subjectId: string;
  action: WorkflowPermissionAction;
  grantedByUserId: string;
  createdAt: string;
}

/** POST /workflows/:id/permissions body. */
export interface CreateWorkflowPermissionDto {
  subjectType: WorkflowPermissionSubjectType;
  subjectId: string;
  action: WorkflowPermissionAction;
}

// ---------------------------------------------------------------------------
// Workflow node-metadata catalog (server-authored node registry).
// ---------------------------------------------------------------------------
// A STATIC, code-defined description of every workflow NodeType: its category,
// human label/description, handle topology (inputs/outputs) and the config
// fields the Inspector renders. Mirrors the proven SkillCatalog pattern — the
// engine's node HANDLERS expose only `type` + `execute()`, so this metadata is
// authored server-side rather than derived from them, and served by
// `GET /workflows/node-definitions` so the Workflow Builder no longer needs a
// hardcoded client node-registry.
//
// Canonical shapes: doc 00 §0.7 (NodeCategory) and doc 02 §7 (NodeConfigField,
// NodeOutputHandle). NodeDefinitionDto here is the STATIC-metadata projection
// for that endpoint — retry/timeout/permission/execute (doc 02's full
// NodeDefinition) are Phase-5 engine concerns and intentionally omitted.

/** Node category — drives the UI node-library grouping (doc 00 §0.7.1). */
export type NodeCategory =
  | 'TRIGGER'
  | 'AI_EMPLOYEE'
  | 'LOGIC'
  | 'SKILL'
  | 'APPROVAL'
  | 'MEMORY'
  | 'KNOWLEDGE'
  | 'VARIABLE'
  | 'COMMUNICATION'
  | 'UTILITY'
  | 'DATABASE'
  | 'EXTERNAL_API';

export const NODE_CATEGORIES: readonly NodeCategory[] = [
  'TRIGGER',
  'AI_EMPLOYEE',
  'LOGIC',
  'SKILL',
  'APPROVAL',
  'MEMORY',
  'KNOWLEDGE',
  'VARIABLE',
  'COMMUNICATION',
  'UTILITY',
  'DATABASE',
  'EXTERNAL_API',
] as const;

/**
 * Input widget / semantic type of one node config field (doc 02 §7). Extends
 * the primitive ConfigFieldType set with semantic types so the Inspector can
 * render a real employee/skill/tool picker (instead of a free-text id) and a
 * validator can check the referenced entity exists.
 */
export type NodeConfigFieldType =
  | 'string'
  | 'text'
  | 'number'
  | 'boolean'
  | 'select'
  | 'employee'
  | 'skill'
  | 'tool'
  | 'channel'
  | 'knowledgeCategory'
  | 'expression'
  | 'duration'
  | 'variableScope'
  | 'json';

/**
 * One configurable field on a node. Modelled on ConfigFieldDto (skills) with the
 * richer node field-type union (doc 02 §7). Drives the Inspector form and,
 * later, save-time validation.
 */
export interface NodeConfigField {
  key: string;
  label: string;
  type: NodeConfigFieldType;
  required?: boolean;
  /** Sensible default for a freshly added node of this type. */
  default?: unknown;
  /** For 'select' / 'variableScope' fields. */
  options?: { value: string; label: string }[];
  placeholder?: string;
  help?: string;
  /** True when the value may contain {{templates}} — Inspector offers autocomplete. */
  templatable?: boolean;
}

/** One output handle (edge source) on a node (doc 02 §7). */
export interface NodeOutputHandle {
  /** Edge `branch` value this handle produces. Absent = the default output. */
  branch?: string;
  label: string;
}

/**
 * The static, serialisable description of one NodeType, served by
 * `GET /workflows/node-definitions`. The node-metadata projection for the
 * Workflow Builder palette + Inspector — NOT the full execution-time
 * NodeDefinition (doc 02 §7); the engine (Phase 5) owns retry/timeout/
 * permission/execute, which are deliberately absent from this metadata contract.
 */
export interface NodeDefinitionDto {
  type: NodeType;
  category: NodeCategory;
  label: string;
  description: string;
  /** 0 for TRIGGER (graph root); 1 for every other node type. */
  inputs: number;
  /**
   * Static output handles. CONDITION → true/false; TERMINATE → none; nodes whose
   * real outputs are author-defined carry `dynamicOutputs` and an empty array.
   */
  outputs: NodeOutputHandle[];
  /**
   * Set when a node's real outputs are derived from its config at author time,
   * so the canvas renders handles dynamically: SWITCH (one per case), PARALLEL
   * (one per lane), LOOP (body + done).
   */
  dynamicOutputs?: 'switch' | 'parallel' | 'loop';
  configSchema: NodeConfigField[];
  /** True when executing the node causes an irreversible external effect. */
  hasSideEffects: boolean;
  /** True when a run can PAUSE at this node for a human approval. */
  canPauseForApproval: boolean;
}

// ── Orlixa AI Assist (doc 30) ────────────────────────────────────────────────
// The conversational workflow builder. NEW — promote into `00 §0.7` per the
// canonical-contracts rule once implemented.

export type AssistSessionStatus = 'ACTIVE' | 'COMPLETED' | 'EXHAUSTED' | 'ARCHIVED';

export const ASSIST_SESSION_STATUSES: readonly AssistSessionStatus[] = [
  'ACTIVE',
  'COMPLETED',
  'EXHAUSTED',
  'ARCHIVED',
] as const;

export type AssistMessageRole =
  | 'USER'
  | 'ASSISTANT'
  | 'QUESTION'
  | 'ANSWER'
  | 'CONNECTION'
  | 'TEST'
  | 'SYSTEM';

export const ASSIST_MESSAGE_ROLES: readonly AssistMessageRole[] = [
  'USER',
  'ASSISTANT',
  'QUESTION',
  'ANSWER',
  'CONNECTION',
  'TEST',
  'SYSTEM',
] as const;

/** One field of a structured clarifying question (doc 30 §11). */
export interface AssistQuestionField {
  id: string;
  label: string;
  type: 'single-select' | 'multi-select' | 'text' | 'employee' | 'skill';
  options?: { value: string; label: string; hint?: string }[];
  /** Adds the free-text escape hatch to a select ("Something else"). */
  allowOther?: boolean;
  required?: boolean;
  placeholder?: string;
}

/** A paged clarifying form. Max 4 fields; the UI shows "1 of N" + Skip. */
export interface AssistQuestionForm {
  fields: AssistQuestionField[];
  skippable: boolean;
}

/** Per-step outcome of an assist dry-run self-test (doc 30 §13.2). */
export interface AssistTestStep {
  nodeId: string;
  name: string;
  /**
   * A narrowed view of `StepRunStatus`, which has eight members. `WAITING` is
   * here because a dry run that stops at an approval gate is the gate WORKING,
   * and the panel already says so at the run level — collapsing it into
   * "running" would hide the one outcome the user most needs to recognise.
   * The remaining engine states are folded in `assist-test-tool.ts`.
   */
  status: 'COMPLETED' | 'FAILED' | 'SKIPPED' | 'RUNNING' | 'WAITING';
  ms: number;
  /**
   * True when the engine short-circuited a real side effect because the run was
   * a dry run. Surfaced in the UI as an explicit "Simulated" chip — never hidden.
   */
  simulated: boolean;
  outputPreview?: string;
  error?: string;
}

export interface AssistTestResult {
  runId: string;
  status: 'COMPLETED' | 'WAITING' | 'FAILED' | 'TIMED_OUT';
  steps: AssistTestStep[];
  /** Plain-language summary, written by the server (not the model). */
  headline: string;
}

/** A node the agent could not resolve against real tenant resources. */
export interface AssistUnresolvedNodeDto {
  nodeId: string;
  reason: string;
}

export interface AssistMessageDto {
  id: string;
  sessionId: string;
  role: AssistMessageRole;
  content: string;
  metadata?: Record<string, unknown> | null;
  createdAt: string;
}

/** List projection — no messages, no draft (both can be large). */
export interface AssistSessionSummaryDto {
  id: string;
  title: string;
  status: AssistSessionStatus;
  targetWorkflowId: string | null;
  createdWorkflowId: string | null;
  /** How many steps the in-progress draft currently has; 0 when there is none. */
  draftNodeCount: number;
  updatedAt: string;
  createdAt: string;
}

export interface AssistSessionDto extends AssistSessionSummaryDto {
  draftDefinition: WorkflowDefinition | null;
  draftVersion: number;
  originRunId: string | null;
  promptTokens: number;
  completionTokens: number;
  messages: AssistMessageDto[];
}

/** An entry-screen chip, grounded in what this tenant actually owns. */
export interface AssistSuggestionDto {
  id: string;
  label: string;
  prompt: string;
}

/** One entry in the collapsible "thinking" trace shown under a reply. */
export interface AssistToolTraceDto {
  name: string;
  /** Human copy written by the SERVER, never raw tool args. */
  summary: string;
  ok: boolean;
}

/**
 * A frame on the assist turn stream (doc 30 §10).
 *
 * Ordering invariants the client relies on:
 *  - `graph` is emitted at most once per turn, AFTER the last mutation and
 *    BEFORE `done`, so the canvas is never behind the text describing it.
 *  - `connection` (when present) follows `graph` and precedes `done`, so the
 *    in-chat Skill card renders against the just-emitted draft.
 *  - exactly one `done` per turn, and it is always last — including after an
 *    `error`, so a client can always close on it rather than guessing.
 */
export type AssistStreamEvent =
  /** A step of work starting; drives the "thinking" row. */
  | { type: 'thinking'; label: string }
  /** A piece of the assistant's reply text. */
  | { type: 'token'; text: string }
  /** A tool finished. */
  | { type: 'tool'; tool: AssistToolTraceDto }
  /** The draft graph changed. */
  | {
      type: 'graph';
      definition: WorkflowDefinition;
      version: number;
      unresolved: AssistUnresolvedNodeDto[];
    }
  /** The agent test-ran the draft; every simulated step is flagged as such. */
  | { type: 'test'; result: AssistTestResult }
  /**
   * The draft needs one or more skills connected before it can run (doc 30 §12).
   * `requirements` lists every connection-requiring skill the draft references
   * (connected ✓ and not-connected alike) so the in-chat card shows the whole
   * picture; the client refreshes live status from `GET /skills/requirements`.
   */
  | { type: 'connection'; requirements: WorkflowSkillRequirementDto[]; reason: string }
  | { type: 'error'; code: string; message: string; retryable: boolean }
  | { type: 'done'; finished: boolean };

// Runtime schemas for API RESPONSES (contract tests). Exported last: this
// module imports request schemas from here, so the re-export must come after
// their definitions to keep the CommonJS cycle safe.
export * from './response-schemas';
export * from './credits';

// ---------------------------------------------------------------------------
// Product context / capability resolution (Phase 3).
// ---------------------------------------------------------------------------

/**
 * A coherent area of the product.
 *
 * Deliberately coarse — one entry per place a customer can go, not per route.
 * This is the vocabulary the resolver speaks, so it has to be small enough that
 * a human can hold the whole mapping in their head. If it ever needs a
 * sub-hierarchy, that is a sign relevance is being asked to do a job
 * authorization should be doing.
 */
export type ProductArea =
  | 'DASHBOARD'
  | 'EMPLOYEES'
  | 'SKILLS'
  | 'KNOWLEDGE'
  | 'WORKFLOWS'
  | 'RUNS'
  | 'SCHEDULES'
  | 'APPROVALS'
  | 'ASSIST'
  | 'MARKETPLACE'
  | 'INTERVIEW_SCHEDULING'
  | 'MARKETING'
  | 'BILLING'
  | 'TEAM'
  | 'ORGANIZATION'
  | 'ADMIN_HEALTH';

export const PRODUCT_AREAS: readonly ProductArea[] = [
  'DASHBOARD',
  'EMPLOYEES',
  'SKILLS',
  'KNOWLEDGE',
  'WORKFLOWS',
  'RUNS',
  'SCHEDULES',
  'APPROVALS',
  'ASSIST',
  'MARKETPLACE',
  'INTERVIEW_SCHEDULING',
  'MARKETING',
  'BILLING',
  'TEAM',
  'ORGANIZATION',
  'ADMIN_HEALTH',
] as const;

/**
 * Why an area or a skill ended up in the resolved output.
 *
 * Carried so the answer is explainable rather than magic: a support engineer
 * looking at "why can this customer not see Interview scheduling?" gets a
 * reason, not a shrug. Also what makes the resolver testable — an assertion on
 * `reason` catches a mapping that produced the right answer for the wrong
 * cause.
 */
export type RelevanceReason =
  | 'CORE'
  | 'HIRED_EMPLOYEE'
  | 'INDUSTRY'
  | 'BUSINESS_GOAL'
  | 'DEPARTMENT'
  | 'INSTALLED_SKILL'
  | 'NO_CONFIGURATION';

/**
 * Where each product area lives, and how the shell groups it.
 *
 * SHARED because both sides need it and neither owns it: the API builds
 * `navigation` from it, and the frontend needs the same routes for the
 * fallback it renders while `/product-context` is in flight. Two copies of a
 * route table drift the first time a page moves — this is the whole point of
 * `@vaep/types`.
 *
 * Presentation only. Nothing here decides whether an area is available; that
 * is the resolver's job, and it can only ever produce a subset of these keys.
 */
export const PRODUCT_AREA_NAV: Readonly<
  Record<
    ProductArea,
    { href: string; label: string; group: 'PRIMARY' | 'AUTOMATION' | 'SECONDARY' | 'ADMIN' }
  >
> = {
  DASHBOARD: { href: '/dashboard', label: 'Dashboard', group: 'PRIMARY' },
  EMPLOYEES: { href: '/employees', label: 'AI Employees', group: 'PRIMARY' },
  SKILLS: { href: '/skills', label: 'Skills', group: 'PRIMARY' },
  ASSIST: { href: '/assist', label: 'AI Assist', group: 'PRIMARY' },
  KNOWLEDGE: { href: '/knowledge', label: 'Knowledge', group: 'PRIMARY' },
  WORKFLOWS: { href: '/workflows', label: 'Workflows', group: 'AUTOMATION' },
  RUNS: { href: '/runs', label: 'Runs', group: 'AUTOMATION' },
  SCHEDULES: { href: '/schedules', label: 'Schedules', group: 'AUTOMATION' },
  INTERVIEW_SCHEDULING: {
    href: '/scheduling',
    label: 'Interview scheduling',
    group: 'SECONDARY',
  },
  MARKETING: { href: '/marketing', label: 'Marketing', group: 'SECONDARY' },
  MARKETPLACE: { href: '/marketplace', label: 'Marketplace', group: 'SECONDARY' },
  APPROVALS: { href: '/approvals', label: 'Approvals', group: 'SECONDARY' },
  BILLING: { href: '/billing', label: 'Billing', group: 'ADMIN' },
  TEAM: { href: '/team', label: 'Team', group: 'ADMIN' },
  ORGANIZATION: { href: '/organization', label: 'Organization', group: 'ADMIN' },
  ADMIN_HEALTH: { href: '/admin/health', label: 'System health', group: 'ADMIN' },
};

/** One navigation entry, resolved rather than hardcoded per page. */
export interface ResolvedNavItemDto {
  area: ProductArea;
  /** Route this area lives at. */
  href: string;
  label: string;
  /** Grouping hint for the shell; presentation only. */
  group: 'PRIMARY' | 'AUTOMATION' | 'SECONDARY' | 'ADMIN';
}

/** What the plan allows, resolved once instead of re-derived per page. */
export interface EntitlementsDto {
  plan: Plan;
  /** Marketing feature bullets from PLAN_CATALOG. */
  features: string[];
  /** null = unlimited. */
  maxEmployees: number | null;
  /** Areas this plan does NOT include, with the tier that would unlock them. */
  lockedAreas: Array<{ area: ProductArea; requiresPlan: Plan }>;
}

/** A skill worth installing, and the reason it is being suggested. */
export interface RecommendedSkillDto {
  skillKey: string;
  name: string;
  /** The provider-agnostic capability that makes it relevant. */
  capability: SkillCapability;
  reason: RelevanceReason;
  /** Human sentence naming the specific configuration that triggered it. */
  because: string;
  /** REAL / PARTIAL / SIMULATED — never recommend a fake integration silently. */
  executionSupport: SkillExecutionSupport;
}

/**
 * How a skill stands relative to THIS company, for the discovery screen.
 *
 * Ordered from "most actionable" to "least". Every catalog skill gets exactly
 * one, and none of them removes access: a skill that is merely not recommended
 * is `AVAILABLE`, still installable, still listed.
 */
export type SkillStatus =
  /** Installed and verified — real actions will reach the provider. */
  | 'CONNECTED'
  /** Installed but the connection is missing, degraded or revoked. */
  | 'NEEDS_CONFIGURATION'
  /** Not installed, and this company's configuration says it would help. */
  | 'RECOMMENDED'
  /** Not installed, no signal that it is needed. Fully installable. */
  | 'AVAILABLE'
  /** Has no real executor — installable, but every call is a sandbox result. */
  | 'SIMULATED_ONLY';

/** One catalog skill, categorised for the discovery screen. */
export interface SkillStatusDto {
  skillKey: string;
  name: string;
  status: SkillStatus;
  /** Present for RECOMMENDED — the configuration that triggered it. */
  because: string | null;
  /** Present for NEEDS_CONFIGURATION — the raw connector state. */
  connectionStatus: string | null;
  executionSupport: SkillExecutionSupport;
}

/**
 * A dashboard widget the company's configuration makes worth rendering.
 *
 * `kind` is the STABLE identifier the frontend switches on; everything else is
 * data. Adding a widget is a new `kind` plus one aggregate query, not a new
 * dashboard page.
 */
export type DashboardWidgetKind =
  | 'COMPANY_SUMMARY'
  | 'HR_ACTIVITY'
  | 'MARKETING_ACTIVITY'
  | 'SUPPORT_ACTIVITY'
  | 'APPROVALS';

/**
 * One number on a widget, with the route that explains it.
 *
 * `href` is what stops a dashboard being a wall of dead figures — every metric
 * links to the screen it came from.
 */
export interface WidgetMetricDto {
  label: string;
  value: number;
  href: string | null;
  /** True when this metric is the one asking for attention (pending, failed…). */
  attention?: boolean;
}

/**
 * What to show when a widget is RELEVANT but has nothing behind it yet.
 *
 * The difference between "your Marketing AI Employee is ready — connect a
 * social account" and a zero. The first is a next step; the second is a dead
 * end that makes the product look broken on day one.
 */
export interface WidgetSetupHintDto {
  message: string;
  ctaLabel: string;
  ctaHref: string;
}

export interface DashboardWidgetDto {
  kind: DashboardWidgetKind;
  title: string;
  metrics: WidgetMetricDto[];
  /** Present only when the widget has no data AND a concrete next step exists. */
  setupHint: WidgetSetupHintDto | null;
}

/** GET /product-context/dashboard */
export interface DashboardCompositionDto {
  companyId: string;
  widgets: DashboardWidgetDto[];
}

/** A first-party or tenant template the company could actually install today. */
export interface AvailableTemplateDto {
  id: string;
  key: string;
  name: string;
  category: WorkflowCategory;
  /** True when every `requires` prerequisite is already satisfied. */
  ready: boolean;
  /** What is still missing when `ready` is false. */
  missingSkills: string[];
  missingEmployeeRoles: EmployeeRole[];
  requiresPlan: Plan | null;
}

/**
 * THE resolved answer to "what is relevant and available for this company,
 * department, user and hired AI Employees, right now?".
 *
 * ## Relevance is not permission
 *
 * Everything in here has already been filtered by all three of:
 *   RELEVANT (does this company's configuration make it useful?)
 *   ENTITLED (does the plan include it?)
 *   AUTHORIZED (does the existing policy allow THIS user?)
 *
 * The resolver does not replace `AuthorizationService` — it calls it. A future
 * caller must never treat presence in this payload as a substitute for the
 * server-side check on the endpoint being called; this is what to SHOW, and
 * the endpoint remains what ENFORCES.
 */
export interface ProductContextDto {
  companyId: string;
  /** Echoed configuration, so a caller never re-fetches to explain the answer. */
  configuration: {
    industry: string | null;
    size: string | null;
    businessGoals: string[];
    departments: string[];
    hiredEmployeeRoles: EmployeeRole[];
    /** True when the company has told us essentially nothing yet. */
    isMinimallyConfigured: boolean;
  };
  entitlements: EntitlementsDto;
  /** Areas that are relevant AND entitled AND authorized for this user. */
  productAreas: ProductArea[];
  /** Why each area is present — same keys as `productAreas`. */
  areaReasons: Record<string, RelevanceReason>;
  navigation: ResolvedNavItemDto[];
  /**
   * Dashboard sections worth rendering. A superset key per hired employee role
   * plus the always-on company summary; Phase 4 consumes this.
   */
  dashboardCapabilities: string[];
  /** Installed skill keys that match this company's configuration. */
  relevantSkills: string[];
  recommendedSkills: RecommendedSkillDto[];
  /**
   * EVERY catalog skill, categorised. Superset of `recommendedSkills`.
   *
   * Deliberately exhaustive: the skills screen must keep offering a skill the
   * company can legitimately use even when nothing about their configuration
   * suggests it. Relevance sorts the list; it never shortens it.
   */
  skillStatuses: SkillStatusDto[];
  availableWorkflowTemplates: AvailableTemplateDto[];
  /** AI Employee ids this user may see AND that match their department scope. */
  relevantEmployeeIds: string[];
}

// ---------------------------------------------------------------------------
// Human handoff (S-13/C-06) — the inbox contract.
// ---------------------------------------------------------------------------

export type HandoffStatus = 'PENDING' | 'RESOLVED' | 'CANCELLED';

/**
 * One escalation from an AI Employee to a human, with enough conversation
 * context to act on without a second request.
 *
 * The AI could already escalate (`POST /support/conversations/:id/escalate`)
 * and a human could already resolve one they knew the id of — but nothing
 * LISTED them, so an escalation went to a queue no screen displayed. This DTO
 * backs that queue.
 */
export interface HandoffRequestDto {
  id: string;
  companyId: string;
  conversationId: string;
  employeeId: string;
  /** Why the AI stepped back. Written by the escalating employee/workflow. */
  reason: string;
  status: HandoffStatus;
  /** Set when routing named one person; null when it falls back to any admin. */
  assigneeUserId: string | null;
  resolvedById: string | null;
  resolvedAt: string | null;
  note: string | null;
  createdAt: string;
  /**
   * Whether the CALLING user may resolve this one, decided by the same
   * `ApprovalRoutingService.canDecide` the approvals inbox uses. Sent so the
   * UI can show the whole queue while disabling what this person cannot act
   * on — the server still enforces it on the resolve call.
   */
  canResolve: boolean;
  /** Conversation context, so the inbox is readable without a second fetch. */
  conversation: {
    id: string;
    contactEmail: string | null;
    status: string;
    lastMessageAt: string;
    /** The most recent messages, oldest-first — what the human needs to judge. */
    recentMessages: Array<{
      id: string;
      /**
       * Narrowed to the real `SupportMessageDirection` values rather than
       * `string`: the UI decides "Customer" vs "AI" from this, and a loose
       * `string` let a wrong literal through in a test fixture, which would
       * have labelled every customer message as the AI.
       */
      direction: 'IN' | 'OUT';
      body: string;
      createdAt: string;
    }>;
  } | null;
}

/** POST /handoffs/:id/resolve body. */
export interface ResolveHandoffRequestDto {
  /** true = the AI may resume this conversation; false = close it. */
  resume: boolean;
  note?: string;
}

// ---------------------------------------------------------------------------
// Marketing workspace
//
// The human-facing half of the Marketing AI Employee. The `postiz.*` skill
// tools already write ScheduledPost/PublishedPost/SocialAccount rows, and the
// reconciliation sweep already moves them between states — but nothing ever
// SHOWED any of it to a person, so an AI could publish to a company's real
// social accounts with no screen listing what it had queued or sent.
// ---------------------------------------------------------------------------

export type SocialAccountStatus = 'CONNECTED' | 'DISCONNECTED' | 'DEGRADED';

export type ScheduledPostStatus =
  | 'DRAFT'
  | 'PENDING_APPROVAL'
  | 'SCHEDULED'
  | 'PUBLISHED'
  | 'FAILED';

export interface SocialAccountDto {
  id: string;
  /** Postiz provider identifier, e.g. "instagram", "linkedin". */
  provider: string;
  displayName: string | null;
  status: SocialAccountStatus;
  /** Set when this account belongs to one AI Employee rather than the company. */
  employeeId: string | null;
  externalAccountId: string | null;
  createdAt: string;
}

export interface ScheduledPostDto {
  id: string;
  socialAccountId: string;
  /** Denormalised for the list view, so one page load is one request. */
  socialAccountProvider: string;
  socialAccountName: string | null;
  campaignId: string | null;
  campaignName: string | null;
  content: string;
  publishAt: string;
  status: ScheduledPostStatus;
  /**
   * Null until the post has actually been handed to Postiz. A SCHEDULED row
   * with no `postizPostId` would never publish and never reconcile, so the
   * API refuses to create one — see `MarketingService.createPost`.
   */
  postizPostId: string | null;
  /** Present once published: the live permalink the customer can check. */
  permalink: string | null;
  publishedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface CreateScheduledPostDto {
  socialAccountId: string;
  content: string;
  /** ISO datetime. Required when sending straight to Postiz. */
  publishAt?: string;
  campaignId?: string;
  /**
   * false (default) saves a local DRAFT only — nothing reaches Postiz.
   * true hands it to Postiz immediately and stores the returned id.
   */
  schedule?: boolean;
}

export interface UpdateScheduledPostDto {
  content?: string;
  publishAt?: string;
  campaignId?: string | null;
}

/**
 * Campaign lifecycle (architecture doc §76/§77).
 *
 * PAUSED is an addition to the document's list: the shipped campaigns UI
 * already writes it, and removing a state the product uses to satisfy a spec
 * would break real rows.
 */
export type CampaignStatus =
  | 'DRAFT'
  | 'ANALYZING'
  | 'PLANNING'
  | 'GENERATING'
  | 'MEDIA_GENERATING'
  | 'QUALITY_CHECK'
  | 'READY_FOR_REVIEW'
  | 'PARTIALLY_APPROVED'
  | 'APPROVED'
  | 'SCHEDULED'
  | 'PUBLISHING'
  | 'ACTIVE'
  | 'PAUSED'
  | 'COMPLETED'
  | 'FAILED'
  | 'CANCELLED';

/**
 * The subset a human may set directly.
 *
 * Generation states (ANALYZING/PLANNING/GENERATING/...) are owned by the
 * pipeline — letting a client PATCH itself to READY_FOR_REVIEW would be a way
 * to skip generation entirely, and PATCHing to PUBLISHING would claim work that
 * never happened. Operational states only.
 */
export const MANUAL_CAMPAIGN_STATUSES = [
  'ACTIVE',
  'PAUSED',
  'COMPLETED',
  'CANCELLED',
] as const;
export type ManualCampaignStatus = (typeof MANUAL_CAMPAIGN_STATUSES)[number];

export interface CampaignDto {
  id: string;
  name: string;
  goal: string | null;
  status: CampaignStatus;
  aiEmployeeId: string | null;
  /** How many scheduled posts belong to this campaign. */
  postCount: number;
  createdAt: string;
}

export interface CreateCampaignDto {
  name: string;
  goal?: string;
  aiEmployeeId?: string;
}

export interface UpdateCampaignDto {
  name?: string;
  goal?: string | null;
  status?: ManualCampaignStatus;
}

export interface MarketingAnalyticsSnapshotDto {
  id: string;
  socialAccountId: string;
  capturedAt: string;
  metrics: Record<string, unknown>;
}

/** Result of importing connected accounts from the shared Postiz instance. */
export interface ImportSocialAccountsResultDto {
  imported: number;
  updated: number;
  accounts: SocialAccountDto[];
}
