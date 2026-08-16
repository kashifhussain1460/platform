import { Injectable, Logger } from '@nestjs/common';
import { Prisma, type CanonicalEvent, type InstalledSkill } from '@prisma/client';
import { PrismaService } from '../../../common/prisma/prisma.service';
import { CryptoService } from '../../../common/crypto/crypto.service';
import { readCredentials } from '../../skills/connectors/credentials.util';
import { ConnectorHealthService } from '../../skills/connectors/connector-health.service';
import {
  formatImapCursor,
  parseImapCursor,
  resolveImapSettings,
  withImap,
  type ImapSettings,
} from '../../skills/providers/imap.util';
// Type-only: erased at compile time, so imapflow stays LAZY-loaded at runtime
// (the mock/offline path must never pull it in).
import type { FetchMessageObject, ImapFlow } from 'imapflow';
import { WorkflowsService } from '../../workflows/workflows.service';
import { mapRawEvent } from '../normalization/event-mapper';
import {
  extractInboundAttachments,
  type InboundAttachment,
} from './attachment-extraction';
import { IMAP_INBOUND_BATCH, IMAP_MAX_BODY_CHARS } from '../events.constants';

/** Prisma Json helper: JS null → the DB JSON-null sentinel. */
function toJson(value: unknown): Prisma.InputJsonValue | typeof Prisma.JsonNull {
  return value == null ? Prisma.JsonNull : (value as Prisma.InputJsonValue);
}

/** Inbound email event types — a mailbox is only polled if a workflow wants one. */
const EMAIL_EVENT_TYPES = ['NEW_EMAIL', 'NEW_EMAIL_REPLY'] as const;

export interface ImapPollResult {
  baseline: boolean;
  newMessages: number;
  firedRuns: number;
  noop?: boolean;
  /** The folder was renumbered (UIDVALIDITY changed) and we re-baselined. */
  rebaselined?: boolean;
}

/**
 * The flattened message the mapper consumes. Deliberately the SAME shape the
 * Gmail driver produces, so `mapInboundEmail` maps both and a workflow reading
 * `{{trigger.subject}}` cannot tell which transport delivered the mail.
 */
interface InboundEmail {
  messageId: string;
  from: string | null;
  subject: string | null;
  snippet: string | null;
  date: string | null;
  body: string | null;
  cv: string | null;
  attachments: InboundAttachment[];
  isReply: boolean;
  looksLikeApplication: boolean;
}

const APPLICATION_KEYWORDS_RE =
  /\b(resume|cv|curriculum vitae|application|applying|candidate|hiring|job opening|position|vacancy)\b/i;

/**
 * True when a poll error means this connector can NEVER succeed as-is:
 * credentials that won't decrypt, or a server that rejects the login. Such a
 * connector is taken OUT of the sweep instead of retrying every cycle — which
 * matters far more on IMAP than on an HTTP API, because many mail hosts
 * temporarily ban an IP after a handful of failed logins, and a poller retrying
 * a wrong password every minute will lock the customer out of their own mailbox.
 */
function isUnrecoverableAuthError(message: string): boolean {
  return /unable to authenticate data|unsupported state|bad decrypt|invalid credentials|authentication failed|auth.*fail|login.*(failed|denied)|\[AUTHENTICATIONFAILED\]/i.test(
    message,
  );
}

/**
 * ImapInboundService — inbound email for a mailbox connected over SMTP/IMAP
 * (the `email` skill), i.e. a company's OWN mail server.
 *
 * It is a deliberate mirror of {@link GmailInboundService}: same baseline/delta
 * shape, same RawEvent → CanonicalEvent → fireEvent pipeline, same consumer
 * guardrail, same health handling. §31 is explicit that no provider may create
 * a parallel workflow execution path, so this driver's only job is to turn IMAP
 * messages into the same canonical events Gmail already produces — everything
 * downstream (trigger matching, the durable runtime, audit) is untouched.
 *
 * poll(connector):
 *   - BASELINE (no cursor): record the folder's current highest UID and fire
 *     NOTHING, so connecting a mailbox does not replay years of history into
 *     the workflow engine.
 *   - DELTA: fetch UIDs above the cursor, ingest each, advance the cursor.
 *
 * Idempotent end to end: RawEvent is unique on (connectorId, externalId) and
 * CanonicalEvent on (companyId, dedupeKey=`imap:msg:<id>`), and a run fires ONLY
 * for a freshly-created canonical event — so a re-poll never double-fires.
 * Never throws: any error is logged and becomes a no-op, so it cannot crash the
 * scheduler.
 */
