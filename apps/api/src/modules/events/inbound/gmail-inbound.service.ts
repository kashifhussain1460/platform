import { Injectable, Logger } from '@nestjs/common';
import { Prisma, type CanonicalEvent, type InstalledSkill } from '@prisma/client';
import { PrismaService } from '../../../common/prisma/prisma.service';
import { asFetchResponse } from '../../../common/http/fetch-response';
import { ConnectorTokenService } from '../../skills/connectors/connector-token.service';
import { ConnectorHealthService } from '../../skills/connectors/connector-health.service';
import { WorkflowsService } from '../../workflows/workflows.service';
import { extractText } from '../../knowledge/knowledge.util';
import {
  GMAIL_ATTACHMENT_MAX_BYTES,
  GMAIL_ATTACHMENT_MAX_CHARS,
  GMAIL_BODY_MAX_CHARS,
  GMAIL_HISTORY_MAX_PAGES,
  GMAIL_INBOUND_BATCH,
  GMAIL_MAX_ATTACHMENTS,
} from '../events.constants';
import { mapRawEvent } from '../normalization/event-mapper';

/** Prisma Json helper: JS null → the DB JSON-null sentinel. */
function toJson(value: unknown): Prisma.InputJsonValue | typeof Prisma.JsonNull {
  return value == null ? Prisma.JsonNull : (value as Prisma.InputJsonValue);
}

/** Extract the bare address from a raw `From` header (angle-bracket or plain form). */
function extractEmailAddress(from: unknown): string | null {
  if (typeof from !== 'string' || !from.trim()) {
    return null;
  }
  const match = from.match(/<([^>]+)>/);
  const addr = (match ? match[1] : from).trim().toLowerCase();
  return addr || null;
}

/** Outcome of a single connector poll (surfaced by the manual poll endpoint). */
export interface PollResult {
  /** True when this poll only established the baseline cursor (fired nothing). */
  baseline: boolean;
  /** New inbound messages detected + normalized to canonical events this poll. */
  newMessages: number;
  /** WorkflowRuns fired by those new NEW_EMAIL canonical events. */
  firedRuns: number;
  /** True when nothing was done (not a gmail connector / no token / API error). */
  noop?: boolean;
  /** True when a stale cursor forced a re-baseline (Gmail 404 on history). */
  rebaselined?: boolean;
}

/**
 * Bounded attachment metadata carried into the payload (never the full text).
 * A skipped attachment (over the size cap, or an unsupported type) is now
 * recorded here too (docs/test-cases REC-13) — previously it was ONLY a
 * server log line, invisible to anyone looking at the run/candidate: a good
 * candidate whose CV happened to be an unsupported format could be silently
 * scored on nothing but their email body with no visible explanation why.
 */
interface InboundAttachment {
  filename: string;
  chars: number;
  /** Present only for a skipped attachment; absent means it was parsed fine. */
  skipped?: boolean;
  skipReason?: string;
}

/** Flattened inbound message metadata a RawEvent payload carries. */
interface InboundMessage {
  messageId: string;
  from: string | null;
  subject: string | null;
  snippet: string | null;
  date: string | null;
  /** Full email body text (text/plain, or stripped text/html). */
  body: string | null;
  /** Concatenated extracted text from parseable attachments (PDF/plain). */
  cv: string | null;
  /** Metadata (filename + extracted char count) for each parsed attachment. */
  attachments: InboundAttachment[];
  /**
   * True when the message carries `In-Reply-To`/`References` (it's a reply
   * within an existing thread, not a fresh message). A candidate replying
   * "thanks for letting me know" to their OWN rejection email would otherwise
   * be fed back into the scoring AI_STEP as if it were a new CV submission —
   * so replies fire a DISTINCT eventType ('NEW_EMAIL_REPLY' instead of
   * 'NEW_EMAIL'). Every existing NEW_EMAIL-triggered workflow is completely
   * unaffected (fireEvent matches by exact eventType); only a workflow that
   * explicitly sets `triggerConfig.eventType: 'NEW_EMAIL_REPLY'` receives
   * replies at all.
   */
  isReply: boolean;
  /**
   * Best-effort heuristic: does this look like an actual job application?
   * (has a parseable attachment, OR the subject/body mentions common
   * application terms). Exposed so a company's EVENT trigger can opt into
   * filtering out spam/newsletters/unrelated mail via the existing condition
   * DSL (`triggerConfig.conditions`) — a policy choice per workflow, not a
   * hardcoded rule in this generic driver.
   */
  looksLikeApplication: boolean;
}

