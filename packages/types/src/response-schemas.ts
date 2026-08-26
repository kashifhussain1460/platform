import { z } from 'zod';
import type {
  AiEmployeeDto,
  ApprovalRequestDto,
  ApprovalRoutingConfig,
  AssistMessageDto,
  AssistSessionDto,
  AssistSessionSummaryDto,
  AssistSuggestionDto,
  AuditLogDto,
  CompanyDto,
  KnowledgeDocumentDto,
  KpiTargets,
  TriggerConfig,
  UserDto,
  WorkflowDefinition,
  WorkflowDto,
  WorkflowRunDto,
  WorkflowStepRunDto,
} from './index';
// From the dependency-free leaf module, NOT from './index' — index.ts
// re-exports this whole file (`export * from './response-schemas'`), so
// importing these runtime values back from './index' created a circular
// import (a live TDZ crash: "Cannot access 'workflowDefinitionSchema' before
// initialization", reproduced via browser-testing /onboarding on 2026-08-02).
// The `import type {...} from './index'` above is fine — type-only imports
// are erased at build time and never participate in the runtime cycle.
import {
  kpiTargetsSchema,
  triggerConfigSchema,
  workflowDefinitionSchema,
} from './shared-schemas';

/**
 * RUNTIME schemas for API **responses**.
 *
 * Why this file exists: `@vaep/types` already had 40 zod schemas, but every one
 * of them validates a REQUEST body. Nothing verified that the API actually
 * returns what its published TypeScript type claims — so a field rename on the
 * server was invisible until the frontend broke at runtime. (The real example
 * this is designed to catch: the run-event envelope field being written as
 * `sequence` in one document and `seq` in another.)
 *
 * ── The single-source-of-truth guarantee ──────────────────────────────────
 * A hand-written schema sitting next to a hand-written interface is just two
 * things to keep in sync — it moves the drift problem rather than solving it.
 * So every schema below is paired with a compile-time assertion that its
 * inferred type is EXACTLY the published DTO. If someone adds a field to
 * `WorkflowDto` and not to `workflowDtoSchema` (or vice versa), `tsc` fails.
 * The runtime check and the static type therefore cannot diverge.
 *
 * The DTOs covered here are the ones the web app actually consumes. This is a
 * floor to build on, not a claim of total coverage — see `assertedDtoCoverage`
 * at the bottom.
 */

// ── Compile-time type equality ───────────────────────────────────────────────
// The `<T>() => T extends X ? 1 : 2` trick compares types *invariantly*, so it
// catches a widened or narrowed field that a plain `extends` check would let by.
type Equal<X, Y> =
  (<T>() => T extends X ? 1 : 2) extends <T>() => T extends Y ? 1 : 2
    ? true
    : false;
type Expect<T extends true> = T;

/**
 * zod marks an object key optional in its inferred type whenever `undefined`
 * is assignable to the field — and it is for `unknown`. So a DTO field declared
 * `input: unknown` (required) can never be produced by inference; zod always
 * yields `input?: unknown`.
 *
 * That is a limitation of the type system, not a real contract difference: a
 * field typed `unknown` already permits `undefined`, so "required `unknown`"
 * and "optional `unknown`" describe the same set of values. This helper marks
 * exactly those keys so the remaining fields are still compared strictly,
 * rather than weakening the whole assertion to make three DTOs pass.
 */
type Simplify<T> = { [K in keyof T]: T[K] };
type UnknownKeysOptional<T, K extends keyof T> = Simplify<
  Omit<T, K> & Partial<Pick<T, K>>
>;

// ── Shared leaves ────────────────────────────────────────────────────────────
const isoString = z.string();
const jsonRecord = z.record(z.string(), z.unknown());

/**
 * The three nested types below already have request schemas. Reuse them for the
 * real runtime check, then re-type to the published interface: the schema and
 * the interface are independent hand-written definitions in this codebase, so
 * their inferred shapes are structurally equal but not referentially identical.
 * The cast keeps runtime validation genuine while letting the `Expect<Equal<>>`
 * assertions below stay exact.
 */
const definitionSchema =
  workflowDefinitionSchema as unknown as z.ZodType<WorkflowDefinition>;
const triggerCfgSchema =
  triggerConfigSchema as unknown as z.ZodType<TriggerConfig>;