@Injectable()
export class ImapInboundService {
  private readonly logger = new Logger(ImapInboundService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly crypto: CryptoService,
    private readonly health: ConnectorHealthService,
    private readonly workflows: WorkflowsService,
  ) {}

  /** Settings for one connector, or null when inbound is not configured. */
  private settingsFor(connector: InstalledSkill): ImapSettings | null {
    return resolveImapSettings({
      creds: readCredentials(this.crypto, connector.credentials),
      config: (connector.config as Record<string, unknown> | null) ?? {},
    });
  }

  /** Poll ONE email connector. Never throws. */
  async poll(connector: InstalledSkill): Promise<ImapPollResult> {
    if (connector.skillKey !== 'email') {
      return { baseline: false, newMessages: 0, firedRuns: 0, noop: true };
    }
    let settings: ImapSettings | null = null;
    try {
      settings = this.settingsFor(connector);
    } catch (err) {
      // Credentials that will not decrypt — the connector is unusable.
      const message = err instanceof Error ? err.message : String(err);
      await this.quarantine(connector, message);
      return { baseline: false, newMessages: 0, firedRuns: 0, noop: true };
    }
    if (!settings) {
      // Send-only mailbox. Normal, not an error.
      return { baseline: false, newMessages: 0, firedRuns: 0, noop: true };
    }

    try {
      return await withImap(settings, async (client) => {
        // readOnly: polling must never mark the customer's unread mail as read.
        // Orlixa is a listener on this mailbox, not its owner — a human may be
        // reading the same inbox and would find messages mysteriously opened.
        const lock = await client.getMailboxLock(settings!.folder, { readOnly: true });
        try {
          const box = client.mailbox;
          if (typeof box !== 'object') {
            return { baseline: false, newMessages: 0, firedRuns: 0, noop: true };
          }
          const uidValidity = String(box.uidValidity);
          const cursor = parseImapCursor(connector.inboundCursor);

          // No cursor, or the folder was renumbered → re-baseline. A UID is only
          // meaningful within one UIDVALIDITY generation; comparing across a
          // renumber would silently stop the mailbox firing for ever.
          if (!cursor || cursor.uidValidity !== uidValidity) {
            const rebaselined = Boolean(cursor);
            await this.baseline(connector, uidValidity, client);
            return {
              baseline: !rebaselined,
              rebaselined,
              newMessages: 0,
              firedRuns: 0,
            };
          }

          return await this.delta(connector, client, settings!, cursor.lastUid, uidValidity);
        } finally {
          lock.release();
        }
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (isUnrecoverableAuthError(message)) {
        await this.quarantine(connector, message);
      } else {
        this.logger.error(`IMAP poll failed for connector ${connector.id}: ${message}`);
      }
      return { baseline: false, newMessages: 0, firedRuns: 0, noop: true };
    }
  }

  /** Take a doomed connector out of the sweep and ask for a reconnect. */
  private async quarantine(connector: InstalledSkill, reason: string): Promise<void> {
    this.logger.warn(
      `IMAP connector ${connector.id} can't authenticate (${reason}) — marking DISCONNECTED; reconnect required.`,
    );
    await this.health
      .markDisconnected(
        connector.id,
        'Mailbox credentials rejected or unreadable — reconnect required',
      )
      .catch(() => undefined);
  }

  /** Record the current high-water UID and fire nothing. */
  private async baseline(
    connector: InstalledSkill,
    uidValidity: string,
    client: ImapFlow,
  ): Promise<void> {
    let highest = 0;
    // `uid: true` + a wide range asks the server for UIDs, not sequence numbers.
    for await (const msg of client.fetch('1:*', { uid: true }, { uid: true })) {
      if (msg.uid > highest) highest = msg.uid;
    }
    await this.prisma.installedSkill.update({
      where: { id: connector.id },
      data: { inboundCursor: formatImapCursor({ uidValidity, lastUid: highest }) },
    });
    this.logger.log(
      `IMAP inbound baselined connector ${connector.id} at uid ${highest} (uidvalidity ${uidValidity})`,
    );
  }

  /** Ingest everything above the cursor, then advance it. */
  private async delta(
    connector: InstalledSkill,
    client: ImapFlow,
    settings: ImapSettings,
    lastUid: number,
    uidValidity: string,
  ): Promise<ImapPollResult> {
    let newMessages = 0;
    let firedRuns = 0;
    let highest = lastUid;
    let processed = 0;

    for await (const msg of client.fetch(
      `${lastUid + 1}:*`,
      { uid: true, envelope: true, source: true },
      { uid: true },
    )) {
      // A `from:to:*` range always returns at least one message even when the
      // mailbox has nothing newer (the server clamps to the last message), so
      // anything at or below the cursor is skipped rather than re-ingested.
      if (msg.uid <= lastUid) continue;
      if (msg.uid > highest) highest = msg.uid;

      // Bounded per sweep so one busy mailbox cannot monopolise the worker;
      // the cursor advances to what we processed, so the rest arrives next pass.
      if (processed >= IMAP_INBOUND_BATCH) break;
      processed += 1;

      const email = await this.toInboundEmail(msg, settings);
      if (!email) continue;
      const res = await this.ingest(connector, email);
      if (res.created) {
        newMessages += 1;
        firedRuns += res.firedRuns;
      }
    }

    if (highest !== lastUid) {
      await this.prisma.installedSkill.update({
        where: { id: connector.id },
        data: { inboundCursor: formatImapCursor({ uidValidity, lastUid: highest }) },
      });
    }
    return { baseline: false, newMessages, firedRuns };
  }

  /** Flatten an IMAP message into the shared inbound-email shape. */
  /**
   * Flatten an IMAP message into the shared inbound-email shape, doing a REAL
   * MIME parse.
   *
   * `mailparser` (same author as nodemailer and imapflow) handles what a
   * hand-rolled parser gets wrong and gets wrong SILENTLY: nested multiparts
   * (`multipart/mixed` wrapping `multipart/alternative`), quoted-printable and
   * base64 transfer encodings, non-UTF-8 charsets, RFC 2047 encoded headers
   * (`=?UTF-8?B?...?=` subjects), and inline vs attached dispositions.
   *
   * That matters here more than anywhere else in the product: a candidate's CV
   * arrives as a base64 part inside a multipart body. Reading it wrong does not
   * throw — it produces a plausible-looking empty or mangled `cv`, and the HR
   * workflow then scores a real person on nothing.
   */
  private async toInboundEmail(
    msg: FetchMessageObject,
    settings: ImapSettings,
  ): Promise<InboundEmail | null> {
    if (!msg.source) return null;

    // Lazy import for the same reason as imapflow/nodemailer: the mock/offline
    // path must never load it.
    const { simpleParser } = (await import('mailparser')) as typeof import('mailparser');
    const parsed = await simpleParser(msg.source);

    // A stable id: the RFC822 Message-ID when present (it survives a mailbox
    // move), else the mailbox-scoped UID, unique within a UIDVALIDITY.
    const messageId =
      parsed.messageId ??
      (msg.envelope?.messageId ? String(msg.envelope.messageId) : null) ??
      `${settings.host}/${settings.folder}/${msg.uid}`;

    const fromAddress = parsed.from?.value?.[0]?.address ?? null;
    const subject = parsed.subject ?? null;

    // Prefer the text/plain part; fall back to the HTML one stripped to text.
    // `parsed.text` is already decoded and charset-corrected by mailparser.
    const bodyRaw =
      (parsed.text && parsed.text.trim()) ||
      (typeof parsed.html === 'string' ? stripHtml(parsed.html) : '') ||
      '';
    const body = bodyRaw ? capBody(bodyRaw) : null;

    // A reply carries In-Reply-To/References. Same rule as the Gmail driver, so
    // a candidate replying to their own rejection is never re-scored as a fresh
    // application unless a workflow opts in to NEW_EMAIL_REPLY.
    const isReply = Boolean(
      parsed.inReplyTo ||
        (Array.isArray(parsed.references)
          ? parsed.references.length > 0
          : Boolean(parsed.references)),
    );

    const { cv, attachments } = await extractInboundAttachments(
      (parsed.attachments ?? [])
        // Drop signature/logo images. They are `related` parts (referenced by
        // cid from the HTML body) or inline images — never documents. Keeping
        // them would fill every candidate's record with
        // "logo.png skipped: unsupported file type" noise and, worse, make
        // `looksLikeApplication` true for any email with a signature image.
        //
        // An inline part that is NOT an image is still considered: some clients
        // send a real PDF with an inline disposition.
        .filter(
          (att) =>
            !att.related &&
            !(
              att.contentDisposition === 'inline' &&
              (att.contentType ?? '').toLowerCase().startsWith('image/')
            ),
        )
        .map((att) => ({
          filename: att.filename ?? 'attachment',
          mimeType: att.contentType,
          declaredSize: att.size,
          // Already in memory — mailparser decoded it during the parse.
          load: async () => (Buffer.isBuffer(att.content) ? att.content : null),
        })),
      this.logger,
      'IMAP',
    );

    return {
      messageId,
      from: fromAddress ? fromAddress.toLowerCase() : null,
      subject,
      snippet: body ? body.slice(0, 200) : null,
      date: parsed.date ? parsed.date.toISOString() : null,
      body,
      cv,
      attachments,
      isReply,
      // A parsed attachment is itself the strongest signal, matching Gmail.
      looksLikeApplication:
        attachments.some((a) => !a.skipped) ||
        APPLICATION_KEYWORDS_RE.test(`${subject ?? ''} ${body ?? ''}`),
    };
  }

  /**
   * RawEvent → CanonicalEvent → fireEvent. A verbatim mirror of the Gmail
   * driver's `ingestInbound`, including its idempotency: the run fires ONLY for
   * a freshly-created canonical event.
   */
  private async ingest(
    connector: InstalledSkill,
    email: InboundEmail,
  ): Promise<{ created: boolean; firedRuns: number }> {
    const raw = await this.upsertRawEvent(connector, email);
    const mapping = mapRawEvent({
      provider: 'imap',
      externalId: email.messageId,
      headers: null,
      payload: email as unknown as Record<string, unknown>,
    });

    let canonical: CanonicalEvent | null = await this.prisma.canonicalEvent.findUnique({
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
            provider: 'imap',
            type: mapping.type,
            dedupeKey: mapping.dedupeKey,
            occurredAt: mapping.occurredAt,
            subject: toJson(mapping.subject),
            data: toJson(mapping.data),
          },
        });
        created = true;
      } catch (err) {
        if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
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

    if (!created || !canonical) {
      return { created: false, firedRuns: 0 };
    }

    try {
      // A reply fires a DISTINCT event type, exactly as the Gmail driver does,
      // so a candidate replying to their own rejection is never re-scored as a
      // fresh application unless a workflow opts in to NEW_EMAIL_REPLY.
      const eventType = email.isReply ? 'NEW_EMAIL_REPLY' : canonical.type;
      const data = (canonical.data ?? {}) as Record<string, unknown>;
      const result = await this.workflows.fireEvent(
        connector.companyId,
        eventType,
        {
          // Flattened to the top level so `{{trigger.subject}}` resolves, with
          // `data` kept so `{{trigger.data.*}}` keeps working too.
          ...data,
          eventId: canonical.id,
          data,
        },
        connector.id,
      );
      return { created: true, firedRuns: result.count };
    } catch (err) {
      this.logger.error(
        `IMAP inbound fireEvent failed for connector ${connector.id}: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
      return { created: true, firedRuns: 0 };
    }
  }

  private async upsertRawEvent(connector: InstalledSkill, email: InboundEmail) {
    const where = {
      connectorId_externalId: {
        connectorId: connector.id,
        externalId: email.messageId,
      },
    };
    const existing = await this.prisma.rawEvent.findUnique({ where });
    if (existing) return existing;
    try {
      return await this.prisma.rawEvent.create({
        data: {
          companyId: connector.companyId,
          connectorId: connector.id,
          provider: 'imap',
          externalId: email.messageId,
          // It came from our own authenticated IMAP session — treat as verified.
          signatureVerified: true,
          headers: {},
          payload: email as unknown as Prisma.InputJsonObject,
          status: 'RECEIVED',
        },
      });
    } catch (err) {
      if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
        return this.prisma.rawEvent.findUnique({ where });
      }
      throw err;
    }
  }

  /**
   * Scheduled sweep, with the SAME guardrail as the Gmail sweep: a mailbox is
   * only opened when some ACTIVE workflow actually consumes inbound email.
   *
   * This matters more here than on an HTTP API. Opening an IMAP session against
   * a customer's mail server every minute for nothing burns their connection
   * limit and shows up in their security logs as a login from an unfamiliar
   * host. If nothing is listening, Orlixa must not touch the mailbox at all.
   */
  async sweep(): Promise<{ polled: number; newMessages: number; firedRuns: number }> {
    const consumers = await this.prisma.workflow.findMany({
      where: {
        status: 'ACTIVE',
        triggerType: 'EVENT',
        OR: EMAIL_EVENT_TYPES.map((eventType) => ({
          triggerConfig: { path: ['eventType'], equals: eventType },
        })),
      },
      select: { companyId: true, triggerConfig: true },
    });
    if (consumers.length === 0) {
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
        skillKey: 'email',
        connectionStatus: 'CONNECTED',
        enabled: true,
        companyId: { in: companyIds },
      },
      take: IMAP_INBOUND_BATCH,
    });
    const connectors = candidates.filter(
      (c) => companiesWithUnscoped.has(c.companyId) || pinnedConnectorIds.has(c.id),
    );

    let polled = 0;
    let newMessages = 0;
    let firedRuns = 0;
    for (const connector of connectors) {
      const res = await this.poll(connector);
      if (res.noop) continue;
      polled += 1;
      newMessages += res.newMessages;
      firedRuns += res.firedRuns;
    }
    return { polled, newMessages, firedRuns };
  }
}


// --- local helpers ----------------------------------------------------------

/** Cap the stored body so one enormous email cannot bloat the trigger payload. */
function capBody(text: string): string {
  const trimmed = text
    .replace(/\r\n/g, '\n')
    // Collapse the runs of blank lines quoted replies leave behind.
    .replace(/\n{3,}/g, '\n\n')
    .trim();
  return trimmed.length > IMAP_MAX_BODY_CHARS
    ? `${trimmed.slice(0, IMAP_MAX_BODY_CHARS)}\n…[truncated]`
    : trimmed;
}

/**
 * Strip HTML to plain-ish text. Only used when a message has NO text/plain
 * part — mailparser has already decoded charsets and transfer encodings by
 * then, so this only has to remove markup.
 */
function stripHtml(html: string): string {
  return html
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    // Keep the line structure a reader (and an AI step) depends on.
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|tr|li|h[1-6])>/gi, '\n')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/&quot;/gi, '"')
    .replace(/[ \t]+/g, ' ')
    .trim();
}