/** Loose keyword heuristic for "this looks like a job application." */
const APPLICATION_KEYWORDS_RE =
  /\b(resume|cv|curriculum vitae|application|applying|candidate|hiring|job opening|position|vacancy)\b/i;

/** has-attachment OR subject/body mentions application terms. */
function computeLooksLikeApplication(
  subject: string | null,
  body: string | null,
  attachments: InboundAttachment[],
): boolean {
  if (attachments.length > 0) {
    return true;
  }
  const text = `${subject ?? ''} ${body ?? ''}`;
  return APPLICATION_KEYWORDS_RE.test(text);
}

/** A single MIME part of a Gmail `format=full` message payload. */
interface GmailPart {
  mimeType?: string;
  filename?: string;
  headers?: Array<{ name?: string; value?: string }>;
  body?: { data?: string; size?: number; attachmentId?: string };
  parts?: GmailPart[];
}

const GMAIL_BASE = 'https://gmail.googleapis.com/gmail/v1/users/me';

/** Gmail inbound event types — a connector is only polled if a workflow wants one. */
const GMAIL_EVENT_TYPES = ['NEW_EMAIL', 'NEW_EMAIL_REPLY'] as const;

/**
 * True when a poll error means the connector can NEVER succeed as-is: credentials
 * that won't decrypt (AES-GCM "unable to authenticate data" / bad key), a rejected
 * token (401), or a failed refresh (revoked grant). Such a connector is taken out
 * of the sweep so it doesn't retry — and hammer Gmail — every cycle.
 */
function isUnrecoverableAuthError(message: string): boolean {
  return /unable to authenticate data|unsupported state|bad decrypt|gmail_unauthorized|token refresh failed|invalid_grant/i.test(
    message,
  );
}

/** Decode a Gmail base64url payload chunk to a Buffer (empty on bad input). */
function decodeB64Url(data: string | undefined): Buffer {
  if (!data) {
    return Buffer.alloc(0);
  }
  try {
    return Buffer.from(data, 'base64url');
  } catch {
    return Buffer.alloc(0);
  }
}

/** Strip HTML tags/entities to plain-ish text (best-effort, no DOM). */
function stripHtml(html: string): string {
  return html
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/&quot;/gi, '"')
    .replace(/[ \t]+/g, ' ')
    .replace(/\s*\n\s*/g, '\n')
    .trim();
}

/**
 * GmailInboundService — the INBOUND polling driver (the real-time-ish counterpart
 * to the webhook edge). It turns "a new email arrived in the connected Gmail
 * inbox" into a `NEW_EMAIL` CanonicalEvent that drives ACTIVE EVENT workflows
 * (RecruitAI), using the Gmail REST API via global `fetch` + the connector's
 * OAuth access token (auto-refreshed by ConnectorTokenService).
 *
 * poll(connector):
 *   - BASELINE (inboundCursor null): read the mailbox's current `historyId`
 *     (GET /profile), store it, and fire NOTHING — so connecting an inbox does
 *     not flood the pipeline with the whole existing history. Returns baseline.
 *   - DELTA (cursor set): GET /history?startHistoryId=<cursor>&historyTypes=
 *     messageAdded, collect NEW inbound message ids (skip sent-only), fetch each
 *     message's metadata, and run it through the SAME normalization it would get
 *     from a webhook: persist a RawEvent → map (gmail mapper → NEW_EMAIL) →
 *     idempotently upsert a CanonicalEvent → fireEvent. Advance the cursor to the
 *     newest historyId at the end.
 *
 * Idempotent end-to-end: RawEvent is unique on (connectorId, externalId=messageId)
 * and CanonicalEvent on (companyId, dedupeKey=`gmail:msg:<id>`), and a run fires
 * ONLY for a freshly-created canonical event — so a re-poll never double-fires.
 * Robust: any token/refresh/API error is logged and becomes a no-op; poll never
 * throws, so it can never crash the scheduler (or an offline test).
 */
@Injectable()
export class GmailInboundService {
  private readonly logger = new Logger(GmailInboundService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly tokens: ConnectorTokenService,
    private readonly health: ConnectorHealthService,
    private readonly workflows: WorkflowsService,
  ) {}

