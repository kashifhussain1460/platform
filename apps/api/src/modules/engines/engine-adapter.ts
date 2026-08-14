/**
 * §39 Refactor Group D — the connector contract every engine must expose.
 *
 * Before this, Postiz, Chatwoot and Plane each grew their own method names for
 * the same seven jobs (`getConnectUrl` vs `provisionAccount` vs
 * `provisionWorkspace`; `listIntegrations` vs nothing). Nothing was *wrong* —
 * but there was no contract, so "what must a new engine implement?" could only
 * be answered by reading three services and guessing which parts were essential.
 * §39 exists so the next engine is cheap, and the plan puts it BEFORE the
 * unfreeze for that reason.
 *
 * ## This is a contract, not a rewrite
 *
 * Each adapter is a thin delegation to the client service that already exists.
 * Credentials, tenant scope, audit, health, retry and rate limiting stay where
 * they are — in `SkillsService`, `ConnectorHealthService` and the resilience
 * layer. An adapter that re-implemented any of those would be the "second
 * system" §55 forbids.
 *
 * ## Capabilities are declared, not assumed
 *
 * `capabilities()` is the honest half. An engine that cannot provision an
 * account says so, and `connect()` throws with the reason rather than returning
 * a cheerful success — the same discipline `provisionAccount` already applies.
 * A caller can therefore ask what an engine supports instead of calling and
 * hoping.
 */

export type EngineCapability =
  | 'connect'
  | 'disconnect'
  | 'healthCheck'
  | 'refresh'
  | 'reconcile'
  | 'handleWebhook';

export interface EngineHealth {
  ok: boolean;
  /** Why not. Never a bare false. */
  detail?: string;
}

export interface EngineWebhookResult {
  /** False when the signature did not verify — the caller must return 401. */
  verified: boolean;
  /** True when this delivery had already been ingested. */
  deduped?: boolean;
  rawEventId?: string;
}

/**
 * One integration, from the platform's point of view.
 *
 * Every method takes `companyId` first: there is no engine operation that is not
 * tenant-scoped, and making it the first argument means a caller cannot forget
 * it the way an options bag allows.
 */
export interface EngineAdapter {
  /** Stable key, matching the skill/connector key (`postiz`, `chatwoot`, `plane`). */
  readonly engineKey: string;

  /** What this adapter can actually do. Callers should check before calling. */
  capabilities(): readonly EngineCapability[];

  /** Begin or complete a connection for this tenant. */
  connect(companyId: string, input?: Record<string, unknown>): Promise<unknown>;

  /** Revoke this tenant's connection. Must be safe to call when not connected. */
  disconnect(companyId: string): Promise<void>;

  /** Cheap liveness probe against the provider. Must not mutate anything. */
  healthCheck(companyId: string): Promise<EngineHealth>;

  /** Refresh credentials. A no-op for engines whose credentials do not expire. */
  refresh(companyId: string): Promise<void>;

  /**
   * The tools this engine owns, as `skillKey.tool` keys.
   *
   * ## Why this is a declaration and not an `execute()` method
   *
   * §39 lists `execute()` on the connector contract, and §38 requires ONE tool
   * execution path — `ToolExecutor` → authorization → approval → idempotency →
   * credentials → provider → audit → metrics. Those two cannot both be taken
   * literally: giving each adapter its own `execute()` creates a second way to
   * reach a provider, one that skips the approval gate. That is the "second
   * system" §55 forbids, and it is the exact shape of the G25 bypass that had to
   * be closed twice already.
   *
   * Resolved in favour of §38 and §55: an engine declares WHICH tools it owns,
   * and execution stays in `SkillsService.runTool`. The contract still answers
   * "how do I run something on this engine?" — the answer is just "through the
   * one executor", which is the answer §38 wants.
   */
  tools(): readonly string[];

  /** Re-derive local state from the provider's, which is the source of truth. */
  reconcile(companyId: string): Promise<{ checked: number; updated: number }>;

  /** Verify + ingest an inbound delivery through the canonical pipeline. */
  handleWebhook(input: {
    rawBody: Buffer;
    headers: Record<string, string | undefined>;
  }): Promise<EngineWebhookResult>;
}

/** Thrown by a method an engine genuinely cannot perform. */
export class EngineCapabilityUnsupportedError extends Error {
  constructor(engineKey: string, capability: EngineCapability, why: string) {
    super(`${engineKey} does not support ${capability}: ${why}`);
    this.name = 'EngineCapabilityUnsupportedError';
  }
}

/** Every method the contract requires — used by the contract test. */
export const ENGINE_ADAPTER_METHODS: readonly (keyof EngineAdapter)[] = [
  'capabilities',
  'connect',
  'disconnect',
  'healthCheck',
  'refresh',
  'tools',
  'reconcile',
  'handleWebhook',
];
