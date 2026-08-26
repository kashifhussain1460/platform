/** Env vars for the shared self-hosted Postiz instance (one per Orlixa deployment, not per company). */
export const POSTIZ_ENV = {
  BASE_URL: 'POSTIZ_BASE_URL',
  API_KEY: 'POSTIZ_API_KEY',
} as const;

/**
 * C-07 / M-07 / C-10: Postiz is ONE shared instance for every Orlixa company
 * (see PostizClientService's own doc comment), so its circuit breaker AND
 * rate limit must use a single GLOBAL resource key, never a per-company one
 * — a per-company key would let N tenants each independently retry a
 * genuinely-down instance, and would let N tenants collectively exceed
 * Postiz's real cap while each individually stays under its own budget
 * (the exact M-07/C-10 finding). Absorbed into the resilience-wiring fix
 * rather than built as a second rate-limiting mechanism.
 */
export const POSTIZ_RESOURCE_KEY = 'engine:postiz';
/** Postiz's real, documented rate cap (docs/architecture/engines/postiz-engine.md). */
export const POSTIZ_RATE_LIMIT = 90;
export const POSTIZ_RATE_WINDOW_MS = 60 * 60_000;

/** BullMQ queue names (Phase 0 §4/§5). */
export const MARKETING_SYNC_QUEUE = 'marketing-sync';
export const MARKETING_SYNC_JOB = 'marketing-sync-sweep';
export const MARKETING_SYNC_SCHEDULER = 'marketing-sync';
export const MARKETING_SYNC_EVERY_MS = 10 * 60_000;