  // --- Public API ----------------------------------------------------------

  /** Poll ONE gmail connector. Never throws (errors → logged no-op). */
  async poll(connector: InstalledSkill): Promise<PollResult> {
    if (connector.skillKey !== 'gmail') {
      return { baseline: false, newMessages: 0, firedRuns: 0, noop: true };
    }
    try {
      const token = await this.tokens.getAccessToken(connector.id);
      if (!token) {
        // Expected for demo/seed connectors marked CONNECTED with mock
        // credentials (no real accessToken/refreshToken) — debug, not warn,
        // so the ~60s sweep doesn't spam logs for something that will never
        // resolve. A REAL connector losing its grant instead flows through
        // ConnectorHealthService (refresh failure -> DISCONNECTED) below.
        this.logger.debug(
          `Gmail poll skipped for ${connector.id}: no access token`,
        );
        return { baseline: false, newMessages: 0, firedRuns: 0, noop: true };
      }

      if (!connector.inboundCursor) {
        return this.baseline(connector, token);
      }
      return this.delta(connector, token, connector.inboundCursor);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      // A connector whose credentials can't be decrypted (rotated/mismatched
      // ENCRYPTION_KEY, or a row marked CONNECTED without real creds) or whose
      // token is rejected (401) will fail EVERY sweep forever — and each attempt
      // hits Gmail with an unusable token. Take it out of the CONNECTED pool so
      // it stops the ~60s error storm and prompts a reconnect, instead of jamming
      // the scheduler with doomed retries.
      if (isUnrecoverableAuthError(message)) {
        this.logger.warn(
          `Gmail connector ${connector.id} can't authenticate (${message}) — marking DISCONNECTED; reconnect required.`,
        );
        await this.health
          .markDisconnected(connector.id, 'Gmail credentials unreadable or revoked — reconnect required')
          .catch(() => undefined);
      } else {
        this.logger.error(`Gmail poll failed for connector ${connector.id}: ${message}`);
      }
      return { baseline: false, newMessages: 0, firedRuns: 0, noop: true };
    }
  }

  /**
   * Scheduled sweep. Polls a gmail connector ONLY when it is CONNECTED + enabled
   * AND some ACTIVE workflow actually consumes its inbound email — otherwise a
   * connected inbox would be polled (and the Gmail API hit) every ~60s for
   * nothing, wasting quota and scheduler time. Two scoping rules mirror the
   * trigger model:
   *   - a company with an ACTIVE gmail EVENT workflow that pins no mailbox
   *     (`triggerConfig.connectorId` unset) polls ALL its gmail connectors;
   *   - a workflow that pins one mailbox polls only that connector.
   * Per-connector failures are isolated (poll never throws). Safe offline: no
   * matching workflows → polls nothing.
   */
  async sweep(): Promise<{ polled: number; newMessages: number; firedRuns: number }> {
    const consumers = await this.prisma.workflow.findMany({
      where: {
        status: 'ACTIVE',
        triggerType: 'EVENT',
        OR: GMAIL_EVENT_TYPES.map((eventType) => ({
          triggerConfig: { path: ['eventType'], equals: eventType },
        })),
      },
      select: { companyId: true, triggerConfig: true },
    });
    if (consumers.length === 0) {
      // Nothing is listening for inbound email — do not touch Gmail at all.
      return { polled: 0, newMessages: 0, firedRuns: 0 };
    }

    const companiesWithUnscoped = new Set<string>();
    const pinnedConnectorIds = new Set<string>();
    for (const wf of consumers) {
      const cfg = (wf.triggerConfig ?? {}) as { connectorId?: unknown };
      const connectorId = typeof cfg.connectorId === 'string' ? cfg.connectorId : '';
      if (connectorId) pinnedConnectorIds.add(connectorId);
      else companiesWithUnscoped.add(wf.companyId);
    }
    const companyIds = [...new Set(consumers.map((w) => w.companyId))];

    const candidates = await this.prisma.installedSkill.findMany({
      where: {
        skillKey: 'gmail',
        connectionStatus: 'CONNECTED',
        enabled: true,
        companyId: { in: companyIds },
      },
      take: GMAIL_INBOUND_BATCH,
    });
    // Keep a connector only if its company has an unscoped consumer, or the
    // connector itself is pinned by a workflow.
    const connectors = candidates.filter(
      (c) => companiesWithUnscoped.has(c.companyId) || pinnedConnectorIds.has(c.id),
    );

    let newMessages = 0;
    let firedRuns = 0;
    for (const connector of connectors) {
      const res = await this.poll(connector);
      newMessages += res.newMessages;
      firedRuns += res.firedRuns;
    }
    return { polled: connectors.length, newMessages, firedRuns };
  }

