import type { NormalizedApiError } from './apiClient';

/**
 * Detects Layer 1 (company-balance) enforcement blocks (§45/Task 8.3) from an
 * HTTP error. Chat/AI_STEP surface this as a 409 with a fixed message (see
 * `agent-runtime.service.ts`'s literal string) — there is no structured
 * `failureClass` field on this response the way a `WorkflowRunDto` carries
 * one for a workflow run, so the message text is the only signal available
 * on this path.
 */
export function isCreditExhaustedError(
  error: NormalizedApiError | null | undefined,
): boolean {
  if (!error || error.status !== 409) return false;
  return /run out of credits/i.test(error.message);
}