const kpiSchema = kpiTargetsSchema as unknown as z.ZodType<KpiTargets>;

// ── Tenant ───────────────────────────────────────────────────────────────────
export const userDtoSchema = z.object({
  id: z.string(),
  companyId: z.string(),
  email: z.string(),
  name: z.string(),
  phone: z.string().nullable(),
  role: z.enum(['OWNER', 'ADMIN', 'MEMBER']),
  status: z.enum(['ACTIVE', 'DISABLED']),
  emailVerified: z.boolean(),
  departmentId: z.string().nullable(),
  teamId: z.string().nullable(),
  managerUserId: z.string().nullable(),
  createdAt: isoString,
});
export type _AssertUserDto = Expect<
  Equal<z.infer<typeof userDtoSchema>, UserDto>
>;

export const companyDtoSchema = z.object({
  id: z.string(),
  name: z.string(),
  slug: z.string(),
  industry: z.string().nullable(),
  size: z.string().nullable(),
  country: z.string().nullable(),
  timezone: z.string().nullable(),
  website: z.string().nullable(),
  logoUrl: z.string().nullable(),
  description: z.string().nullable(),
  onboardedAt: isoString.nullable(),
  createdAt: isoString,
});
export type _AssertCompanyDto = Expect<
  Equal<z.infer<typeof companyDtoSchema>, CompanyDto>
>;

// ── AI employees ─────────────────────────────────────────────────────────────
export const aiEmployeeDtoSchema = z.object({
  id: z.string(),
  companyId: z.string(),
  name: z.string(),
  // MARKETING must be present here — it is the value gap G10 added, and the
  // whole point of this suite is that the API's real output proves it.
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
  status: z.enum(['ACTIVE', 'PAUSED', 'DISABLED']),
  persona: z.string().nullable(),
  model: z.string().nullable(),
  department: z.string().nullable(),
  managerName: z.string().nullable(),
  workingHoursStart: z.string().nullable(),
  workingHoursEnd: z.string().nullable(),
  timezone: z.string().nullable(),
  language: z.string().nullable(),
  knowledgeAccess: z.enum(['ALL', 'NONE']),
  budgetLimit: z.number().nullable(),
  monthToDateCostUsd: z.number().nullable(),
  maxCreditsPerExecution: z.number().nullable(),
  maxCreditsPerTask: z.number().nullable(),
  // Phase 1 safety fix — these were open records, so the response contract
  // could not tell a caller which flags actually mean anything. Now the exact
  // enforced shape.
  permissions: z
    .object({
      sendEmail: z.boolean().optional(),
      contactCustomers: z.boolean().optional(),
      makePayments: z.boolean().optional(),
      accessKnowledge: z.boolean().optional(),
    })
    .nullable(),
  approvalRules: z
    .object({
      requireApprovalForAllTools: z.boolean().optional(),
      requireApprovalForTools: z.array(z.string()).optional(),
      approveExternalMessages: z.boolean().optional(),
      routing: z.custom<ApprovalRoutingConfig>().optional(),
    })
    .nullable(),
  goals: z.array(z.string()).nullable(),
  kpiTargets: kpiSchema.nullable(),
  archivedAt: isoString.nullable(),
  createdAt: isoString,
});
export type _AssertAiEmployeeDto = Expect<
  Equal<z.infer<typeof aiEmployeeDtoSchema>, AiEmployeeDto>
>;

// ── Knowledge ────────────────────────────────────────────────────────────────
export const knowledgeDocumentDtoSchema = z.object({
  id: z.string(),
  companyId: z.string(),
  filename: z.string(),
  mimeType: z.string(),
  sizeBytes: z.number(),
  status: z.enum(['PENDING', 'PROCESSING', 'READY', 'FAILED']),
  error: z.string().nullable(),
  chunkCount: z.number(),
  createdAt: isoString,
  category: z
    .enum([
      'SUPPORT',
      'SALES',
      'RECRUITER',
      'HR',
      'ACCOUNTANT',
      'PROJECT_MANAGER',
      'CUSTOM',
      'MARKETING',
    ])
    .nullable(),
});
export type _AssertKnowledgeDocumentDto = Expect<
  Equal<z.infer<typeof knowledgeDocumentDtoSchema>, KnowledgeDocumentDto>
>;