  // --- Baseline / delta ----------------------------------------------------

  /** Store the mailbox's current historyId as the watermark; fire nothing. */
  private async baseline(
    connector: InstalledSkill,
    token: string,
  ): Promise<PollResult> {
    const profile = await this.gapi<{ historyId?: string }>(token, '/profile');
    const historyId = profile?.historyId;
    if (!historyId) {
      this.logger.warn(`Gmail baseline for ${connector.id}: no historyId in profile`);
      return { baseline: false, newMessages: 0, firedRuns: 0, noop: true };
    }
    await this.prisma.installedSkill.update({
      where: { id: connector.id },
      data: { inboundCursor: historyId },
    });
    this.logger.log(
      `Gmail inbound baselined connector ${connector.id} at historyId ${historyId}`,
    );
    return { baseline: true, newMessages: 0, firedRuns: 0 };
  }

  /** Walk the Gmail history feed since the cursor and ingest new inbound mail. */
  private async delta(
    connector: InstalledSkill,
    token: string,
    cursor: string,
  ): Promise<PollResult> {
    const collected = await this.collectAddedMessageIds(token, cursor);
    if (collected.stale) {
      // Cursor too old (Gmail 404): re-baseline to the current historyId so the
      // next poll works from a fresh watermark. We fire nothing for the gap.
      const rebaselined = await this.baseline(connector, token);
      return { ...rebaselined, baseline: false, rebaselined: true };
    }

    let newMessages = 0;
    let firedRuns = 0;
    for (const messageId of collected.messageIds) {
      const message = await this.fetchMessage(token, messageId);
      if (!message) {
        continue;
      }
      const res = await this.ingestInbound(connector, message);
      if (res.created) {
        newMessages += 1;
        firedRuns += res.firedRuns;
      }
    }

    // Advance the watermark to the newest historyId the feed reported (only
    // forward; never below the current cursor).
    if (collected.newestHistoryId && collected.newestHistoryId !== cursor) {
      await this.prisma.installedSkill.update({
        where: { id: connector.id },
        data: { inboundCursor: collected.newestHistoryId },
      });
    }
    return { baseline: false, newMessages, firedRuns };
  }

  // --- Normalization (reuses the shared mapper + canonical pipeline) --------

