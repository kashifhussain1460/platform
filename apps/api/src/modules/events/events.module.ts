import { BullModule } from '@nestjs/bullmq';
import { Module } from '@nestjs/common';
import { SkillsModule } from '../skills/skills.module';
import { WorkflowsModule } from '../workflows/workflows.module';
import { ConnectorEventsController } from './connector-events.controller';
import { ConnectorWebhookController } from './connector-webhook.controller';
import { EventsController } from './events.controller';
import { EventsService } from './events.service';
import {
  CONNECTOR_RECONCILE_QUEUE,
  EVENT_NORMALIZE_QUEUE,
  GMAIL_INBOUND_QUEUE,
  IMAP_INBOUND_QUEUE,
} from './events.constants';
import { CanonicalIngestModule } from './ingestion/canonical-ingest.module';
import { EventNormalizeProcessor } from './ingestion/event-normalize.processor';
import { ConnectorReconcileService } from './reconciliation/connector-reconcile.service';
import { ConnectorReconcileProcessor } from './reconciliation/connector-reconcile.processor';
import { ConnectorPollController } from './inbound/connector-poll.controller';
import { GmailInboundService } from './inbound/gmail-inbound.service';
import { GmailInboundProcessor } from './inbound/gmail-inbound.processor';
import { ImapInboundService } from './inbound/imap-inbound.service';
import { ImapInboundProcessor } from './inbound/imap-inbound.processor';
import { queueWorkersEnabled } from '../../common/resilience/queue-workers';

/**
 * Connector Event Ingestion module (Unit A) — the per-provider event pipeline
 * spine: a public signed webhook edge → RawEvent (append-only) → a BullMQ
 * `event-normalize` queue + in-process WorkerHost → provider-agnostic
 * CanonicalEvent → WorkflowsService.fireEvent → ACTIVE EVENT workflows.
 *
 * Reuses SkillsModule (the InstalledSkill IS the connector; getDecryptedCredentials
 * yields the webhook secret) and WorkflowsModule (fireEvent drives the existing
 * engine). The shared BullMQ connection is registered globally by KnowledgeModule
 * (BullModule.forRootAsync), so only registerQueue is needed here. No dependency
 * cycle: Events → {Workflows, Skills}; neither imports Events.
 */
@Module({
  imports: [
    BullModule.registerQueue({ name: EVENT_NORMALIZE_QUEUE }),
    BullModule.registerQueue({ name: CONNECTOR_RECONCILE_QUEUE }),
    BullModule.registerQueue({ name: GMAIL_INBOUND_QUEUE }),
    BullModule.registerQueue({ name: IMAP_INBOUND_QUEUE }),
    SkillsModule,
    WorkflowsModule,
    CanonicalIngestModule,
  ],
  controllers: [
    ConnectorWebhookController,
    ConnectorEventsController,
    EventsController,
    ConnectorPollController,
  ],
  providers: [
    EventsService,
    ConnectorReconcileService,
    GmailInboundService,
    ImapInboundService,
    ...(queueWorkersEnabled()
      ? [
          EventNormalizeProcessor,
          ConnectorReconcileProcessor,
          GmailInboundProcessor,
          ImapInboundProcessor,
        ]
      : []),
  ],
  exports: [
    EventsService,
    CanonicalIngestModule,
    ConnectorReconcileService,
    GmailInboundService,
    ImapInboundService,
  ],
})
export class EventsModule {}
