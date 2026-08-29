/** BullMQ queue that drives Marketing AI campaign generation. */
export const CAMPAIGN_GENERATION_QUEUE = 'campaign-generation';

/** Job enqueued once per campaign when generation starts. */
export const CAMPAIGN_GENERATION_JOB = 'campaign-generation-advance';

/**
 * Repeatable sweep interval for worker deployments.
 *
 * One minute rather than five: generation is work a human is actively waiting
 * on (§75 shows a live progress screen), so a slow tick is felt directly —
 * unlike the reconciliation sweeps, where nobody is watching.
 */
export const CAMPAIGN_GENERATION_SCHEDULER = 'campaign-generation';
export const CAMPAIGN_GENERATION_EVERY_MS = 60_000;