  /**
   * Persist a RawEvent + idempotently upsert a CanonicalEvent (via the shared
   * gmail mapper) + fireEvent — the same steps the async normalize worker runs,
   * done inline so the poll can return an accurate firedRuns count. Idempotent on
   * both unique keys; fires ONLY when a canonical event was freshly created.
   */
  private async ingestInbound(
    connector: InstalledSkill,
    message: InboundMessage,
  ): Promise<{ created: boolean; firedRuns: number }> {
    const raw = await this.upsertRawEvent(connector, message);

    const mapping = mapRawEvent({
      provider: 'gmail',
      externalId: message.messageId,
      headers: null,
      payload: message as unknown as Record<string, unknown>,
    });

    let canonical: CanonicalEvent | null =
      await this.prisma.canonicalEvent.findUnique({
        where: {
          companyId_dedupeKey: {
            companyId: connector.companyId,
            dedupeKey: mapping.dedupeKey,
          },
        },
      });
    let created = false;
    if (!canonical) {
      try {
        canonical = await this.prisma.canonicalEvent.create({
          data: {
            companyId: connector.companyId,
            connectorId: connector.id,
            rawEventId: raw?.id ?? null,
            provider: 'gmail',
            type: mapping.type,
            dedupeKey: mapping.dedupeKey,
            occurredAt: mapping.occurredAt,
            subject: toJson(mapping.subject),
            data: toJson(mapping.data),
          },
        });
        created = true;
      } catch (err) {
        if (
          err instanceof Prisma.PrismaClientKnownRequestError &&
          err.code === 'P2002'
        ) {
          canonical = await this.prisma.canonicalEvent.findUnique({
            where: {
              companyId_dedupeKey: {
                companyId: connector.companyId,
                dedupeKey: mapping.dedupeKey,
              },
            },
          });
        } else {
          throw err;
        }
      }
    }

    if (raw && raw.status === 'RECEIVED') {
      await this.prisma.rawEvent.update({
        where: { id: raw.id },
        data: { status: 'NORMALIZED', error: null },
      });
    }

    let firedRuns = 0;
    if (created && canonical) {
      try {
        // A reply within an existing thread (e.g. a candidate replying with
        // requested details, or "thanks" to their own rejection email) fires
        // a DISTINCT event type ('NEW_EMAIL_REPLY') rather than 'NEW_EMAIL' —
        // every existing NEW_EMAIL-triggered workflow is completely unaffected
        // (fireEvent matches by exact eventType), so re-scoring/re-notifying
        // an existing conversation as a fresh submission still never happens
        // unless a workflow explicitly opts in to NEW_EMAIL_REPLY.
        const eventType = message.isReply ? 'NEW_EMAIL_REPLY' : canonical.type;
        if (message.isReply) {
          this.logger.log(
            `Gmail message ${message.messageId} is a thread reply — firing as NEW_EMAIL_REPLY (opt-in only)`,
          );
        }
        // Flatten the email fields to the TOP LEVEL of the trigger payload so
        // workflow templates can use {{trigger.subject}} / {{trigger.body}} /
        // {{trigger.from}} / {{trigger.snippet}} naturally. The canonical
        // aggregate `subject:{type,email}` stays on the CanonicalEvent row; we
        // also keep `data` so {{trigger.data.*}} continues to resolve.
        const email = (canonical.data ?? {}) as Record<string, unknown>;

        // Repeat-sender signal (docs/test-cases REC-12/SALES-03): count prior
        // NEW_EMAIL submissions from the SAME address for this company. Never
        // blocks/dedupes anything by itself — just exposes the fact so a
        // workflow's Approval message or AI_STEP prompt can reference it (e.g.
        // "this candidate applied before, score N"), instead of silently
        // treating a resubmission as if it were the person's first contact.
        const senderEmail = extractEmailAddress(email.from);
        const priorSubmissionCount = senderEmail
          ? await this.prisma.canonicalEvent.count({
              where: {
                companyId: connector.companyId,
                type: 'NEW_EMAIL',
                id: { not: canonical.id },
                data: { path: ['from'], string_contains: senderEmail },
              },
            })
          : 0;

        // A reply (e.g. "here are my CTC/experience details") carries NO CV/role
        // context of its own — the reply-handling workflow would otherwise have
        // to judge role/salary-band fit completely blind. Look up the sender's
        // most recent PRIOR application (the actual CV submission) and carry its
        // cv/subject along so `{{trigger.originalCv}}` is available to a reply
        // workflow's AI_STEP. Only fetched for replies — a fresh application has
        // nothing "prior" worth looking up.
        let originalCv: string | null = null;
        let originalSubject: string | null = null;
        if (message.isReply && senderEmail) {
          // Take a few recent candidates (not just the single most recent — an
          // earlier REPLY from the same sender has no `cv` either) and use the
          // first one that actually carries a CV, i.e. the real application.
          const priorCandidates = await this.prisma.canonicalEvent.findMany({
            where: {
              companyId: connector.companyId,
              type: 'NEW_EMAIL',
              id: { not: canonical.id },
              data: { path: ['from'], string_contains: senderEmail },
            },
            orderBy: { receivedAt: 'desc' },
            take: 5,
          });
          for (const candidate of priorCandidates) {
            const data = (candidate.data ?? {}) as Record<string, unknown>;
            if (typeof data.cv === 'string' && data.cv) {
              originalCv = data.cv;
              originalSubject = typeof data.subject === 'string' ? data.subject : null;
              break;
            }
          }
        }

        const result = await this.workflows.fireEvent(
          connector.companyId,
          eventType,
          {
            eventId: canonical.id,
            from: email.from ?? null,
            subject: email.subject ?? null,
            snippet: email.snippet ?? null,
            // FULL body now (was the snippet); falls back to snippet when a
            // metadata-only payload carried no parsed body (offline-safe).
            body: email.body ?? email.snippet ?? null,
            // Attachment (CV) text extracted from the email's PDF/text parts.
            cv: email.cv ?? null,
            // The ORIGINAL application's CV/subject (replies only) — see above.
            originalCv,
            originalSubject,
            attachments: email.attachments ?? [],
            messageId: email.messageId ?? null,
            // Precomputed "does this look like a job application" signal — a
            // workflow's own EVENT trigger conditions can opt into filtering
            // out spam/newsletters via this (docs/test-cases REC-07).
            looksLikeApplication: message.looksLikeApplication,
            isRepeatSender: priorSubmissionCount > 0,
            priorSubmissionCount,
            data: email,
          },
          // This mailbox's own connector id -- lets a workflow's EVENT trigger
          // scope itself to ONE specific mailbox via triggerConfig.connectorId
          // (per-employee skill connections), instead of firing for every
          // Gmail connector in the company.
          connector.id,
        );
        firedRuns = result.count;
      } catch (err) {
        // A downstream workflow error must not fail the poll (mirrors the worker).
        this.logger.error(
          `fireEvent failed for canonical ${canonical.id} (NEW_EMAIL): ${
            err instanceof Error ? err.message : String(err)
          }`,
        );
      }
    }
    return { created, firedRuns };
  }

