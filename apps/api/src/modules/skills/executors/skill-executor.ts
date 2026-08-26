/**
 * Swappable skill-execution backend (mirrors the knowledge EmbeddingProvider and
 * employees LlmProvider patterns). The active implementation is provided as a
 * singleton under SKILL_EXECUTOR_TOKEN. The default (`mock`) is deterministic,
 * offline and side-effect-free so tools are safe to run with no credentials.
 */
import type { SkillConnectionStatus } from '@vaep/types';

/** Who/what a tool is executed for — carried into the audit log. */
export interface ExecutorContext {
  companyId: string;
  employeeId?: string | null;
  conversationId?: string | null;
  /**
   * Credit system Phase 3, Task 3.5. Present only for a TOOL_ACTION workflow
   * node — reservation keying prefers `workflowStepRunId` when set (§40.8:
   * dedupes retries of the same step, the same reasoning as AI_STEP's and
   * AI_EMPLOYEE_STEP's reservation keying).
   */
  workflowRunId?: string | null;
  workflowStepRunId?: string | null;
  /**
   * Connection details of the tenant's installed skill, RESOLVED lazily by
   * SkillsService.runTool ONLY for executors that set `usesInstalledCredentials`
   * (real/auto). These stay in-memory (never logged — the audit row records
   * args/result, not ctx) and let a real executor reach the live backend.
   */
  installedSkillId?: string | null;
  connectionStatus?: SkillConnectionStatus | null;
  /** Non-secret company-specific settings (InstalledSkill.config). */
  config?: Record<string, unknown> | null;
  /** DECRYPTED credentials for the installed skill (api keys / OAuth tokens). */
  credentials?: Record<string, unknown> | null;
  /**
   * Raw secret VALUES resolved from `{{secret.X}}` refs by a workflow node
   * before the call. Passed so runTool can scrub them (plus the connector's own
   * credential values) out of the persisted error/result — a provider echoing a
   * rejected token must not land in SkillExecution or a run log (doc 06 §6.2.10).
   */
  secretValues?: string[];
  /**
   * Phase 8 (Enforcement), Task 8.5. Present only for a TOOL_ACTION workflow
   * node (chat/manual calls have no `WorkflowStepAttempt`, so nothing to key
   * on here — see `SkillExecutor.supportsIdempotencyKey`'s doc for why this
   * is provider-side dedup, not the credit-side settle-once guarantee).
   */
  attemptIdempotencyKey?: string;
}

/** Outcome of executing a single tool. */
export interface SkillExecutionResult {
  ok: boolean;
  result?: unknown;
  error?: string;
}

export interface SkillExecutor {
  /** Stable id of the backend (e.g. `mock`). */
  readonly name: string;
  /**
   * When true, SkillsService resolves the tenant's InstalledSkill (credentials +
   * config + connectionStatus) into the ExecutorContext BEFORE calling execute().
   * The mock executor leaves this falsy so its (unchanged) path does no extra
   * DB work; real/auto set it true.
   */
  readonly usesInstalledCredentials?: boolean;
  /**
   * Phase 8 (Enforcement), Task 8.5 (§14.4) — true when this executor
   * actually forwards `ExecutorContext.attemptIdempotencyKey` to the
   * PROVIDER (e.g. a Stripe-style `Idempotency-Key` header) so a retried
   * attempt cannot re-issue an already-completed side effect at the
   * provider itself. Defaults falsy — every executor in this codebase today
   * (mock/real/auto) is `false`: none has real provider-side idempotency
   * support yet. That gap is deliberately visible here, not hidden behind a
   * silent "solved" claim — Task 3.6's settle-once guarantee is what
   * actually protects the credit ledger from a resulting double-charge;
   * this flag is about the EXTERNAL side effect (e.g. a duplicate email),
   * which only a capable executor can prevent.
   */
  readonly supportsIdempotencyKey?: boolean;
  /** Execute `tool` of `skillKey` with `args`. Must not throw for tool-level failures. */
  execute(
    skillKey: string,
    tool: string,
    args: Record<string, unknown>,
    ctx: ExecutorContext,
  ): Promise<SkillExecutionResult>;
}

/** DI token for the active SkillExecutor implementation. */
export const SKILL_EXECUTOR_TOKEN = Symbol('SKILL_EXECUTOR_TOKEN');
