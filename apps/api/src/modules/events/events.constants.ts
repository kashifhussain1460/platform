/**
 * Name of the BullMQ queue that drives async event NORMALIZATION. The ingestion
 * edge enqueues one job per persisted RawEvent and returns immediately; the
 * in-process EventNormalizeProcessor (a WorkerHost, mirroring the knowledge
 * IngestionProcessor) dequeues it, maps raw → canonical, and fires workflows.
 */
export const EVENT_NORMALIZE_QUEUE = 'event-normalize';

/** Job name enqueued for each RawEvent awaiting normalization. */
export const EVENT_NORMALIZE_JOB = 'normalize';

/** Payload of an event-normalize job. `companyId` scopes the DLQ view (Unit C). */
export interface NormalizeJobData {
  rawEventId: string;
  companyId?: string;
}

/** Default + max number of rows the observability endpoints return. */
export const DEFAULT_EVENTS_LIMIT = 50;
export const MAX_EVENTS_LIMIT = 100;

// --- Reconciliation sweep (Unit B, docs §2.3) -------------------------------
// The belt-and-suspenders for missed webhooks: a low-frequency, cursor-based
// catch-up poll per connector. A BullMQ repeatable drives the sweep. Real
// per-provider polling is [TARGET] (needs live creds), so the sweep is a safe
// no-op offline (SKILL_EXECUTOR=mock).

/** Queue that drives the periodic connector reconciliation sweep. */
export const CONNECTOR_RECONCILE_QUEUE = 'connector-reconcile';

/** Repeatable job name for the reconciliation sweep. */
export const CONNECTOR_RECONCILE_JOB = 'connector-reconcile-sweep';

/** Job-scheduler id (idempotent upsert, like the workflow SCHEDULE repeatables). */
export const CONNECTOR_RECONCILE_SCHEDULER = 'connector-reconcile';

/** Reconciliation runs at a LOW frequency (hourly) — it's a catch-up, not real-time. */
export const CONNECTOR_RECONCILE_EVERY_MS = 60 * 60 * 1000;

/** Max connectors reconciled per sweep (batching / rate-limit guard). */
export const CONNECTOR_RECONCILE_BATCH = 100;

// --- Gmail inbound polling driver (real-time-ish inbound → NEW_EMAIL) --------
// A per-connector poll of the Gmail REST history feed: new inbound messages →
// RawEvent → CanonicalEvent(NEW_EMAIL) → fireEvent. A BullMQ repeatable sweeps
// all CONNECTED gmail connectors on a short interval. Inert offline (no CONNECTED
// gmail connectors in tests) and safe on any provider/API error (logs + no-op).

// --- IMAP inbound polling driver (own-mailbox inbound → NEW_EMAIL) ----------
// The SMTP/IMAP counterpart of the Gmail driver, for the `email` skill: a
// company's own mail server. Same pipeline, same canonical events.

/** Queue that drives the scheduled IMAP inbound poll sweep. */
export const IMAP_INBOUND_QUEUE = 'imap-inbound';

/** Repeatable job name for the IMAP sweep. */
export const IMAP_INBOUND_JOB = 'imap-inbound-sweep';

/** Scheduler id for the repeatable IMAP sweep (idempotent upsert on boot). */
export const IMAP_INBOUND_SCHEDULER = 'imap-inbound-sweep';

/**
 * How often the IMAP sweep runs.
 *
 * Slower than Gmail's poll on purpose. Gmail's history feed is a cheap HTTP
 * call against Google's infrastructure; this opens a real IMAP session against
 * a customer's own mail server, which counts against their connection limit and
 * appears in their security logs. Two minutes is responsive enough for
 * automation and gentle enough not to look like an attack.
 */
export const IMAP_INBOUND_EVERY_MS = 120_000;

/** Max connectors per sweep, and max messages ingested per connector per poll. */
export const IMAP_INBOUND_BATCH = 25;

/** Cap on the stored plain-text body, mirroring GMAIL_BODY_MAX_CHARS. */
export const IMAP_MAX_BODY_CHARS = 20_000;

/** Queue that drives the scheduled Gmail inbound poll sweep. */
export const GMAIL_INBOUND_QUEUE = 'gmail-inbound';

/** Repeatable job name for the inbound poll sweep. */
export const GMAIL_INBOUND_JOB = 'gmail-inbound-sweep';

/** Job-scheduler id (idempotent upsert, like the other repeatables). */
export const GMAIL_INBOUND_SCHEDULER = 'gmail-inbound';

/** Inbound polling runs frequently (~60s) — this is the near-real-time driver. */
export const GMAIL_INBOUND_EVERY_MS = 60 * 1000;

/** Max gmail connectors polled per sweep (batching / rate-limit guard). */
export const GMAIL_INBOUND_BATCH = 100;

/** Max Gmail history pages walked per poll (bounds a large catch-up). */
export const GMAIL_HISTORY_MAX_PAGES = 10;

/** Skip attachments larger than this (bytes) — bounds download + parse cost. */
export const GMAIL_ATTACHMENT_MAX_BYTES = 5 * 1024 * 1024;

/** Cap extracted text (chars) PER attachment so a huge CV can't bloat the payload. */
export const GMAIL_ATTACHMENT_MAX_CHARS = 20_000;

/** Cap the full email body text (chars) carried into the trigger payload. */
export const GMAIL_BODY_MAX_CHARS = 20_000;

/** Max attachment parts inspected per message (defensive bound). */
export const GMAIL_MAX_ATTACHMENTS = 10;