  /** Append-only RawEvent for this message, idempotent on (connectorId, messageId). */
  private async upsertRawEvent(
    connector: InstalledSkill,
    message: InboundMessage,
  ) {
    const where = {
      connectorId_externalId: {
        connectorId: connector.id,
        externalId: message.messageId,
      },
    };
    const existing = await this.prisma.rawEvent.findUnique({ where });
    if (existing) {
      return existing;
    }
    try {
      return await this.prisma.rawEvent.create({
        data: {
          companyId: connector.companyId,
          connectorId: connector.id,
          provider: 'gmail',
          externalId: message.messageId,
          // It came from our authenticated poll — treat as verified.
          signatureVerified: true,
          headers: {},
          payload: message as unknown as Prisma.InputJsonObject,
          status: 'RECEIVED',
        },
      });
    } catch (err) {
      // Lost a create race with a concurrent poll → reuse the winner.
      if (
        err instanceof Prisma.PrismaClientKnownRequestError &&
        err.code === 'P2002'
      ) {
        return this.prisma.rawEvent.findUnique({ where });
      }
      throw err;
    }
  }

  // --- Gmail REST helpers --------------------------------------------------

  /**
   * Collect NEW inbound message ids from the history feed since `cursor`,
   * following pagination up to a page bound. Returns the newest historyId to
   * advance the cursor to. `stale=true` signals a 404 (cursor expired) so the
   * caller re-baselines. Any message carrying the SENT label is skipped
   * (including self-emails with both SENT+INBOX) — see the inline comment
   * below for why.
   */
  private async collectAddedMessageIds(
    token: string,
    cursor: string,
  ): Promise<{ messageIds: string[]; newestHistoryId: string | null; stale: boolean }> {
    const seen = new Set<string>();
    const ordered: string[] = [];
    let newestHistoryId: string | null = cursor;
    let pageToken: string | undefined;

    for (let page = 0; page < GMAIL_HISTORY_MAX_PAGES; page += 1) {
      const params = new URLSearchParams({
        startHistoryId: cursor,
        historyTypes: 'messageAdded',
      });
      if (pageToken) {
        params.set('pageToken', pageToken);
      }
      const res = await this.gapiRaw(token, `/history?${params.toString()}`);
      if (res.status === 404) {
        return { messageIds: [], newestHistoryId: null, stale: true };
      }
      if (res.status === 401) {
        // Revoked/invalid grant mid-delta — surface for poll() to disconnect.
        throw new Error('gmail_unauthorized');
      }
      const body = res.body as {
        history?: Array<{
          messagesAdded?: Array<{
            message?: { id?: string; labelIds?: string[] };
          }>;
        }>;
        historyId?: string;
        nextPageToken?: string;
      } | null;
      if (!body) {
        break;
      }
      if (typeof body.historyId === 'string') {
        newestHistoryId = body.historyId;
      }
      for (const record of body.history ?? []) {
        for (const added of record.messagesAdded ?? []) {
          const msg = added.message;
          const id = msg?.id;
          if (!id || seen.has(id)) {
            continue;
          }
          const labels = msg?.labelIds ?? [];
          // Only inbound: skip ANY message carrying SENT, including self-emails
          // (both SENT+INBOX). A workflow's own outbound notification sent to
          // the same monitored inbox was previously kept here (self-email =
          // "inbound"), got re-detected as a new candidate application, and
          // re-fired the workflow every poll cycle — an infinite feedback
          // loop. Real candidates never send FROM the connected account.
          if (labels.includes('SENT')) {
            continue;
          }
          seen.add(id);
          ordered.push(id);
        }
      }
      pageToken = body.nextPageToken;
      if (!pageToken) {
        break;
      }
    }
    return { messageIds: ordered, newestHistoryId, stale: false };
  }

