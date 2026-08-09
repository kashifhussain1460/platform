import type { AssistMessage, AssistSession } from '@prisma/client';
import type {
  AssistMessageDto,
  AssistSessionDto,
  AssistSessionSummaryDto,
  WorkflowDefinition,
} from '@vaep/types';

/**
 * Prisma rows → published DTOs. Kept as pure functions (no injection) so the
 * shape is unit-testable and the controller stays thin, matching every other
 * `*.mapper.ts` in this codebase.
 */

function nodeCount(definition: unknown): number {
  const nodes = (definition as WorkflowDefinition | null)?.nodes;
  return Array.isArray(nodes) ? nodes.length : 0;
}

export function toAssistMessageDto(row: AssistMessage): AssistMessageDto {
  return {
    id: row.id,
    sessionId: row.sessionId,
    role: row.role,
    content: row.content,
    metadata: (row.metadata as Record<string, unknown> | null) ?? null,
    createdAt: row.createdAt.toISOString(),
  };
}

export function toAssistSessionSummaryDto(
  row: AssistSession,
): AssistSessionSummaryDto {
  return {
    id: row.id,
    title: row.title,
    status: row.status,
    targetWorkflowId: row.targetWorkflowId,
    createdWorkflowId: row.createdWorkflowId,
    // The list shows "4 steps so far" without shipping the whole graph to a
    // page that only renders a row.
    draftNodeCount: nodeCount(row.draftDefinition),
    updatedAt: row.updatedAt.toISOString(),
    createdAt: row.createdAt.toISOString(),
  };
}

export function toAssistSessionDto(
  row: AssistSession & { messages?: AssistMessage[] },
): AssistSessionDto {
  return {
    ...toAssistSessionSummaryDto(row),
    draftDefinition: (row.draftDefinition as WorkflowDefinition | null) ?? null,
    draftVersion: row.draftVersion,
    originRunId: row.originRunId,
    promptTokens: row.promptTokens,
    completionTokens: row.completionTokens,
    messages: (row.messages ?? []).map(toAssistMessageDto),
  };
}
