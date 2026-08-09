import { InjectQueue } from '@nestjs/bullmq';
import {
  Injectable,
  Logger,
  NotFoundException,
  UnauthorizedException,
} from '@nestjs/common';
import { createHash } from 'crypto';
import { Prisma } from '@prisma/client';
import type { Queue } from 'bullmq';
import type {
  CanonicalEventDto,
  ConnectorEventKind,
  EventLineageDto,
  RawEventDto,
} from '@vaep/types';
import { PrismaService } from '../../common/prisma/prisma.service';
import { SkillsService } from '../skills/skills.service';
import { toWorkflowRunDto } from '../workflows/workflows.mapper';
import {
  DEFAULT_EVENTS_LIMIT,
  EVENT_NORMALIZE_JOB,
  EVENT_NORMALIZE_QUEUE,
  MAX_EVENTS_LIMIT,
  type NormalizeJobData,
} from './events.constants';
import { toCanonicalEventDto, toRawEventDto } from './events.mapper';
import {
  getProviderDriver,
  type NormalizedHeaders,
} from './normalization/signature-verifier';

/** Outcome of an ingestion-edge call, used by the controller to pick 202 vs 200. */
export interface IngestResult {
  /** True when this delivery duplicated an already-seen event (idempotent no-op). */
  deduped: boolean;
  rawEventId: string | null;
}

/**
 * The connector event pipeline's edge + query surface (docs §2.4/§3/§4).
 *
 * `ingestWebhook` is the "dumb, fast" receiver: resolve the connector, verify the
 * provider signature over the RAW body, dedupe on the delivery id, persist an
 * append-only RawEvent, enqueue a normalization job, and return — NO parsing,
 * LLM, or external calls at the edge. Everything else happens asynchronously on
 * the `event-normalize` queue (see EventNormalizeProcessor).
 *
 * The read methods back the tenant-scoped observability endpoints.
 */
@Injectable()
export class EventsService {
  private readonly logger = new Logger(EventsService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly skills: SkillsService,
    @InjectQueue(EVENT_NORMALIZE_QUEUE)
    private readonly queue: Queue<NormalizeJobData>,
  ) {}

  // --- Ingestion edge ------------------------------------------------------

  /**
   * Ingest a provider webhook for one connector (InstalledSkill). Throws 404 if
   * the connector is unknown and 401 if the signature is missing/invalid (before
   * any business logic). A verified, non-duplicate event is persisted RECEIVED
   * and a normalization job is enqueued.
   */
  async ingestWebhook(
    connectorId: string,
    rawBody: Buffer | undefined,
    payload: unknown,
    rawHeaders: Record<string, string | string[] | undefined>,
  ): Promise<IngestResult> {
    // 1) Resolve the connector (never trust the body for tenant/connector).
    const connector = await this.prisma.installedSkill.findUnique({
      where: { id: connectorId },
    });
    if (!connector) {
      throw new NotFoundException('Connector not found');
    }
    const provider = this.providerFor(connector.skillKey);
    const driver = getProviderDriver(provider);
    const headers = this.normalizeHeaders(rawHeaders);

    // 2) Verify the signature over the RAW body using the connector's secret.
    const creds = await this.skills.getDecryptedCredentials(connector.id);
    const secret =
      typeof creds.webhookSecret === 'string' ? creds.webhookSecret : '';
    if (!rawBody || !driver.verify(secret, rawBody, headers)) {
      // Reject before persisting business data. We intentionally do NOT store a
      // RawEvent for a bad signature (avoids unauthenticated write amplification
      // and a SKIPPED row colliding with a later valid retry's unique key).
      throw new UnauthorizedException('Invalid webhook signature');
    }

    // 3) Dedupe on a hash of the SIGNED body, not the unsigned delivery header.
    // The HMAC covers the body but NOT the `X-*-Delivery`/`X-Event-Id` header, so
    // an attacker who captures one valid signed request can replay it while
    // mutating/omitting that header to defeat header-based dedupe — each replay
    // would otherwise mint a fresh RawEvent → CanonicalEvent → a new workflow run
    // with real side effects (unbounded amplification). Keying dedupe on the
    // body hash makes an identical signed delivery at-most-once regardless of the
    // header. (The raw provider delivery id is still retained in `headers` for
    // observability.) A signed timestamp/nonce window would additionally bound
    // capture-replay of distinct-but-stale bodies — tracked as a follow-up.
    const externalId = `sha256:${createHash('sha256').update(rawBody).digest('hex')}`;
    const existing = await this.prisma.rawEvent.findUnique({
      where: {
        connectorId_externalId: { connectorId: connector.id, externalId },
      },
    });
    if (existing) {
      return { deduped: true, rawEventId: existing.id };
    }

    // 4) Persist the raw event (append-only) + 5) enqueue normalization.
    let raw;
    try {
      raw = await this.prisma.rawEvent.create({
        data: {
          companyId: connector.companyId,
          connectorId: connector.id,
          provider,
          externalId,
          signatureVerified: true,
          headers: headers as Prisma.InputJsonObject,
          payload: this.toJsonPayload(payload),
          status: 'RECEIVED',
        },
      });
    } catch (err) {
      // A concurrent duplicate delivery lost the create race → treat as deduped.
      if (
        err instanceof Prisma.PrismaClientKnownRequestError &&
        err.code === 'P2002' &&
        externalId
      ) {
        const existing = await this.prisma.rawEvent.findUnique({
          where: {
            connectorId_externalId: { connectorId: connector.id, externalId },
          },
        });
        return { deduped: true, rawEventId: existing?.id ?? null };
      }
      throw err;
    }

    await this.queue.add(
      EVENT_NORMALIZE_JOB,
      { rawEventId: raw.id, companyId: connector.companyId },
      { removeOnComplete: true, removeOnFail: 100 },
    );

    return { deduped: false, rawEventId: raw.id };
  }