  /**
   * Fetch one message with `format=full`, extract the full body text (text/plain
   * or stripped text/html) and the text of each parseable attachment (PDF via
   * pdf-parse, text/plain via utf8). Header/snippet extraction is unchanged. Any
   * attachment download/parse error is swallowed (that attachment is skipped);
   * fetchMessage itself only returns null when the message fetch failed.
   */
  private async fetchMessage(
    token: string,
    messageId: string,
  ): Promise<InboundMessage | null> {
    const msg = await this.gapi<{
      snippet?: string;
      payload?: GmailPart;
    }>(token, `/messages/${messageId}?format=full`);
    if (!msg) {
      return null;
    }
    const payload = msg.payload ?? {};
    const headers = payload.headers ?? [];
    const header = (name: string): string | null => {
      const found = headers.find(
        (h) => (h.name ?? '').toLowerCase() === name.toLowerCase(),
      );
      return typeof found?.value === 'string' ? found.value : null;
    };

    const parts = this.flattenParts(payload);
    const body = this.extractBody(parts);
    const { cv, attachments } = await this.extractAttachments(
      token,
      messageId,
      parts,
    );
    const subject = header('Subject');
    const isReply = Boolean(header('In-Reply-To')) || Boolean(header('References'));

    return {
      messageId,
      from: header('From'),
      subject,
      snippet: typeof msg.snippet === 'string' ? msg.snippet : null,
      date: header('Date'),
      body,
      cv,
      attachments,
      isReply,
      looksLikeApplication: computeLooksLikeApplication(subject, body, attachments),
    };
  }

  /** Depth-first flatten of the (recursive) MIME part tree, root included. */
  private flattenParts(root: GmailPart): GmailPart[] {
    const out: GmailPart[] = [];
    const stack: GmailPart[] = [root];
    while (stack.length > 0) {
      const part = stack.pop();
      if (!part) {
        continue;
      }
      out.push(part);
      for (const child of part.parts ?? []) {
        stack.push(child);
      }
    }
    return out;
  }

  /**
   * Build the full body text: prefer the concatenated text/plain parts; fall back
   * to stripped text/html. Attachment parts (those with a filename) are excluded.
   * Bounded to GMAIL_BODY_MAX_CHARS.
   */
  private extractBody(parts: GmailPart[]): string | null {
    const isInline = (p: GmailPart) => !p.filename && !p.body?.attachmentId;
    const collect = (mime: string): string =>
      parts
        .filter((p) => isInline(p) && (p.mimeType ?? '').startsWith(mime))
        .map((p) => decodeB64Url(p.body?.data).toString('utf8'))
        .join('\n')
        .trim();

    let text = collect('text/plain');
    if (!text) {
      const html = collect('text/html');
      text = html ? stripHtml(html) : '';
    }
    if (!text) {
      return null;
    }
    return text.slice(0, GMAIL_BODY_MAX_CHARS);
  }

