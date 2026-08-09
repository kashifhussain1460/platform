export const CHATWOOT_ENV = {
  BASE_URL: 'CHATWOOT_BASE_URL',
  PLATFORM_API_TOKEN: 'CHATWOOT_PLATFORM_API_TOKEN',
} as const;

// Confirmed directly from the real Chatwoot source
// (`lib/webhooks/trigger.rb#request_headers`, the `:agent_bot_webhook` path):
// headers are lowercased by Express/Node on receipt regardless of the casing
// Chatwoot sends them in.
export const CHATWOOT_SIGNATURE_HEADER = 'x-chatwoot-signature';
export const CHATWOOT_TIMESTAMP_HEADER = 'x-chatwoot-timestamp';

// Reject a signature whose timestamp is more than this far from "now" (either
// direction) — Chatwoot's own scheme has no built-in expiry; this closes a
// trivial replay hole for a captured request at negligible cost.
export const SIGNATURE_MAX_AGE_MS = 5 * 60_000;

/**
 * RESERVED, NOT WIRED. There is deliberately no `BullModule.registerQueue` and
 * no `@Processor` for this queue — support stays webhook-driven, so no polling
 * sweep was built. Nothing enqueues to it and nothing consumes it.
 *
 * Kept only to reserve the name. If you wire a processor, you must ALSO add
 * this to `DLQ_KNOWN_QUEUES` (`common/resilience/dlq.constants.ts`) or its
 * poison jobs will be invisible to `/admin/dlq` — exactly the bug that left
 * `gmail-inbound` and `marketing-sync` unmonitored.
 */
export const SUPPORT_SYNC_QUEUE = 'support-sync';
export const SUPPORT_SYNC_JOB = 'support-sync-sweep';
export const SUPPORT_SYNC_SCHEDULER = 'support-sync';
export const SUPPORT_SYNC_EVERY_MS = 10 * 60_000;
