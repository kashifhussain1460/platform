import type { EmployeeRole } from '@vaep/types';

/**
 * Shared constants for the AI employee runtime. The prompt markers below are the
 * contract between AgentRuntimeService (which builds prompts) and the
 * MockLlmProvider (which produces deterministic output from them) — keeping them
 * here means there is a single source of truth for both sides.
 */

/** Marker placed in a system prompt to ask the LLM for a numbered step plan. */
export const PLAN_PROMPT_MARKER = '[[VAEP:PLAN]]';

/** Delimiters wrapping the retrieved-knowledge block in the ACT system prompt. */
export const CONTEXT_OPEN = '<<<VAEP_CONTEXT';
export const CONTEXT_CLOSE = 'VAEP_CONTEXT>>>';

/**
 * Prefix the runtime uses when it appends a tool RESULT back into the working
 * messages during the act loop. The MockLlmProvider keys off this marker to know
 * a tool has already run (→ produce a final grounded answer instead of another
 * tool call). Shared here so both sides agree on the contract.
 */
export const TOOL_RESULT_MARKER = '[[VAEP:TOOL_RESULT]]';

/** Hard cap on act-loop iterations (tool calls) per turn, to keep runs bounded. */
export const MAX_ACT_ITERATIONS = 3;

/** How many recent conversation messages the MemoryService loads for context. */
export const RECENT_MESSAGE_LIMIT = 10;

/** How many recent employee memories to recall (by recency). */
export const RECENT_MEMORY_LIMIT = 5;

/** Default number of knowledge chunks retrieved per run. */
export const RETRIEVAL_K = 5;

/** Confidence at/above which an answer does not, by itself, need approval. */
export const APPROVAL_CONFIDENCE_THRESHOLD = 0.5;

/**
 * Roles whose actions are sensitive enough that a run is always flagged for
 * human approval (regardless of confidence).
 */
export const HIGH_STAKES_ROLES: readonly EmployeeRole[] = ['ACCOUNTANT', 'HR'];

/**
 * One-line job scope per role, injected into the system prompt (docs on
 * buildSystemPrompt) so an employee stays in its lane — e.g. a SUPPORT hire
 * should decline recruiting/HR work rather than drift into it just because a
 * user asked. This is a prompt-level guardrail (no schema/tool restriction);
 * mirrors the onboarding catalog's role descriptions in spirit, kept local so
 * the employees module doesn't reach into the onboarding module's files.
 */
export const ROLE_SCOPE: Record<EmployeeRole, string> = {
  SUPPORT: 'resolving customer questions grounded in company knowledge, and escalating what you cannot resolve',
  SALES: 'qualifying leads, answering product questions, and following up to move deals forward',
  RECRUITER: 'sourcing/screening candidates, scoring CVs against hiring policy, and scheduling interviews',
  HR: 'answering policy questions and supporting onboarding/day-to-day people ops',
  ACCOUNTANT: 'bookkeeping questions, expense checks, and finance-related requests',
  PROJECT_MANAGER: 'coordinating tasks, chasing status updates, and keeping projects on track',
  MARKETING:
    'planning campaigns, drafting on-brand content for review, scheduling and publishing approved posts, and reporting on performance',
  CUSTOM: 'the tasks described in your persona below',
};