  /**
   * Download + extract text from each attachment part (filename + attachmentId).
   * PDFs → pdf-parse; text/plain → utf8; other types skipped. Size-bounded
   * (GMAIL_ATTACHMENT_MAX_BYTES) and per-attachment char-capped. Returns the
   * concatenated CV text plus bounded metadata. Never throws (per-attachment
   * errors are logged + skipped), so a poll is never failed by a bad attachment.
   */
  private async extractAttachments(
    token: string,
    messageId: string,
    parts: GmailPart[],
  ): Promise<{ cv: string | null; attachments: InboundAttachment[] }> {
    const attachmentParts = parts
      .filter((p) => p.filename && p.body?.attachmentId)
      .slice(0, GMAIL_MAX_ATTACHMENTS);

    const texts: string[] = [];
    const attachments: InboundAttachment[] = [];
    // Record a skip (docs/test-cases REC-13) instead of only logging it — a
    // candidate whose CV happened to be an unsupported format previously got
    // scored on their email body alone with nothing anywhere visible to
    // explain why; now `{{trigger.attachments}}` carries the skip + reason.
    const skip = (filename: string, reason: string) => {
      this.logger.warn(`Gmail attachment "${filename}" skipped: ${reason}`);
      attachments.push({ filename, chars: 0, skipped: true, skipReason: reason });
    };
    for (const part of attachmentParts) {
      const filename = part.filename as string;
      try {
        const declaredSize = Number(part.body?.size ?? 0);
        if (declaredSize > GMAIL_ATTACHMENT_MAX_BYTES) {
          skip(filename, `${declaredSize}B over the size cap`);
          continue;
        }
        const mime = (part.mimeType ?? '').toLowerCase();
        const lowerName = filename.toLowerCase();
        const isPdf = mime === 'application/pdf' || lowerName.endsWith('.pdf');
        const isDocx =
          mime ===
            'application/vnd.openxmlformats-officedocument.wordprocessingml.document' ||
          lowerName.endsWith('.docx');
        const isText = mime.startsWith('text/') || lowerName.endsWith('.txt');
        if (!isPdf && !isDocx && !isText) {
          skip(filename, `unsupported file type (${mime || 'unknown'})`);
          continue;
        }

        const bytes = await this.downloadAttachment(
          token,
          messageId,
          part.body!.attachmentId as string,
        );
        if (!bytes || bytes.length === 0) {
          skip(filename, 'download returned no data');
          continue;
        }
        if (bytes.length > GMAIL_ATTACHMENT_MAX_BYTES) {
          skip(filename, `${bytes.length}B over the size cap`);
          continue;
        }

        // Reuse the knowledge module's extractor (PDF -> pdf-parse, DOCX ->
        // mammoth, else utf8).
        const raw = await extractText(
          bytes,
          isPdf
            ? 'application/pdf'
            : isDocx
              ? 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
              : 'text/plain',
          filename,
        );
        const text = (raw ?? '').trim().slice(0, GMAIL_ATTACHMENT_MAX_CHARS);
        if (!text) {
          skip(filename, 'no extractable text (possibly a scanned/image-only file)');
          continue;
        }
        texts.push(`# ${filename}\n${text}`);
        attachments.push({ filename, chars: text.length });
      } catch (err) {
        skip(
          filename,
          `parse error: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }
    return { cv: texts.length > 0 ? texts.join('\n\n') : null, attachments };
  }

  /** Download one attachment (base64url) and decode to a Buffer, or null. */
  private async downloadAttachment(
    token: string,
    messageId: string,
    attachmentId: string,
  ): Promise<Buffer | null> {
    const att = await this.gapi<{ data?: string; size?: number }>(
      token,
      `/messages/${messageId}/attachments/${attachmentId}`,
    );
    if (!att) {
      return null;
    }
    return decodeB64Url(att.data);
  }

  /** GET a Gmail API path with the bearer token; parsed JSON or null on error. */
  private async gapi<T>(token: string, path: string): Promise<T | null> {
    const res = await this.gapiRaw(token, path);
    // A 401 with a freshly-resolved token means the grant is bad/revoked — raise
    // it so poll() can disconnect the connector rather than silently no-op and
    // re-poll (and re-401) forever.
    if (res.status === 401) {
      throw new Error('gmail_unauthorized');
    }
    if (res.status < 200 || res.status >= 300) {
      this.logger.warn(`Gmail API ${path} → HTTP ${res.status}`);
      return null;
    }
    return res.body as T | null;
  }

  /** Low-level GET with a bounded timeout; returns { status, body } (never throws to caller of poll). */
  private async gapiRaw(
    token: string,
    path: string,
  ): Promise<{ status: number; body: unknown }> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 10_000);
    try {
      const res = asFetchResponse(
        await fetch(`${GMAIL_BASE}${path}`, {
          method: 'GET',
          headers: { authorization: `Bearer ${token}`, accept: 'application/json' },
          signal: controller.signal,
        }),
      );
      let body: unknown = null;
      try {
        body = await res.json();
      } catch {
        body = null;
      }
      return { status: res.status, body };
    } finally {
      clearTimeout(timer);
    }
  }
}
