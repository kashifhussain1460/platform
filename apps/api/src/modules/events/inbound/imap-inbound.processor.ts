import { InjectQueue, Processor, WorkerHost } from '@nestjs/bullmq';
import { Logger, type OnModuleInit } from '@nestjs/common';
import type { Job, Queue } from 'bullmq';
import {
  IMAP_INBOUND_EVERY_MS,
  IMAP_INBOUND_JOB,
  IMAP_INBOUND_QUEUE,
  IMAP_INBOUND_SCHEDULER,
} from '../events.constants';
import { DEFAULT_QUEUE_CONCURRENCY } from '../../../common/resilience/queue-concurrency.constants';
import { ImapInboundService } from './imap-inbound.service';
import { runInJobContext } from '../../../common/observability/job-context';

/**
 * In-process BullMQ worker for the IMAP INBOUND poll sweep — the own-mailbox
 * counterpart of `GmailInboundProcessor`, deliberately identical in shape.
 *
 * Inert until a customer both connects an `email` connector WITH IMAP settings
 * and activates a workflow that consumes inbound email: `sweep()` finds no
 * consumers and returns immediately, so the offline/test path never opens a
 * socket.
 */
@Processor(IMAP_INBOUND_QUEUE, { concurrency: DEFAULT_QUEUE_CONCURRENCY })
export class ImapInboundProcessor extends WorkerHost implements OnModuleInit {
  private readonly logger = new Logger(ImapInboundProcessor.name);

  constructor(
    @InjectQueue(IMAP_INBOUND_QUEUE) private readonly queue: Queue,
    private readonly inbound: ImapInboundService,
  ) {
    super();
  }

  async onModuleInit(): Promise<void> {
    try {
      await this.queue.upsertJobScheduler(
        IMAP_INBOUND_SCHEDULER,
        { every: IMAP_INBOUND_EVERY_MS },
        {
          name: IMAP_INBOUND_JOB,
          opts: { removeOnComplete: true, removeOnFail: 100 },
        },
      );
    } catch (err) {
      // A Redis hiccup at boot must not crash the app; inbound poll is best-effort.
      this.logger.warn(
        `Could not register imap-inbound scheduler: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    }
  }

  async process(job: Job): Promise<void> {
    return runInJobContext(job, () => this.processJob(job));
  }

  private async processJob(job: Job): Promise<void> {
    if (job.name !== IMAP_INBOUND_JOB) {
      return;
    }
    const { polled, newMessages, firedRuns } = await this.inbound.sweep();
    if (polled > 0) {
      this.logger.debug(
        `imap-inbound sweep: polled ${polled} mailbox(es), ${newMessages} new, ${firedRuns} run(s) fired`,
      );
    }
  }
}
