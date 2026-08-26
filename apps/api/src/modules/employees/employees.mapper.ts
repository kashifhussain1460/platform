import type {
  AiEmployee,
  Conversation,
  EmployeeFeedback,
  EmployeeMemory,
  Message,
} from '@prisma/client';
import type {
  AiEmployeeDto,
  ApprovalRules,
  ConversationDto,
  EmployeeFeedbackDto,
  EmployeeMemoryDto,
  EmployeePermissions,
  KpiTargets,
  MemorySource,
  MessageDto,
  MessageMetadataDto,
} from '@vaep/types';
import { EMPLOYEE_PERMISSION_KEYS } from '@vaep/types';

/** Prisma row → public DTO mappers (shared by the service + runtime). */

/**
 * `monthToDateCostUsd` requires an async aggregate query, so it's an OPTIONAL
 * second arg the caller computes itself -- passed on the single-employee
 * `get()` path only, left null on list()/create()/update() to avoid an N+1
 * aggregate per employee on a list view.
 */
export function toEmployeeDto(
  e: AiEmployee,
  monthToDateCostUsd: number | null = null,
): AiEmployeeDto {
  return {
    id: e.id,
    companyId: e.companyId,
    name: e.name,
    role: e.role,
    status: e.status,
    persona: e.persona,
    model: e.model,
    department: e.department,
    managerName: e.managerName,
    workingHoursStart: e.workingHoursStart,
    workingHoursEnd: e.workingHoursEnd,
    timezone: e.timezone,
    language: e.language,
    knowledgeAccess: e.knowledgeAccess,
    budgetLimit: e.budgetLimit,
    monthToDateCostUsd,
    maxCreditsPerExecution: e.maxCreditsPerExecution,
    maxCreditsPerTask: e.maxCreditsPerTask,
    // Projected through the enforced shapes rather than echoed as open
    // records: a flag the response advertises is now a flag the runtime reads.
    permissions: toEmployeePermissions(e.permissions),
    approvalRules: toApprovalRules(e.approvalRules),
    goals: (e.goals as string[] | null) ?? null,
    kpiTargets: (e.kpiTargets as KpiTargets | null) ?? null,
    archivedAt: e.archivedAt ? e.archivedAt.toISOString() : null,
    createdAt: e.createdAt.toISOString(),
  };
}

/**
 * Narrow the stored JSON to the four ENFORCED permission keys.
 *
 * A total, key-by-key projection rather than a cast — a cast would happily
 * re-publish `approveOverBudget`-style legacy junk as though it meant
 * something, which is the exact defect this phase exists to remove (and the
 * `cast-is-not-a-conversion` lesson from the AI Assist workspace outage).
 */
function toEmployeePermissions(
  value: AiEmployee['permissions'],
): EmployeePermissions | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const raw = value as Record<string, unknown>;
  const out: EmployeePermissions = {};
  for (const key of EMPLOYEE_PERMISSION_KEYS) {
    if (typeof raw[key] === 'boolean') out[key] = raw[key] as boolean;
  }
  return out;
}

/** Same treatment for approval rules: publish only what a policy actually reads. */
function toApprovalRules(value: AiEmployee['approvalRules']): ApprovalRules | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const raw = value as Record<string, unknown>;
  const out: ApprovalRules = {};
  if (typeof raw.requireApprovalForAllTools === 'boolean') {
    out.requireApprovalForAllTools = raw.requireApprovalForAllTools;
  }
  if (Array.isArray(raw.requireApprovalForTools)) {
    out.requireApprovalForTools = raw.requireApprovalForTools.filter(
      (t): t is string => typeof t === 'string',
    );
  }
  if (typeof raw.approveExternalMessages === 'boolean') {
    out.approveExternalMessages = raw.approveExternalMessages;
  }
  if (raw.routing && typeof raw.routing === 'object') {
    out.routing = raw.routing as ApprovalRules['routing'];
  }
  return out;
}

export function toConversationDto(c: Conversation): ConversationDto {
  return {
    id: c.id,
    companyId: c.companyId,
    employeeId: c.employeeId,
    title: c.title,
    createdAt: c.createdAt.toISOString(),
  };
}

export function toMessageDto(m: Message): MessageDto {
  return {
    id: m.id,
    companyId: m.companyId,
    conversationId: m.conversationId,
    role: m.role,
    content: m.content,
    metadata: (m.metadata as unknown as MessageMetadataDto | null) ?? null,
    createdAt: m.createdAt.toISOString(),
  };
}

export function toFeedbackDto(f: EmployeeFeedback): EmployeeFeedbackDto {
  return {
    id: f.id,
    companyId: f.companyId,
    employeeId: f.employeeId,
    conversationId: f.conversationId,
    messageId: f.messageId,
    rating: f.rating,
    note: f.note,
    correction: f.correction,
    createdAt: f.createdAt.toISOString(),
  };
}

export function toMemoryDto(m: EmployeeMemory): EmployeeMemoryDto {
  return {
    id: m.id,
    companyId: m.companyId,
    employeeId: m.employeeId,
    kind: m.kind,
    content: m.content,
    source: (m.source as MemorySource | null) ?? null,
    createdAt: m.createdAt.toISOString(),
  };
}