  // --- Observability reads (tenant-scoped) ---------------------------------

  /** Recent RawEvent or CanonicalEvent rows for one owned connector, newest first. */
  async listConnectorEvents(
    companyId: string,
    connectorId: string,
    kind: ConnectorEventKind,
    limitRaw?: unknown,
  ): Promise<RawEventDto[] | CanonicalEventDto[]> {
    // Ownership: the connector must belong to the acting tenant (404 otherwise).
    const connector = await this.prisma.installedSkill.findFirst({
      where: { id: connectorId, companyId },
      select: { id: true },
    });
    if (!connector) {
      throw new NotFoundException('Connector not found');
    }
    const take = this.clampLimit(limitRaw);

    if (kind === 'raw') {
      const rows = await this.prisma.rawEvent.findMany({
        where: { companyId, connectorId },
        orderBy: { receivedAt: 'desc' },
        take,
      });
      return rows.map(toRawEventDto);
    }
    const rows = await this.prisma.canonicalEvent.findMany({
      where: { companyId, connectorId },
      orderBy: { receivedAt: 'desc' },
      take,
    });
    return rows.map(toCanonicalEventDto);
  }

  /**
   * Event→run lineage (docs §9): one owned CanonicalEvent plus the WorkflowRun(s)
   * it triggered, joined on `WorkflowRun.triggerEventId`. Each run carries its
   * status + step summary (steps included). 404 if the event isn't the tenant's.
   */
  async getCanonicalLineage(
    companyId: string,
    id: string,
  ): Promise<EventLineageDto> {
    const event = await this.prisma.canonicalEvent.findFirst({
      where: { id, companyId },
    });
    if (!event) {
      throw new NotFoundException('Canonical event not found');
    }
    const runs = await this.prisma.workflowRun.findMany({
      where: { companyId, triggerEventId: id },
      orderBy: { createdAt: 'asc' },
      include: { steps: { orderBy: { createdAt: 'asc' } } },
    });
    return {
      event: toCanonicalEventDto(event),
      runs: runs.map((r) => toWorkflowRunDto(r)),
    };
  }

  /** Recent canonical events for the company (a global feed), optionally by type. */
  async listCanonicalEvents(
    companyId: string,
    type?: string,
    limitRaw?: unknown,
  ): Promise<CanonicalEventDto[]> {
    const take = this.clampLimit(limitRaw);
    const rows = await this.prisma.canonicalEvent.findMany({
      where: { companyId, ...(type ? { type } : {}) },
      orderBy: { receivedAt: 'desc' },
      take,
    });
    return rows.map(toCanonicalEventDto);
  }

  // --- Internals -----------------------------------------------------------

  /**
   * Derive the provider name from the connector's catalog skillKey. Today the
   * skillKey IS the provider (`github`, `slack`, …); a provider without a
   * dedicated driver/mapper falls back to the generic HMAC + passthrough path.
   */
  private providerFor(skillKey: string): string {
    return skillKey;
  }

  /** Lowercase header keys → single string value (arrays joined, undefined dropped). */
  private normalizeHeaders(
    raw: Record<string, string | string[] | undefined>,
  ): NormalizedHeaders {
    const out: NormalizedHeaders = {};
    for (const [key, value] of Object.entries(raw)) {
      if (value === undefined) {
        continue;
      }
      out[key.toLowerCase()] = Array.isArray(value) ? value.join(',') : value;
    }
    return out;
  }

  /** Coerce the parsed body into a non-null JSON object for the payload column. */
  private toJsonPayload(payload: unknown): Prisma.InputJsonValue {
    if (payload && typeof payload === 'object') {
      return payload as Prisma.InputJsonValue;
    }
    return {};
  }

  /** Parse/clamp a requested limit to [1, MAX_EVENTS_LIMIT] (default when absent). */
  private clampLimit(raw: unknown): number {
    const n = Number(raw);
    if (!Number.isFinite(n) || n <= 0) {
      return DEFAULT_EVENTS_LIMIT;
    }
    return Math.min(Math.floor(n), MAX_EVENTS_LIMIT);
  }
}
