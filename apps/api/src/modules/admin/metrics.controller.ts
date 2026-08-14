import {
  Controller,
  ForbiddenException,
  Get,
  Header,
  Headers,
  Logger,
  OnModuleInit,
} from '@nestjs/common';
import { InjectQueue } from '@nestjs/bullmq';
import { ConfigService } from '@nestjs/config';
import type { Queue } from 'bullmq';
import {
  METRIC,
  MetricsRegistry,
} from '../../common/observability/metrics.registry';
import { PrismaService } from '../../common/prisma/prisma.service';
import { WORKFLOW_RUN_QUEUE } from '../workflows/workflows.constants';
import {
  WF_NODE_ATTEMPT_QUEUE,
  WF_RUN_ADVANCE_QUEUE,
} from '../workflow-runtime/workflow-runtime.constants';
import { ALERT_RULES, type AlertRule } from './alert-rules';
import { AlertDispatchService } from './alert-dispatch.service';


/**
 * WAVE 5 §5.3/§5.4 — the scrape endpoint and the alert view.
 *
 * Unauthenticated but LOCAL-ONLY by convention is not good enough for a public
 * serverless host, so both routes reuse the cron shared-secret gate: they are
 * operator surfaces, and the metric names alone leak the shape of the system.
 */
@Controller('admin')
export class MetricsController implements OnModuleInit {
  private readonly logger = new Logger(MetricsController.name);

  constructor(
    private readonly metrics: MetricsRegistry,
    private readonly config: ConfigService,
    private readonly prisma: PrismaService,
    @InjectQueue(WORKFLOW_RUN_QUEUE) private readonly runQueue: Queue,
    @InjectQueue(WF_RUN_ADVANCE_QUEUE) private readonly advanceQueue: Queue,
    @InjectQueue(WF_NODE_ATTEMPT_QUEUE) private readonly attemptQueue: Queue,
    private readonly alertDispatch: AlertDispatchService,
  ) {}

  /**
   * Register the gauges that are cheaper to ASK for than to maintain.
   *
   * Queue depth and outbox backlog change on every produce and consume;
   * instrumenting all of those would be invasive and would still drift. One
   * query per scrape is both cheaper and always correct.
   */
  onModuleInit(): void {
    for (const queue of [this.runQueue, this.advanceQueue, this.attemptQueue]) {
      this.metrics.registerCollector(
        `${METRIC.queueDepth}_${queue.name.replace(/-/g, '_')}`,
        `Waiting + delayed jobs on ${queue.name}`,
        async () => {
          const counts = await queue.getJobCounts('waiting', 'delayed', 'active');
          return (counts.waiting ?? 0) + (counts.delayed ?? 0);
        },
      );
    }

    this.metrics.registerCollector(
      METRIC.outboxBacklog,
      'Unpublished RunEventOutbox rows',
      () => this.prisma.runEventOutbox.count({ where: { publishedAt: null } }),
    );

    // §5.4 "audit relay lag": the age of the oldest unpublished outbox row, in
    // seconds. A COUNT alone cannot distinguish a busy system from a stuck one
    // — a backlog of 100 that is 2 seconds old is healthy; a backlog of 3 that
    // is an hour old is an outage.
    this.metrics.registerCollector(
      METRIC.auditRelayLag,
      'Age in seconds of the oldest unpublished run event',
      async () => {
        const oldest = await this.prisma.runEventOutbox.findFirst({
          where: { publishedAt: null },
          orderBy: { id: 'asc' },
          select: { createdAt: true },
        });
        return oldest
          ? Math.round((Date.now() - oldest.createdAt.getTime()) / 1000)
          : 0;
      },
    );
  }

  @Get('metrics')
  @Header('content-type', 'text/plain; version=0.0.4; charset=utf-8')
  async scrape(
    @Headers('x-cron-secret') secret?: string,
    @Headers('authorization') authorization?: string,
  ): Promise<string> {
    this.assertAuthorized(secret, authorization);
    return this.metrics.render();
  }

  /** Which rules are firing right now. */
  @Get('alerts')
  async alerts(
    @Headers('x-cron-secret') secret?: string,
    @Headers('authorization') authorization?: string,
  ): Promise<{
    firing: (AlertRule & { value: number })[];
    evaluated: number;
  }> {
    this.assertAuthorized(secret, authorization);
    // Evaluation lives in AlertDispatchService so this view and the delivering
    // cron (`/admin/cron/alerts`) can never disagree about what is firing.
    const firing = await this.alertDispatch.evaluate();
    if (firing.length > 0) {
      this.logger.warn(
        `alerts firing: ${firing.map((f) => `${f.name}=${f.value}`).join(', ')}`,
      );
    }
    return { firing, evaluated: ALERT_RULES.length };
  }

  /**
   * Same shared-secret gate as the cron routes, and DISABLED when no secret is
   * configured rather than left open.
   *
   * A metrics endpoint is not harmless to expose: the series names and label
   * values describe the system's shape, its tenants' activity levels and which
   * providers it depends on. Scrapers send the secret as a bearer token, which
   * is also what Vercel Cron does, so both forms are accepted.
   */
  private assertAuthorized(secret?: string, authorization?: string): void {
    const expected = this.config.get<string>('CRON_SECRET');
    if (!expected) {
      throw new ForbiddenException(
        'Operator endpoints are disabled because CRON_SECRET is not set.',
      );
    }
    const bearer = authorization?.startsWith('Bearer ')
      ? authorization.slice('Bearer '.length)
      : undefined;
    if (secret !== expected && bearer !== expected) {
      throw new ForbiddenException('Bad operator secret');
    }
  }
}