// ── Workflows ────────────────────────────────────────────────────────────────
export const workflowDtoSchema = z.object({
  id: z.string(),
  companyId: z.string(),
  name: z.string(),
  description: z.string().nullable(),
  // ARCHIVED is the G29 soft-delete state. Its presence here is what stops a
  // future refactor from quietly dropping it from the published contract.
  status: z.enum(['DRAFT', 'ACTIVE', 'PAUSED', 'ARCHIVED']),
  definition: definitionSchema,
  triggerType: z.enum(['MANUAL', 'SCHEDULE', 'WEBHOOK', 'EVENT']),
  triggerConfig: triggerCfgSchema.nullable(),
  webhookToken: z.string().nullable(),
  activatedAt: isoString.nullable(),
  createdAt: isoString,
  updatedAt: isoString,
  ownerUserId: z.string().nullable(),
  activeVersionId: z.string().nullable(),
  draftVersionId: z.string().nullable(),
  category: z
    .enum([
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
    ])
    .nullable(),
  warnings: z.array(z.string()),
});
export type _AssertWorkflowDto = Expect<
  Equal<z.infer<typeof workflowDtoSchema>, WorkflowDto>
>;

export const workflowStepRunDtoSchema = z.object({
  id: z.string(),
  companyId: z.string(),
  runId: z.string(),
  nodeId: z.string(),
  // Deliberately a free string, not an enum: the node registry is code-defined,
  // so adding a node type must not require a schema change here.
  type: z.string(),
  status: z.enum([
    'PENDING',
    'RUNNING',
    'COMPLETED',
    'FAILED',
    'SKIPPED',
    'RETRYING',
    'WAITING',
    'COMPENSATED',
  ]),
  attempt: z.number(),
  input: z.unknown(),
  output: z.unknown(),
  error: z.string().nullable(),
  startedAt: isoString.nullable(),
  finishedAt: isoString.nullable(),
  createdAt: isoString,
  creditsCharged: z.number().nullable(),
});
export type _AssertWorkflowStepRunDto = Expect<
  Equal<
    z.infer<typeof workflowStepRunDtoSchema>,
    UnknownKeysOptional<WorkflowStepRunDto, 'input' | 'output'>
  >
>;

export const workflowRunDtoSchema = z.object({
  id: z.string(),
  companyId: z.string(),
  workflowId: z.string(),
  workflowName: z.string().optional(),
  status: z.enum([
    'PENDING',
    'RUNNING',
    'WAITING',
    'COMPLETED',
    'FAILED',
    'CANCELLED',
    'COMPENSATING',
    'TIMED_OUT',
  ]),
  source: z.string(),
  dryRun: z.boolean(),
  trigger: jsonRecord.nullable(),
  context: jsonRecord.nullable(),
  triggerEventId: z.string().nullable(),
  correlationId: z.string().nullable(),
  error: z.string().nullable(),
  failureClass: z.string().nullable(),
  resumeNodeId: z.string().nullable(),
  startedByUserId: z.string().nullable(),
  workflowVersionId: z.string().nullable(),
  startedAt: isoString.nullable(),
  finishedAt: isoString.nullable(),
  createdAt: isoString,
  creditLimit: z.number().nullable(),
  totalCreditsCharged: z.number(),
  steps: z.array(workflowStepRunDtoSchema).optional(),
});
export type _AssertWorkflowRunDto = Expect<
  Equal<
    z.infer<typeof workflowRunDtoSchema>,
    Simplify<
      Omit<WorkflowRunDto, 'steps'> & {
        steps?: UnknownKeysOptional<WorkflowStepRunDto, 'input' | 'output'>[];
      }
    >
  >
>;

