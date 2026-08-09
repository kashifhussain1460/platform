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
