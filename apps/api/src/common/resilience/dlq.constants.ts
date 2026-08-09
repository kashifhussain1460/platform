import { KNOWLEDGE_INGEST_QUEUE } from '../../modules/knowledge/knowledge.constants';
import { WORKFLOW_RUN_QUEUE } from '../../modules/workflows/workflows.constants';
import {
  CONNECTOR_RECONCILE_QUEUE,
  EVENT_NORMALIZE_QUEUE,
  GMAIL_INBOUND_QUEUE,
} from '../../modules/events/events.constants';
import { CONNECTOR_HEALTH_QUEUE } from '../../modules/skills/connectors/connector.constants';
import { MARKETING_SYNC_QUEUE } from '../../modules/engines/marketing/marketing.constants';
import { WORKFLOW_RUNTIME_QUEUES } from '../../modules/workflow-runtime/workflow-runtime.constants';

/**
 * The known BullMQ queues the DLQ surface covers, by name (docs §4.4). These are
 * the pure name constants each module already exports (no DI import), kept as the
 * single source of truth so a rename is reflected here automatically.
 */
export const DLQ_KNOWN_QUEUES = [
  KNOWLEDGE_INGEST_QUEUE,
  WORKFLOW_RUN_QUEUE,
  EVENT_NORMALIZE_QUEUE,
  CONNECTOR_HEALTH_QUEUE,
  CONNECTOR_RECONCILE_QUEUE,
  // These two have live @Processor workers but were missing here, so their
  // poison jobs were invisible to /admin/dlq — dead-lettered work nobody could
  // see or replay. Every queue with a processor belongs in this list.
  GMAIL_INBOUND_QUEUE,
  MARKETING_SYNC_QUEUE,
  // P1 durable runtime (ledger R7): reuse this ONE generic admin DLQ surface
  // rather than adding /admin/workflow-dlq*. Filter with ?queue=wf-node-attempt.
  ...WORKFLOW_RUNTIME_QUEUES,
] as const;

/**
 * A dedicated queue name used ONLY by the DLQ e2e spec to enqueue a deliberately
 * failing, company-scoped job. Allowed by name (so the endpoint can query it) but
 * excluded from the "all queues" aggregation — harmless in production (empty).
 */
export const DLQ_TEST_QUEUE = 'dlq-test';

/** Every queue name the DLQ endpoints will accept (known + the e2e test queue). */
export const DLQ_ALLOWED_QUEUES: readonly string[] = [
  ...DLQ_KNOWN_QUEUES,
  DLQ_TEST_QUEUE,
];

/** Default / max number of DLQ rows returned per queue. */
export const DLQ_DEFAULT_LIMIT = 50;
export const DLQ_MAX_LIMIT = 200;