// ── Approvals ────────────────────────────────────────────────────────────────
export const approvalRequestDtoSchema = z.object({
  id: z.string(),
  companyId: z.string(),
  kind: z.enum(['TOOL', 'WORKFLOW']),
  employeeId: z.string().nullable(),
  conversationId: z.string().nullable(),
  workflowRunId: z.string().nullable(),
  skillKey: z.string().nullable(),
  tool: z.string().nullable(),
  args: jsonRecord,
  result: z.unknown(),
  description: z.string().nullable(),
  status: z.enum(['PENDING', 'APPROVED', 'REJECTED', 'ESCALATED', 'EXPIRED']),
  decidedById: z.string().nullable(),
  decidedAt: isoString.nullable(),
  note: z.string().nullable(),
  createdAt: isoString,
  // P3-05 §8.1 routing fields (routingSnapshot excluded — internal only).
  chainId: z.string(),
  level: z.number(),
  escalationTier: z.number(),
  assigneeUserId: z.string().nullable(),
  approverRuleType: z
    .enum(['USER', 'ROLE', 'DEPARTMENT', 'TEAM', 'EMPLOYEE_MANAGER', 'ANY_ADMIN'])
    .nullable(),
  approverRuleValue: z.string().nullable(),
  dueAt: isoString.nullable(),
  slaMinutes: z.number().nullable(),
  timeoutPolicy: z.string().nullable(),
  autoDecided: z.boolean(),
  escalatedToId: z.string().nullable(),
});
export type _AssertApprovalRequestDto = Expect<
  Equal<
    z.infer<typeof approvalRequestDtoSchema>,
    UnknownKeysOptional<ApprovalRequestDto, 'result'>
  >
>;

// ── Audit ────────────────────────────────────────────────────────────────────
export const auditLogDtoSchema = z.object({
  id: z.string(),
  companyId: z.string(),
  actorUserId: z.string().nullable(),
  actorName: z.string().nullable(),
  action: z.string(),
  entityType: z.string(),
  entityId: z.string().nullable(),
  metadata: jsonRecord.nullable(),
  createdAt: isoString,
});
export type _AssertAuditLogDto = Expect<
  Equal<z.infer<typeof auditLogDtoSchema>, AuditLogDto>
>;

/**
 * Which published DTOs currently have a response schema. Kept explicit so the
 * gap is visible rather than implied — `@vaep/types` exports 62 `*Dto` types
 * and the ones below are the subset the web app depends on today.
 */
export const assertedDtoCoverage = [
  'UserDto',
  'CompanyDto',
  'AiEmployeeDto',
  'KnowledgeDocumentDto',
  'WorkflowDto',
  'WorkflowStepRunDto',
  'WorkflowRunDto',
  'ApprovalRequestDto',
  'AuditLogDto',
  'AssistMessageDto',
  'AssistSessionSummaryDto',
  'AssistSessionDto',
  'AssistSuggestionDto',
] as const;

// ── Orlixa AI Assist (doc 30) ────────────────────────────────────────────────

const assistMessageRoleSchema = z.enum([
  'USER',
  'ASSISTANT',
  'QUESTION',
  'ANSWER',
  'CONNECTION',
  'TEST',
  'SYSTEM',
]);

export const assistMessageDtoSchema = z.object({
  id: z.string(),
  sessionId: z.string(),
  role: assistMessageRoleSchema,
  content: z.string(),
  metadata: z.record(z.unknown()).nullable().optional(),
  createdAt: z.string(),
});
export type _AssertAssistMessageDto = Expect<
  Equal<z.infer<typeof assistMessageDtoSchema>, AssistMessageDto>
>;

const assistSessionSummaryShape = {
  id: z.string(),
  title: z.string(),
  status: z.enum(['ACTIVE', 'COMPLETED', 'EXHAUSTED', 'ARCHIVED']),
  targetWorkflowId: z.string().nullable(),
  createdWorkflowId: z.string().nullable(),
  draftNodeCount: z.number(),
  updatedAt: z.string(),
  createdAt: z.string(),
};

export const assistSessionSummaryDtoSchema = z.object(assistSessionSummaryShape);
export type _AssertAssistSessionSummaryDto = Expect<
  Equal<z.infer<typeof assistSessionSummaryDtoSchema>, AssistSessionSummaryDto>
>;

export const assistSessionDtoSchema = z.object({
  ...assistSessionSummaryShape,
  draftDefinition: workflowDefinitionSchema.nullable(),
  draftVersion: z.number(),
  originRunId: z.string().nullable(),
  promptTokens: z.number(),
  completionTokens: z.number(),
  messages: z.array(assistMessageDtoSchema),
});
export type _AssertAssistSessionDto = Expect<
  Equal<z.infer<typeof assistSessionDtoSchema>, AssistSessionDto>
>;

export const assistSuggestionDtoSchema = z.object({
  id: z.string(),
  label: z.string(),
  prompt: z.string(),
});
export type _AssertAssistSuggestionDto = Expect<
  Equal<z.infer<typeof assistSuggestionDtoSchema>, AssistSuggestionDto>
>;
