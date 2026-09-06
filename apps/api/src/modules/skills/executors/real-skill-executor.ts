import { createHash } from 'node:crypto';
import { Injectable } from '@nestjs/common';
import type { ConfigService } from '@nestjs/config';
import type {
  ExecutorContext,
  SkillExecutor,
  SkillExecutionResult,
} from './skill-executor';
import { assertUrlAllowed } from './ssrf';
import { resolveSmtpSettings } from '../providers/smtp.adapter';
import type { SchedulingService } from '../../scheduling/scheduling.service';
import type { PostizClientService } from '../../engines/marketing/postiz-client.service';
import type { PrismaService } from '../../../common/prisma/prisma.service';
import type { ChatwootClientService } from '../../engines/support/chatwoot-client.service';
import type { CryptoService } from '../../../common/crypto/crypto.service';
import type { PlaneClientService } from '../../engines/pm/plane-client.service';
import type { ToolIdempotencyService } from '../../../common/idempotency/tool-idempotency.service';
import type {
  SuppressionChannel,
  SuppressionService,
} from '../../engines/marketing/suppression.service';
import type { TwilioWhatsappClientService } from '../../engines/whatsapp/twilio-whatsapp-client.service';
import { WHATSAPP_SESSION_WINDOW_MS } from '../../engines/whatsapp/whatsapp.constants';
import { extractRecipients } from '../recipient-extraction';
import {
  asFetchResponse,
  readCappedText,
} from '../../../common/http/fetch-response';

/** Coerce a possibly-unknown credential/arg value to a trimmed string (or ''). */
function str(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

/** True when a credentials object actually carries at least one value. */
function hasCreds(creds: Record<string, unknown> | null | undefined): boolean {
  return Boolean(creds && Object.keys(creds).length > 0);
}


/**
 * WAVE 3 §3.6 — how long an identical publish is treated as a duplicate.
 *
 * Long enough to absorb any realistic retry chain (queue redelivery, a manual
 * re-run after a timeout), short enough that a genuine re-post tomorrow works.
 */
const PUBLISH_DEDUPE_WINDOW_MS = 24 * 60 * 60 * 1000;

/** Stable key for "this exact content, to this exact account". */
function publishIdempotencyKey(socialAccountId: string, content: string): string {
  return `publish:${createHash('sha256')
    // An escaped separator, not a literal NUL byte in source: a separator that
    // cannot appear in an id keeps ("acct-1", "x y") from colliding with
    // ("acct-1 x", "y").
    .update(`${socialAccountId}\0${content}`)
    .digest('hex')}`;
}

/**
 * M-06: schedule_post's own key for ToolIdempotencyService. UNLIKE
 * publishIdempotencyKey above, this includes `publishAt`: two DIFFERENT
 * scheduled times for identical content are legitimately two different
 * posts (publish_now has no time axis to disambiguate on; schedule_post
 * does, and must not collapse "post this at 9am" with "post this at 5pm").
 */
function scheduleIdempotencyKey(
  socialAccountId: string,
  content: string,
  publishAt: string,
): string {
  return createHash('sha256')
    .update(`${socialAccountId}\0${content}\0${publishAt}`)
    .digest('hex');
}

/** Same reasoning as PUBLISH_DEDUPE_WINDOW_MS, but far shorter: a support
 * agent may legitimately send a byte-identical short reply ("Thanks!") to
 * the SAME conversation hours apart — a 24h window would silently swallow a
 * real second reply. 5 minutes is long enough to absorb a retried
 * TOOL_ACTION (queue redelivery, a crash-replay) and short enough not to
 * interfere with genuine agent behavior. */
const CHATWOOT_REPLY_DEDUPE_WINDOW_MS = 5 * 60 * 1000;

function chatwootReplyIdempotencyKey(conversationId: string, content: string): string {
  return createHash('sha256').update(`${conversationId}\0${content}`).digest('hex');
}

/**
 * M-06: `whatsapp.send_message`/`send_template` are real, irreversible,
 * external side effects reaching a real lead's phone — the same risk class
 * `postiz.schedule_post` and `chatwoot.reply_to_conversation` are already in,
 * and the catalog marks both `highRisk: true` for exactly this reason. A
 * retried TOOL_ACTION (queue redelivery, a crash-replay) must not double-send
 * the same WhatsApp message. Short window, same reasoning as Chatwoot's reply
 * dedupe: a sales agent may legitimately send byte-identical follow-up text
 * ("Are you still interested?") to the SAME lead hours/days apart, which a
 * long (e.g. 24h) window would silently swallow.
 */
const WHATSAPP_SEND_DEDUPE_WINDOW_MS = 5 * 60 * 1000;

function whatsappSendMessageIdempotencyKey(leadId: string, content: string): string {
  return createHash('sha256').update(`${leadId}\0${content}`).digest('hex');
}

/** Canonicalizes `params` (key order is not guaranteed stable) so the same
 * template+variables always hashes to the same key. */
function whatsappSendTemplateIdempotencyKey(
  leadId: string,
  templateId: string,
  params: Record<string, string>,
): string {
  const stableParams = Object.keys(params)
    .sort()
    .map((k) => `${k}=${params[k]}`)
    .join('&');
  return createHash('sha256')
    .update(`${leadId}\0${templateId}\0${stableParams}`)
    .digest('hex');
}

/** Hard ceiling on a body the http skill will hold in memory. */
const MAX_HTTP_BODY_BYTES = 10_000;

/**
 * fetch() with an abort timeout so a hung backend can't stall the runtime. The
 * init type is derived from the global fetch (no reliance on a DOM `RequestInit`
 * name — tsconfig lib is ES2022 with @types/node globals).
 */
async function fetchWithTimeout(
  url: string,
  init: Parameters<typeof fetch>[1],
  timeoutMs = 10_000,
) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return asFetchResponse(await fetch(url, { ...init, signal: controller.signal }));
  } finally {
    clearTimeout(timer);
  }
}

/**
 * REAL skill executor (`SKILL_EXECUTOR=real`, or chosen per-call by the `auto`
 * dispatcher). Dispatches by skillKey using the tenant's DECRYPTED credentials +
 * config that SkillsService resolves into `ctx` (never logged). Implements real
 * network calls for slack/http/gmail/calendar/gdrive, plus the internal
 * scheduling.claim_slot (no external credentials — see SchedulingService);
 * anything else — or a call with no credentials — DELEGATES to the injected
 * `fallback` (the mock executor) so a missing connection degrades gracefully
 * instead of 500-ing.
 *
 * Returns the SAME `{ ok, result?, error? }` shape as MockSkillExecutor and never
 * throws (tool-level failures come back as `{ ok:false, error }`).
 *
 * ## Phase 1 — `failClosed` and the `default:` branch
 *
 * `stripe`, `github`, `hubspot` and `jira` have catalog entries and no `case`
 * below; two of them (hubspot, jira) have working OAuth. Before this change a
 * customer could authorise a live HubSpot account, see CONNECTED, run
 * "create contact" and get `ok: true` with nothing having reached HubSpot —
 * and `stripe.create_payment_link` is `highRisk`, so a human was asked to
 * approve a payment link that was then fabricated.
 *
 * In production (`failClosed`) the `default:` branch now REFUSES instead of
 * delegating to the mock. Outside production it still degrades to the sandbox,
 * because that is what keeps the e2e suite and local development offline and
 * deterministic — and that split is exactly what `SkillDefinitionDto.
 * executionSupport` exposes to the UI so nobody has to guess which mode they
 * are in.
 *
 * Still TODO (unchanged by this phase): real executors for
 * stripe/github/hubspot/jira; OAuth access-token refresh when `expiresAt` has
 * passed (currently the stored token is used as-is and a 401 surfaces as a
 * tool error).
 */
@Injectable()
export class RealSkillExecutor implements SkillExecutor {
  readonly name = 'real';
  readonly usesInstalledCredentials = true;

  constructor(
    private readonly config: ConfigService,
    /** Offline fallback (the mock executor) for unimplemented/unconnected calls. */
    private readonly fallback: SkillExecutor,
    /** Interview-slot claim primitive for the 'scheduling' skill (no OAuth/API key). */
    private readonly scheduling: SchedulingService,
    /** Postiz REST wrapper for the 'postiz' marketing skill (shared API key, no per-tenant creds). */
    private readonly postizClient: PostizClientService,
    /** Direct Prisma access for SocialAccount/ScheduledPost rows (postiz.* tools). */
    private readonly prisma: PrismaService,
    /** Chatwoot REST wrapper for the 'chatwoot' support skill (per-company agent bot token). */
    private readonly chatwootClient: ChatwootClientService,
    /** Decrypts the per-company ChatwootAccount.agentBotToken before use. */
    private readonly crypto: CryptoService,
    /** Plane REST wrapper for the 'plane' project-management skill (per-company encrypted API token). */
    private readonly planeClient: PlaneClientService,
    /** M-06: generic record-before-effect primitive for external side effects. */
    private readonly idempotency: ToolIdempotencyService,
    /** M-08: real consent/suppression lookups for the 'marketing' compliance skill. */
    private readonly suppression: SuppressionService,
    /**
     * Production: refuse an unimplemented tool rather than answering it from
     * the sandbox. Defaults false so every existing test constructing this
     * class directly keeps today's offline behaviour.
     */
    private readonly failClosed = false,
    /** Twilio WhatsApp REST wrapper for the 'whatsapp' sales skill (per-company encrypted credentials). */
    private readonly whatsappClient: TwilioWhatsappClientService,
  ) {}

  async execute(
    skillKey: string,
    tool: string,
    args: Record<string, unknown>,
    ctx: ExecutorContext,
  ): Promise<SkillExecutionResult> {
    try {
      switch (`${skillKey}.${tool}`) {
        case 'slack.send_message':
          return await this.slackSendMessage(args, ctx);
        case 'http.request':
          return await this.httpRequest(args);
        case 'gmail.send_email':
          return await this.gmailSendEmail(args, ctx);
        case 'email.send_email':
          return await this.emailSendSmtp(args, ctx);
        case 'calendar.create_event':
          return await this.calendarCreateEvent(args, ctx);
        case 'gdrive.upload_file':
          return await this.gdriveUploadFile(args, ctx);
        case 'gdrive.create_folder':
          return await this.gdriveCreateFolder(args, ctx);
        case 'gdrive.move_file':
          return await this.gdriveMoveFile(args, ctx);
        case 'gdrive.list_files':
          return await this.gdriveListFiles(args, ctx);
        case 'gdrive.read_file':
          return await this.gdriveReadFile(args, ctx);
        case 'scheduling.claim_slot':
          return await this.schedulingClaimSlot(args, ctx);
        case 'scheduling.reschedule_slot':
          return await this.schedulingRescheduleSlot(args, ctx);
        case 'postiz.list_connected_accounts':
          return await this.postizListConnectedAccounts(ctx);
        case 'postiz.start_connect_account':
          return await this.postizStartConnectAccount(args);
        case 'postiz.schedule_post':
          return await this.postizSchedulePost(args, ctx);
        case 'postiz.publish_now':
          return await this.postizPublishNow(args, ctx);
        case 'postiz.get_post_status':
          return await this.postizGetPostStatus(args, ctx);
        case 'postiz.get_post_analytics':
          return await this.postizGetPostAnalytics(args, ctx);
        case 'chatwoot.list_open_conversations':
          return await this.chatwootListOpenConversations(ctx);
        case 'chatwoot.get_conversation':
          return await this.chatwootGetConversation(args, ctx);
        case 'chatwoot.reply_to_conversation':
          return await this.chatwootReplyToConversation(args, ctx);
        case 'chatwoot.resolve_conversation':
          return await this.chatwootResolveConversation(args, ctx);
        case 'plane.list_issues':
          return await this.planeListIssues(args, ctx);
        case 'plane.create_issue':
          return await this.planeCreateIssue(args, ctx);
        case 'plane.update_issue_status':
          return await this.planeUpdateIssueStatus(args, ctx);
        case 'marketing.check_consent':
          return await this.marketingCheckConsent(args, ctx);
        case 'whatsapp.send_message':
          return await this.whatsappSendMessage(args, ctx);
        case 'whatsapp.send_template':
          return await this.whatsappSendTemplate(args, ctx);
        case 'whatsapp.get_conversation':
          return await this.whatsappGetConversation(args, ctx);
        default:
          // No real implementation for this tool. In production that must be
          // said out loud, not answered from the sandbox (see the class doc).
          if (this.failClosed) {
            return {
              ok: false,
              error:
                `${skillKey}.${tool} has no real integration in this build — it can only be ` +
                'simulated, so it was NOT executed. Nothing was sent to ' +
                `${skillKey}. Remove this action from the workflow, or use a ` +
                'skill that supports real execution.',
            };
          }
          return this.fallback.execute(skillKey, tool, args, ctx);
      }
    } catch (err) {
      return {
        ok: false,
        error: err instanceof Error ? err.message : 'Tool execution failed',
      };
    }
  }

  // --- slack.send_message ---------------------------------------------------
  // Supports EITHER an incoming-webhook URL OR a bot token (chat.postMessage).
  private async slackSendMessage(
    args: Record<string, unknown>,
    ctx: ExecutorContext,
  ): Promise<SkillExecutionResult> {
    const creds = ctx.credentials ?? {};
    const config = ctx.config ?? {};
    if (!hasCreds(creds)) {
      return this.fallback.execute('slack', 'send_message', args, ctx);
    }
    const text = str(args.text);
    const channel = str(args.channel) || str(config.defaultChannel);
    const webhookUrl =
      str(creds.webhookUrl) || str(creds.incomingWebhookUrl) || str(creds.url);
    const botToken =
      str(creds.botToken) || str(creds.token) || str(creds.accessToken);

    if (webhookUrl) {
      const res = await fetchWithTimeout(webhookUrl, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(channel ? { text, channel } : { text }),
      });
      const body = await res.text();
      if (!res.ok) {
        return { ok: false, error: `Slack webhook failed (${res.status}): ${body}` };
      }
      return { ok: true, result: { delivered: true, via: 'webhook', channel } };
    }

    if (botToken) {
      if (!channel) {
        return { ok: false, error: 'Slack chat.postMessage requires a channel' };
      }
      // Modern Slack apps (granular OAuth scopes) reject chat.postMessage when
      // `channel` is a human name like "#general" — it must be a channel ID
      // (e.g. "C0123ABCD"). Resolve a name to its id first (requires the
      // channels:read bot scope); pass IDs straight through.
      let channelId = channel;
      if (!/^[CG][A-Z0-9]{8,}$/.test(channel)) {
        const resolved = await this.resolveSlackChannelId(botToken, channel);
        if (!resolved.id) {
          return {
            ok: false,
            error: `Slack channel "${channel}" not found (${resolved.reason}).`,
          };
        }
        channelId = resolved.id;
      }
      const res = await fetchWithTimeout('https://slack.com/api/chat.postMessage', {
        method: 'POST',
        headers: {
          authorization: `Bearer ${botToken}`,
          'content-type': 'application/json; charset=utf-8',
        },
        body: JSON.stringify({ channel: channelId, text }),
      });
      const data = (await res.json()) as { ok: boolean; error?: string; ts?: string; channel?: string };
      if (!data.ok) {
        return { ok: false, error: `Slack API error: ${data.error ?? 'unknown'}` };
      }
      return { ok: true, result: { delivered: true, via: 'chat.postMessage', ts: data.ts, channel: data.channel } };
    }

    return {
      ok: false,
      error: 'Slack not connected: expected a webhookUrl or botToken credential',
    };
  }

  /** Look up a public channel's id by name (strips a leading '#'). */
  private async resolveSlackChannelId(
    botToken: string,
    name: string,
  ): Promise<{ id: string | null; reason: string }> {
    const target = name.replace(/^#/, '').toLowerCase();
    let cursor = '';
    const seen: string[] = [];
    for (let page = 0; page < 5; page += 1) {
      // public_channel only: matches the channels:read scope we actually
      // request. Asking for private_channel too without groups:read makes
      // Slack reject the WHOLE call as missing_scope, not just omit private ones.
      const params = new URLSearchParams({
        types: 'public_channel',
        limit: '200',
        exclude_archived: 'true',
      });
      if (cursor) params.set('cursor', cursor);
      const res = await fetchWithTimeout(
        `https://slack.com/api/conversations.list?${params.toString()}`,
        { headers: { authorization: `Bearer ${botToken}` } },
      );
      const data = (await res.json()) as {
        ok: boolean;
        error?: string;
        channels?: Array<{ id: string; name: string }>;
        response_metadata?: { next_cursor?: string };
      };
      if (!data.ok) {
        return { id: null, reason: `conversations.list failed: ${data.error ?? 'unknown'}` };
      }
      
      for (const c of data.channels ?? []) seen.push(c.name);
      const match = data.channels?.find((c) => c.name.toLowerCase() === target);
      if (match) {
        return { id: match.id, reason: 'ok' };
      }
      cursor = data.response_metadata?.next_cursor ?? '';
      if (!cursor) break;
    }
    return {
      id: null,
      reason: `not among the ${seen.length} channels visible to the bot: ${seen.slice(0, 20).join(', ')}${seen.length > 20 ? ', …' : ''}`,
    };
  }

  // --- http.request (SSRF-guarded real fetch) -------------------------------
  private async httpRequest(
    args: Record<string, unknown>,
  ): Promise<SkillExecutionResult> {
    const allowPrivate =
      (this.config.get<string>('HTTP_SKILL_ALLOW_PRIVATE') ?? '').toLowerCase() ===
      'true';
    const method = (str(args.method) || 'GET').toUpperCase();
    const rawUrl = str(args.url);
    if (!rawUrl) {
      return { ok: false, error: 'http.request requires a url' };
    }
    // Throws (→ caught by execute) for blocked schemes/hosts/private addresses.
    const url = await assertUrlAllowed(rawUrl, allowPrivate);

    const hasBody = args.body !== undefined && method !== 'GET' && method !== 'HEAD';
    const res = await fetchWithTimeout(url.toString(), {
      method,
      // Do NOT auto-follow redirects — a 3xx could point at an internal host.
      redirect: 'manual',
      headers: hasBody ? { 'content-type': 'application/json' } : undefined,
      body: hasBody ? String(args.body) : undefined,
    });
    // WAVE 2 §2.6 — capped WHILE READING. Slicing after `res.text()` has already
    // buffered the whole body, so an endless or gigabyte response would OOM the
    // worker before the truncation ran.
    const { text: raw, truncated } = await readCappedText(res, MAX_HTTP_BODY_BYTES);
    const body = truncated ? `${raw}…[truncated]` : raw;
    return {
      ok: true,
      result: {
        status: res.status,
        ok: res.ok,
        headers: { 'content-type': res.headers.get('content-type') },
        body,
      },
    };
  }

  /**
   * `email.send_email` — the company's OWN mailbox, over SMTP.
   *
   * THIS DID NOT EXIST. `email.send_email` had no case in this switch, so it hit
   * the `default:` branch and was answered by the MOCK executor — in production,
   * with `SKILL_EXECUTOR=real`, reporting `ok: true` for a message nothing ever
   * sent. A connector could be "connected", a workflow could report success, and
   * no email existed. That is the worst shape a skill gap can take, because
   * every surface agrees it worked.
   *
   * Falls back to the mock only when the connector genuinely has no SMTP
   * settings (offline dev, a half-finished setup) — never to paper over a real
   * send failure, which is returned as `ok: false` so the runtime can classify
   * and the run can fail honestly.
   */
  private async emailSendSmtp(
    args: Record<string, unknown>,
    ctx: ExecutorContext,
  ): Promise<SkillExecutionResult> {
    const settings = resolveSmtpSettings({
      creds: ctx.credentials ?? {},
      config: ctx.config ?? {},
    });
    if (!settings) {
      return this.fallback.execute('email', 'send_email', args, ctx);
    }

    const to = str(args.to);
    if (!to) {
      return { ok: false, error: 'email.send_email requires a "to" address' };
    }
    const subject = str(args.subject);
    const bodyText = typeof args.body === 'string' ? args.body : '';

    // Lazy import, exactly as MailService does: the mock/test path must never
    // load nodemailer.
    const nodemailer = (await import('nodemailer')) as typeof import('nodemailer');
    const transport = nodemailer.createTransport({
      host: settings.host,
      port: settings.port,
      secure: settings.secure,
      requireTLS: settings.requireTLS,
      auth: { user: settings.user, pass: settings.password },
      connectionTimeout: 10_000,
      greetingTimeout: 10_000,
      socketTimeout: 20_000,
    });

    try {
      const info = await transport.sendMail({
        from: settings.fromName
          ? `${settings.fromName} <${settings.from}>`
          : settings.from,
        to,
        subject,
        text: bodyText,
      });
      return {
        ok: true,
        result: {
          // `messageId` is the provider's own id for this send — the
          // externalRequestId the audit/reconciliation layer wants (§32).
          messageId: info.messageId,
          accepted: info.accepted,
          rejected: info.rejected,
          from: settings.from,
          to,
        },
      };
    } catch (err) {
      return {
        ok: false,
        error: err instanceof Error ? err.message : 'SMTP send failed',
      };
    } finally {
      transport.close();
    }
  }

  // --- gmail.send_email (Gmail API users.messages.send, OAuth) --------------
  private async gmailSendEmail(
    args: Record<string, unknown>,
    ctx: ExecutorContext,
  ): Promise<SkillExecutionResult> {
    const creds = ctx.credentials ?? {};
    if (!hasCreds(creds)) {
      return this.fallback.execute('gmail', 'send_email', args, ctx);
    }
    const accessToken = str(creds.accessToken) || str(creds.access_token);
    if (!accessToken) {
      return {
        ok: false,
        error: 'Gmail not connected: no OAuth accessToken in credentials',
      };
    }
    const to = str(args.to);
    const subject = str(args.subject);
    const bodyText = typeof args.body === 'string' ? args.body : '';
    const mime = [
      `To: ${to}`,
      `Subject: ${subject}`,
      'Content-Type: text/plain; charset="UTF-8"',
      'MIME-Version: 1.0',
      '',
      bodyText,
    ].join('\r\n');
    const raw = Buffer.from(mime, 'utf8').toString('base64url');

    const res = await fetchWithTimeout(
      'https://gmail.googleapis.com/gmail/v1/users/me/messages/send',
      {
        method: 'POST',
        headers: {
          authorization: `Bearer ${accessToken}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify({ raw }),
      },
    );
    const data = (await res.json()) as {
      id?: string;
      threadId?: string;
      error?: { message?: string };
    };
    if (!res.ok) {
      return {
        ok: false,
        error: `Gmail API error (${res.status}): ${data.error?.message ?? 'send failed'}`,
      };
    }
    return { ok: true, result: { id: data.id, threadId: data.threadId, to } };
  }

  // --- calendar.create_event -------------------------------------------------

  private async calendarCreateEvent(
    args: Record<string, unknown>,
    ctx: ExecutorContext,
  ): Promise<SkillExecutionResult> {
    const creds = ctx.credentials ?? {};
    if (!hasCreds(creds)) {
      return this.fallback.execute('calendar', 'create_event', args, ctx);
    }
    const accessToken = str(creds.accessToken) || str(creds.access_token);
    if (!accessToken) {
      return { ok: false, error: 'Calendar not connected: no OAuth accessToken in credentials' };
    }
    const title = str(args.title);
    const start = str(args.start);
    if (!start) {
      return { ok: false, error: 'Calendar create_event requires a start datetime' };
    }
    // No explicit end → default to a 30-minute event.
    const end = str(args.end) || new Date(new Date(start).getTime() + 30 * 60_000).toISOString();
    const config = ctx.config ?? {};
    const calendarId = str(config.defaultCalendar) || 'primary';
    const timezone = str(config.timezone) || undefined;
    // Opt-in: a real Google Meet link, auto-generated by the Calendar API
    // itself (conferenceData.createRequest) — no separate Meet/Teams
    // integration needed. Used for interview scheduling; other callers
    // (e.g. "mark leave on calendar") don't set this and get a plain event.
    const withMeetLink =
      args.addMeetLink === true || str(args.addMeetLink).toLowerCase() === 'true';

    const params = new URLSearchParams();
    if (withMeetLink) params.set('conferenceDataVersion', '1');
    const url = `https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(calendarId)}/events${params.toString() ? `?${params.toString()}` : ''}`;

    const res = await fetchWithTimeout(url, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${accessToken}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        summary: title,
        start: { dateTime: start, ...(timezone ? { timeZone: timezone } : {}) },
        end: { dateTime: end, ...(timezone ? { timeZone: timezone } : {}) },
        ...(withMeetLink
          ? {
              conferenceData: {
                createRequest: {
                  requestId: `vaep-${Date.now()}-${Math.random().toString(36).slice(2)}`,
                  conferenceSolutionKey: { type: 'hangoutsMeet' },
                },
              },
            }
          : {}),
      }),
    });
    const data = (await res.json()) as {
      id?: string;
      htmlLink?: string;
      conferenceData?: { entryPoints?: Array<{ entryPointType?: string; uri?: string }> };
      error?: { message?: string };
    };
    if (!res.ok) {
      return {
        ok: false,
        error: `Calendar API error (${res.status}): ${data.error?.message ?? 'create_event failed'}`,
      };
    }
    const meetLink = data.conferenceData?.entryPoints?.find(
      (e) => e.entryPointType === 'video',
    )?.uri;
    return {
      ok: true,
      result: { id: data.id, htmlLink: data.htmlLink, meetLink: meetLink ?? null, title, start, end },
    };
  }

  // --- gdrive.* (Drive API v3; drive.file scope — sees only app-created files) --

  /** Bearer token + fallback-to-mock guard shared by every gdrive.* call. */
  private gdriveToken(ctx: ExecutorContext): string | null {
    const creds = ctx.credentials ?? {};
    if (!hasCreds(creds)) return null;
    return str(creds.accessToken) || str(creds.access_token) || null;
  }

  /** Find a Drive folder id by name (optionally under a parent id); null if none. */
  private async findDriveFolderId(
    token: string,
    name: string,
    parentId?: string,
  ): Promise<string | null> {
    const escaped = name.replace(/'/g, "\\'");
    let q = `mimeType='application/vnd.google-apps.folder' and name='${escaped}' and trashed=false`;
    if (parentId) q += ` and '${parentId}' in parents`;
    const res = await fetchWithTimeout(
      `https://www.googleapis.com/drive/v3/files?q=${encodeURIComponent(q)}&fields=files(id,name)`,
      { headers: { authorization: `Bearer ${token}` } },
    );
    const data = (await res.json()) as { files?: Array<{ id: string; name: string }> };
    return data.files?.[0]?.id ?? null;
  }

  /** Find or create a Drive folder by name (optionally nested under a parent name). */
  private async resolveOrCreateFolderId(
    token: string,
    name: string,
    parentName?: string,
  ): Promise<string> {
    let parentId: string | undefined;
    if (parentName) {
      parentId = (await this.findDriveFolderId(token, parentName)) ?? undefined;
      if (!parentId) {
        parentId = await this.createDriveFolder(token, parentName, undefined);
      }
    }
    const existing = await this.findDriveFolderId(token, name, parentId);
    if (existing) return existing;
    return this.createDriveFolder(token, name, parentId);
  }

  private async createDriveFolder(token: string, name: string, parentId?: string): Promise<string> {
    const res = await fetchWithTimeout('https://www.googleapis.com/drive/v3/files', {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify({
        name,
        mimeType: 'application/vnd.google-apps.folder',
        ...(parentId ? { parents: [parentId] } : {}),
      }),
    });
    const data = (await res.json()) as { id?: string; error?: { message?: string } };
    if (!res.ok || !data.id) {
      throw new Error(`Drive create_folder failed: ${data.error?.message ?? res.status}`);
    }
    return data.id;
  }

  /** Find a (non-folder) file id by name; null if none. */
  private async findDriveFileId(token: string, name: string): Promise<string | null> {
    const escaped = name.replace(/'/g, "\\'");
    const q = `name='${escaped}' and trashed=false and mimeType!='application/vnd.google-apps.folder'`;
    const res = await fetchWithTimeout(
      `https://www.googleapis.com/drive/v3/files?q=${encodeURIComponent(q)}&fields=files(id,name,parents)`,
      { headers: { authorization: `Bearer ${token}` } },
    );
    const data = (await res.json()) as { files?: Array<{ id: string }> };
    return data.files?.[0]?.id ?? null;
  }

  private async gdriveUploadFile(
    args: Record<string, unknown>,
    ctx: ExecutorContext,
  ): Promise<SkillExecutionResult> {
    const token = this.gdriveToken(ctx);
    if (!token) return this.fallback.execute('gdrive', 'upload_file', args, ctx);
    const name = str(args.name);
    const content = typeof args.content === 'string' ? args.content : '';
    if (!name) return { ok: false, error: 'Drive upload_file requires a name' };

    const config = ctx.config ?? {};
    const rootFolder = str(config.rootFolder);
    const parentId = rootFolder ? await this.resolveOrCreateFolderId(token, rootFolder) : undefined;

    const boundary = `vaep-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    const metadata = JSON.stringify({ name, ...(parentId ? { parents: [parentId] } : {}) });
    const body =
      `--${boundary}\r\n` +
      `Content-Type: application/json; charset=UTF-8\r\n\r\n${metadata}\r\n` +
      `--${boundary}\r\n` +
      `Content-Type: text/plain; charset=UTF-8\r\n\r\n${content}\r\n` +
      `--${boundary}--`;

    const res = await fetchWithTimeout(
      'https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart&fields=id,name,webViewLink',
      {
        method: 'POST',
        headers: {
          authorization: `Bearer ${token}`,
          'content-type': `multipart/related; boundary=${boundary}`,
        },
        body,
      },
    );
    const data = (await res.json()) as {
      id?: string;
      name?: string;
      webViewLink?: string;
      error?: { message?: string };
    };
    if (!res.ok || !data.id) {
      return { ok: false, error: `Drive upload_file failed: ${data.error?.message ?? res.status}` };
    }
    return { ok: true, result: { id: data.id, name: data.name, webViewLink: data.webViewLink } };
  }

  private async gdriveCreateFolder(
    args: Record<string, unknown>,
    ctx: ExecutorContext,
  ): Promise<SkillExecutionResult> {
    const token = this.gdriveToken(ctx);
    if (!token) return this.fallback.execute('gdrive', 'create_folder', args, ctx);
    const name = str(args.name);
    const parent = str(args.parent);
    if (!name) return { ok: false, error: 'Drive create_folder requires a name' };
    try {
      const id = parent
        ? await this.resolveOrCreateFolderId(token, name, parent)
        : await this.resolveOrCreateFolderId(token, name);
      return { ok: true, result: { id, name, parent: parent || null } };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : 'create_folder failed' };
    }
  }

  private async gdriveMoveFile(
    args: Record<string, unknown>,
    ctx: ExecutorContext,
  ): Promise<SkillExecutionResult> {
    const token = this.gdriveToken(ctx);
    if (!token) return this.fallback.execute('gdrive', 'move_file', args, ctx);
    const name = str(args.name);
    const toFolder = str(args.toFolder);
    if (!name || !toFolder) {
      return { ok: false, error: 'Drive move_file requires name and toFolder' };
    }
    const fileId = await this.findDriveFileId(token, name);
    if (!fileId) {
      return { ok: false, error: `Drive file "${name}" not found (only sees files this app created)` };
    }
    const getRes = await fetchWithTimeout(
      `https://www.googleapis.com/drive/v3/files/${fileId}?fields=parents`,
      { headers: { authorization: `Bearer ${token}` } },
    );
    const getData = (await getRes.json()) as { parents?: string[] };
    const currentParents = (getData.parents ?? []).join(',');

    try {
      const targetId = await this.resolveOrCreateFolderId(token, toFolder);
      const params = new URLSearchParams({ addParents: targetId, fields: 'id,parents' });
      if (currentParents) params.set('removeParents', currentParents);
      const res = await fetchWithTimeout(
        `https://www.googleapis.com/drive/v3/files/${fileId}?${params.toString()}`,
        { method: 'PATCH', headers: { authorization: `Bearer ${token}` } },
      );
      const data = (await res.json()) as { id?: string; error?: { message?: string } };
      if (!res.ok) {
        return { ok: false, error: `Drive move_file failed: ${data.error?.message ?? res.status}` };
      }
      return { ok: true, result: { id: fileId, name, movedTo: toFolder } };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : 'move_file failed' };
    }
  }

  private async gdriveListFiles(
    args: Record<string, unknown>,
    ctx: ExecutorContext,
  ): Promise<SkillExecutionResult> {
    const token = this.gdriveToken(ctx);
    if (!token) return this.fallback.execute('gdrive', 'list_files', args, ctx);
    const folder = str(args.folder);
    let q = "trashed=false and mimeType!='application/vnd.google-apps.folder'";
    if (folder) {
      const folderId = await this.findDriveFolderId(token, folder);
      if (!folderId) return { ok: true, result: { files: [] } };
      q += ` and '${folderId}' in parents`;
    }
    const res = await fetchWithTimeout(
      `https://www.googleapis.com/drive/v3/files?q=${encodeURIComponent(q)}&fields=files(id,name)`,
      { headers: { authorization: `Bearer ${token}` } },
    );
    const data = (await res.json()) as { files?: Array<{ id: string; name: string }>; error?: { message?: string } };
    if (!res.ok) {
      return { ok: false, error: `Drive list_files failed: ${data.error?.message ?? res.status}` };
    }
    return { ok: true, result: { files: data.files ?? [] } };
  }

  private async gdriveReadFile(
    args: Record<string, unknown>,
    ctx: ExecutorContext,
  ): Promise<SkillExecutionResult> {
    const token = this.gdriveToken(ctx);
    if (!token) return this.fallback.execute('gdrive', 'read_file', args, ctx);
    const name = str(args.name);
    if (!name) return { ok: false, error: 'Drive read_file requires a name' };
    const fileId = await this.findDriveFileId(token, name);
    if (!fileId) {
      return { ok: false, error: `Drive file "${name}" not found (only sees files this app created)` };
    }
    const res = await fetchWithTimeout(
      `https://www.googleapis.com/drive/v3/files/${fileId}?alt=media`,
      { headers: { authorization: `Bearer ${token}` } },
    );
    if (!res.ok) {
      const body = await res.text();
      return { ok: false, error: `Drive read_file failed (${res.status}): ${body}` };
    }
    const content = await res.text();
    return { ok: true, result: { name, content } };
  }

  // --- scheduling.claim_slot / reschedule_slot (internal — no OAuth/API key) --
  // Both delegate to SchedulingService, which owns the real Calendar
  // create/delete + FreeBusy conflict-check (see google-calendar.util.ts).

  private async schedulingClaimSlot(
    args: Record<string, unknown>,
    ctx: ExecutorContext,
  ): Promise<SkillExecutionResult> {
    const bookedFor = str(args.candidateEmail) || str(args.bookedFor);
    if (!bookedFor) {
      return { ok: false, error: 'scheduling.claim_slot requires candidateEmail' };
    }
    const title = str(args.title) || `Interview — ${bookedFor}`;
    const result = await this.scheduling.claimAndSchedule(ctx.companyId, bookedFor, title);
    // "No slot available" / a Calendar failure is a normal, branchable OUTCOME,
    // not a tool failure — ok:false unconditionally fails the whole workflow
    // run (execToolAction throws), so a workflow can't CONDITION-branch on it.
    // Always ok:true; the caller checks result.claimed.
    return { ok: true, result };
  }

  private async schedulingRescheduleSlot(
    args: Record<string, unknown>,
    ctx: ExecutorContext,
  ): Promise<SkillExecutionResult> {
    const slotId = str(args.slotId);
    if (!slotId) {
      return { ok: false, error: 'scheduling.reschedule_slot requires slotId' };
    }
    const title = str(args.title) || 'Interview (rescheduled)';
    const result = await this.scheduling.reschedule(ctx.companyId, slotId, title);
    return { ok: true, result };
  }

  // --- postiz.* (Postiz REST wrapper; shared API key, no per-tenant OAuth) ---

  private async postizListConnectedAccounts(ctx: ExecutorContext): Promise<SkillExecutionResult> {
    const accounts = await this.prisma.socialAccount.findMany({
      where: { companyId: ctx.companyId, status: 'CONNECTED' },
    });
    return { ok: true, result: { accounts } };
  }

  private async postizStartConnectAccount(
    args: Record<string, unknown>,
  ): Promise<SkillExecutionResult> {
    const platform = str(args.platform);
    if (!platform) return { ok: false, error: 'start_connect_account requires a platform' };
    try {
      const { url } = await this.postizClient.getConnectUrl(platform);
      return { ok: true, result: { url } };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : 'connect failed' };
    }
  }

  private async postizSchedulePost(
    args: Record<string, unknown>,
    ctx: ExecutorContext,
  ): Promise<SkillExecutionResult> {
    const socialAccountId = str(args.socialAccountId);
    const content = str(args.content);
    const publishAt = str(args.publishAt);
    if (!socialAccountId || !content || !publishAt) {
      return { ok: false, error: 'schedule_post requires socialAccountId, content, publishAt' };
    }
    const account = await this.prisma.socialAccount.findFirst({
      where: { id: socialAccountId, companyId: ctx.companyId },
    });
    if (!account) return { ok: false, error: 'SocialAccount not found for this company' };

    // M-06: unlike publish_now (which has its own record-before-effect
    // ScheduledPost.idempotencyKey), schedule_post had NO protection at all —
    // a retried TOOL_ACTION called Postiz first and only wrote a local row
    // AFTER success, so a crash or retry created a real duplicate scheduled
    // post with zero local trace. The generic ToolIdempotencyService claims
    // a row BEFORE calling Postiz here, closing the same class of bug.
    try {
      const { result, deduped } = await this.idempotency.runIdempotent({
        companyId: ctx.companyId,
        skillKey: 'postiz',
        tool: 'schedule_post',
        key: scheduleIdempotencyKey(socialAccountId, content, publishAt),
        windowMs: PUBLISH_DEDUPE_WINDOW_MS,
        effect: async () => {
          const { postizPostId } = await this.postizClient.schedulePost({
            postizIntegrationId: account.postizIntegrationId,
            content,
            type: 'schedule',
            date: publishAt,
          });
          const post = await this.prisma.scheduledPost.create({
            data: {
              companyId: ctx.companyId,
              socialAccountId,
              content,
              publishAt: new Date(publishAt),
              status: 'SCHEDULED',
              postizPostId,
            },
          });
          return { scheduledPostId: post.id, postizPostId };
        },
      });
      return { ok: true, result: { ...result, deduped } };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : 'schedule_post failed' };
    }
  }

  private async postizPublishNow(
    args: Record<string, unknown>,
    ctx: ExecutorContext,
  ): Promise<SkillExecutionResult> {
    const socialAccountId = str(args.socialAccountId);
    const content = str(args.content);
    if (!socialAccountId || !content) {
      return { ok: false, error: 'publish_now requires socialAccountId and content' };
    }
    const account = await this.prisma.socialAccount.findFirst({
      where: { id: socialAccountId, companyId: ctx.companyId },
    });
    if (!account) return { ok: false, error: 'SocialAccount not found for this company' };

    // WAVE 3 §3.6 — TRACK the publish, and make a retry a no-op.
    //
    // This used to call Postiz and return the provider id, writing nothing.
    // So: a retried TOOL_ACTION published the same content to the same account
    // twice (public, irreversible), reconciliation could not see the post at
    // all because it only walks ScheduledPost rows, and nothing tied the
    // publish to the run that caused it.
    //
    // The key is content-derived because `ExecutorContext` carries no run/step
    // correlation to key on. That is a deliberate trade with a real edge: an
    // INTENTIONAL re-post of byte-identical content to the same account inside
    // the window is treated as a duplicate. Publishing the same thing twice by
    // accident is the far more likely and far more damaging error, and the
    // window bounds the surprise.
    const idempotencyKey = publishIdempotencyKey(socialAccountId, content);
    const prior = await this.prisma.scheduledPost.findFirst({
      where: {
        companyId: ctx.companyId,
        idempotencyKey,
        createdAt: { gte: new Date(Date.now() - PUBLISH_DEDUPE_WINDOW_MS) },
      },
    });
    if (prior?.postizPostId) {
      return {
        ok: true,
        result: {
          scheduledPostId: prior.id,
          postizPostId: prior.postizPostId,
          deduped: true,
        },
      };
    }

    // Record the INTENT before the side effect. If the process dies mid-call the
    // row is left non-PUBLISHED with no provider id, which is a state an
    // operator can see and reconcile — as opposed to a post that exists at the
    // provider and nowhere else.
    const post =
      prior ??
      (await this.prisma.scheduledPost.create({
        data: {
          companyId: ctx.companyId,
          socialAccountId,
          content,
          publishAt: new Date(),
          status: 'SCHEDULED',
          idempotencyKey,
        },
      }));

    try {
      const { postizPostId } = await this.postizClient.schedulePost({
        postizIntegrationId: account.postizIntegrationId,
        content,
        type: 'now',
      });
      await this.prisma.scheduledPost.update({
        where: { id: post.id },
        data: { status: 'PUBLISHED', postizPostId },
      });
      return { ok: true, result: { scheduledPostId: post.id, postizPostId } };
    } catch (err) {
      const message =
        err instanceof Error ? err.message : 'publish_now failed';
      // FAILED, not deleted: the attempt is part of the record, and a retry
      // reuses this row rather than opening a second one.
      await this.prisma.scheduledPost.update({
        where: { id: post.id },
        data: { status: 'FAILED' },
      });
      return { ok: false, error: message };
    }
  }

  private async postizGetPostStatus(
    args: Record<string, unknown>,
    ctx: ExecutorContext,
  ): Promise<SkillExecutionResult> {
    const scheduledPostId = str(args.scheduledPostId);
    if (!scheduledPostId) return { ok: false, error: 'get_post_status requires scheduledPostId' };
    const post = await this.prisma.scheduledPost.findFirst({
      where: { id: scheduledPostId, companyId: ctx.companyId },
    });
    if (!post) return { ok: false, error: 'ScheduledPost not found for this company' };
    const published = await this.prisma.publishedPost.findUnique({
      where: { scheduledPostId },
    });
    return {
      ok: true,
      result: {
        status: post.status,
        postizPostId: post.postizPostId,
        ...(published
          ? { platformPostId: published.platformPostId, permalink: published.permalink }
          : {}),
      },
    };
  }

  /**
   * M-10: resolves Orlixa's local ScheduledPost → real Postiz post id, then
   * asks Postiz for that post's own analytics — mirrors
   * postizGetPostStatus's exact lookup pattern. IMPLEMENTED_UNVERIFIED (see
   * PostizClientService's doc comment) — the AI is expected to report these
   * numbers as-is, never inventing a metric Postiz didn't actually return.
   */
  private async postizGetPostAnalytics(
    args: Record<string, unknown>,
    ctx: ExecutorContext,
  ): Promise<SkillExecutionResult> {
    const scheduledPostId = str(args.scheduledPostId);
    if (!scheduledPostId) return { ok: false, error: 'get_post_analytics requires scheduledPostId' };
    const post = await this.prisma.scheduledPost.findFirst({
      where: { id: scheduledPostId, companyId: ctx.companyId },
    });
    if (!post) return { ok: false, error: 'ScheduledPost not found for this company' };
    if (!post.postizPostId) {
      return { ok: false, error: 'This post has no Postiz post id yet (not published)' };
    }
    try {
      const analytics = await this.postizClient.getPostAnalytics(post.postizPostId);
      return { ok: true, result: { scheduledPostId, postizPostId: post.postizPostId, analytics } };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : 'get_post_analytics failed' };
    }
  }

  // --- marketing.* (internal compliance skill, no connection) ---------------

  /**
   * M-08: replaces trusting a workflow-trigger-supplied
   * `{{trigger.consentVerified}}` boolean with a real query against
   * MarketingConsent/MarketingSuppression. An address must have a CURRENT
   * GRANTED consent record (`SuppressionService.latestConsent`) AND not be
   * suppressed (`SuppressionService.isSuppressed`) — either failing means
   * "missing consent" for that address.
   */
  private async marketingCheckConsent(
    args: Record<string, unknown>,
    ctx: ExecutorContext,
  ): Promise<SkillExecutionResult> {
    const channelRaw = str(args.channel).toUpperCase();
    const addressesRaw = str(args.addresses);
    if (!channelRaw || !addressesRaw) {
      return { ok: false, error: 'check_consent requires channel and addresses' };
    }
    if (!['EMAIL', 'SMS', 'SOCIAL'].includes(channelRaw)) {
      return { ok: false, error: `check_consent: unknown channel "${channelRaw}"` };
    }
    const channel = channelRaw as SuppressionChannel;

    // Reuses the SAME comma/semicolon/angle-bracket parsing already proven
    // for gmail.send_email's `to` field — one parser, not a second one.
    const extracted = extractRecipients('gmail', 'send_email', { to: addressesRaw });
    const addresses = extracted?.addresses ?? [];
    if (addresses.length === 0) {
      return { ok: false, error: 'check_consent: no valid addresses supplied' };
    }

    const missingConsent: string[] = [];
    const suppressed: string[] = [];
    for (const address of addresses) {
      const [isSuppressed, consent] = await Promise.all([
        this.suppression.isSuppressed(ctx.companyId, channel, address),
        this.suppression.latestConsent(ctx.companyId, channel, address),
      ]);
      if (isSuppressed) suppressed.push(address);
      if (isSuppressed || consent?.status !== 'GRANTED') missingConsent.push(address);
    }

    return {
      ok: true,
      result: {
        allConsented: missingConsent.length === 0,
        checkedCount: addresses.length,
        missingConsent,
        suppressed,
      },
    };
  }

  // --- chatwoot.* (self-hosted Chatwoot; per-company encrypted agent bot token) --

  private async chatwootListOpenConversations(
    ctx: ExecutorContext,
  ): Promise<SkillExecutionResult> {
    const conversations = await this.prisma.supportConversation.findMany({
      where: { companyId: ctx.companyId, status: 'OPEN' },
    });
    return { ok: true, result: { conversations } };
  }

  private async chatwootGetConversation(
    args: Record<string, unknown>,
    ctx: ExecutorContext,
  ): Promise<SkillExecutionResult> {
    const conversationId = str(args.conversationId);
    if (!conversationId) {
      return { ok: false, error: 'get_conversation requires a conversationId' };
    }
    const conversation = await this.prisma.supportConversation.findFirst({
      where: { id: conversationId, companyId: ctx.companyId },
      include: { messages: { orderBy: { createdAt: 'asc' } } },
    });
    if (!conversation) {
      return { ok: false, error: 'SupportConversation not found for this company' };
    }
    return { ok: true, result: { conversation } };
  }

  private async chatwootReplyToConversation(
    args: Record<string, unknown>,
    ctx: ExecutorContext,
  ): Promise<SkillExecutionResult> {
    const conversationId = str(args.conversationId);
    const content = str(args.content);
    if (!conversationId || !content) {
      return { ok: false, error: 'reply_to_conversation requires conversationId and content' };
    }
    const conversation = await this.prisma.supportConversation.findFirst({
      where: { id: conversationId, companyId: ctx.companyId },
    });
    if (!conversation) {
      return { ok: false, error: 'SupportConversation not found for this company' };
    }
    // S-13/C-06 defense-in-depth: a conversation escalated to a human
    // (HandoffRequest PENDING) must not receive an AI-sent reply even if some
    // OTHER path (a workflow retry, a differently-routed approval) reaches
    // this far — the human, not the AI, owns this conversation until they
    // resolve the handoff. Checked here, not only at the point of escalation,
    // because this is the actual side-effect boundary.
    if (conversation.status === 'ESCALATED') {
      return {
        ok: false,
        error: 'Conversation is escalated to a human — AI replies are paused until the handoff is resolved',
      };
    }
    const account = await this.prisma.chatwootAccount.findFirst({
      where: { companyId: ctx.companyId },
    });
    if (!account) {
      return { ok: false, error: 'Chatwoot not connected for this company' };
    }
    // M-06: same class of bug as schedule_post — a retried/redelivered
    // TOOL_ACTION calling reply_to_conversation with identical args would
    // otherwise send the customer the same reply twice. Short window (5 min,
    // not publish's 24h): a support agent may legitimately send a
    // byte-identical short reply ("Thanks!") to the SAME conversation hours
    // apart, which a long window would silently swallow.
    try {
      const { result, deduped } = await this.idempotency.runIdempotent({
        companyId: ctx.companyId,
        skillKey: 'chatwoot',
        tool: 'reply_to_conversation',
        key: chatwootReplyIdempotencyKey(conversationId, content),
        windowMs: CHATWOOT_REPLY_DEDUPE_WINDOW_MS,
        effect: async () => {
          const decryptedToken = this.crypto.decrypt(account.agentBotToken);
          const { chatwootMessageId } = await this.chatwootClient.sendReply(
            account.chatwootAccountId,
            conversation.chatwootConversationId,
            decryptedToken,
            content,
          );
          const [message] = await this.prisma.$transaction([
            this.prisma.supportMessage.create({
              data: {
                companyId: ctx.companyId,
                conversationId: conversation.id,
                direction: 'OUT',
                content,
                chatwootMessageId,
              },
            }),
            this.prisma.supportConversation.update({
              where: { id: conversation.id },
              data: { lastMessageAt: new Date() },
            }),
          ]);
          return { messageId: message.id, chatwootMessageId };
        },
      });
      return { ok: true, result: { ...result, deduped } };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : 'reply_to_conversation failed' };
    }
  }

  private async chatwootResolveConversation(
    args: Record<string, unknown>,
    ctx: ExecutorContext,
  ): Promise<SkillExecutionResult> {
    const conversationId = str(args.conversationId);
    if (!conversationId) {
      return { ok: false, error: 'resolve_conversation requires a conversationId' };
    }
    const conversation = await this.prisma.supportConversation.findFirst({
      where: { id: conversationId, companyId: ctx.companyId },
    });
    if (!conversation) {
      return { ok: false, error: 'SupportConversation not found for this company' };
    }
    // S-02: ChatwootClientService has no live resolve/toggle-status call yet —
    // a prior version of this method silently updated only Orlixa's own mirror
    // row and reported ok:true, which is a silent-success defect (the real
    // Chatwoot ticket stays open). Per this codebase's own discipline for
    // provisionAccount() (never fabricate an unverified "working" call), this
    // returns an honest failure instead of a fake success. Do NOT update the
    // local mirror on this path — a status that claims RESOLVED while the
    // real ticket is still open is worse than no status change at all.
    return {
      ok: false,
      error:
        'resolve_conversation is NOT YET IMPLEMENTED against the real Chatwoot API — ' +
        'no verified toggle-status call exists yet (needs either a source-grounded read of ' +
        "Chatwoot's conversations controller, mirroring how sendReply/verifyWebhookSignature " +
        'were verified, or a live instance to test against). The conversation was NOT resolved.',
    };
  }

  // --- plane.* (self-hosted Plane; per-company encrypted API token) ---------

  private async planeListIssues(
    args: Record<string, unknown>,
    ctx: ExecutorContext,
  ): Promise<SkillExecutionResult> {
    const projectId = str(args.projectId);
    if (!projectId) {
      return { ok: false, error: 'list_issues requires a projectId' };
    }
    const project = await this.prisma.planeProject.findFirst({
      where: { id: projectId, companyId: ctx.companyId },
    });
    if (!project) {
      return { ok: false, error: 'PlaneProject not found for this company' };
    }
    const issues = await this.prisma.trackedIssue.findMany({
      where: { planeProjectId: project.id, companyId: ctx.companyId },
    });
    return { ok: true, result: { issues } };
  }

  private async planeCreateIssue(
    args: Record<string, unknown>,
    ctx: ExecutorContext,
  ): Promise<SkillExecutionResult> {
    const projectId = str(args.projectId);
    const title = str(args.title);
    const description = str(args.description);
    if (!projectId || !title) {
      return { ok: false, error: 'create_issue requires projectId and title' };
    }
    const project = await this.prisma.planeProject.findFirst({
      where: { id: projectId, companyId: ctx.companyId },
    });
    if (!project) {
      return { ok: false, error: 'Plane not connected for this company' };
    }
    const workspace = await this.prisma.planeWorkspace.findFirst({
      where: { id: project.planeWorkspaceId, companyId: ctx.companyId },
    });
    if (!workspace) {
      return { ok: false, error: 'Plane not connected for this company' };
    }
    try {
      const decryptedToken = this.crypto.decrypt(workspace.apiToken);
      const { planeIssueId } = await this.planeClient.createIssue(
        workspace.planeWorkspaceSlug,
        project.planeProjectId,
        decryptedToken,
        { title, description: description || undefined },
      );
      const issue = await this.prisma.trackedIssue.create({
        data: {
          companyId: ctx.companyId,
          planeProjectId: project.id,
          planeIssueId,
          title,
          status: 'open',
          lastSyncedAt: new Date(),
        },
      });
      return { ok: true, result: { issueId: issue.id, planeIssueId } };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : 'create_issue failed' };
    }
  }

  private async planeUpdateIssueStatus(
    args: Record<string, unknown>,
    ctx: ExecutorContext,
  ): Promise<SkillExecutionResult> {
    const issueId = str(args.issueId);
    const status = str(args.status);
    if (!issueId || !status) {
      return { ok: false, error: 'update_issue_status requires issueId and status' };
    }
    const trackedIssue = await this.prisma.trackedIssue.findFirst({
      where: { id: issueId, companyId: ctx.companyId },
    });
    if (!trackedIssue) {
      return { ok: false, error: 'TrackedIssue not found for this company' };
    }
    const project = await this.prisma.planeProject.findFirst({
      where: { id: trackedIssue.planeProjectId, companyId: ctx.companyId },
    });
    if (!project) {
      return { ok: false, error: 'Plane not connected for this company' };
    }
    const workspace = await this.prisma.planeWorkspace.findFirst({
      where: { id: project.planeWorkspaceId, companyId: ctx.companyId },
    });
    if (!workspace) {
      return { ok: false, error: 'Plane not connected for this company' };
    }
    try {
      const decryptedToken = this.crypto.decrypt(workspace.apiToken);
      await this.planeClient.updateIssueStatus(
        workspace.planeWorkspaceSlug,
        project.planeProjectId,
        decryptedToken,
        trackedIssue.planeIssueId,
        status,
      );
      const updated = await this.prisma.trackedIssue.update({
        where: { id: trackedIssue.id },
        data: { status, lastSyncedAt: new Date() },
      });
      return { ok: true, result: { id: updated.id, status: updated.status } };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : 'update_issue_status failed' };
    }
  }

  // --- whatsapp.* (Twilio WhatsApp REST wrapper; per-company encrypted credentials) ---

  private async whatsappSendMessage(
    args: Record<string, unknown>,
    ctx: ExecutorContext,
  ): Promise<SkillExecutionResult> {
    const leadId = str(args.leadId);
    const content = str(args.content);
    if (!leadId || !content) {
      return { ok: false, error: 'send_message requires leadId and content' };
    }
    const lead = await this.prisma.lead.findFirst({
      where: { id: leadId, companyId: ctx.companyId },
      include: {
        conversation: {
          include: {
            // Fixed: this must fetch the most recent message FROM THE USER,
            // not just the most recent message of any role. Filtering `where:
            // { role: 'USER' }` at the query level means `take: 1` actually
            // returns the last inbound message — previously this fetched the
            // single latest message regardless of role, so in the ordinary
            // case (AI has already replied and the latest message is
            // ASSISTANT) `lastInbound` came back undefined and every send was
            // wrongly refused as "outside the 24h window", even seconds after
            // the customer messaged.
            messages: { where: { role: 'USER' }, orderBy: { createdAt: 'desc' }, take: 1 },
          },
        },
      },
    });
    if (!lead) return { ok: false, error: 'Lead not found for this company' };

    const lastInbound = lead.conversation?.messages[0];
    const withinWindow =
      !!lastInbound && Date.now() - lastInbound.createdAt.getTime() <= WHATSAPP_SESSION_WINDOW_MS;
    if (!withinWindow) {
      return {
        ok: false,
        error: 'send_message refused: outside the 24h session window, use send_template instead',
      };
    }

    const account = await this.prisma.whatsAppAccount.findFirst({ where: { companyId: ctx.companyId } });
    if (!account) return { ok: false, error: 'No WhatsAppAccount configured for this company' };

    // M-06: see WHATSAPP_SEND_DEDUPE_WINDOW_MS doc — a retried TOOL_ACTION
    // must not double-send this message to a real lead.
    try {
      const { result, deduped } = await this.idempotency.runIdempotent({
        companyId: ctx.companyId,
        skillKey: 'whatsapp',
        tool: 'send_message',
        key: whatsappSendMessageIdempotencyKey(leadId, content),
        windowMs: WHATSAPP_SEND_DEDUPE_WINDOW_MS,
        effect: () =>
          this.whatsappClient.sendFreeform({
            accountSid: account.twilioAccountSid,
            authToken: this.crypto.decrypt(account.twilioAuthToken),
            from: account.whatsappSenderNumber,
            to: lead.phone,
            body: content,
          }),
      });
      return { ok: true, result: { ...result, deduped } };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : 'send_message failed' };
    }
  }

  private async whatsappSendTemplate(
    args: Record<string, unknown>,
    ctx: ExecutorContext,
  ): Promise<SkillExecutionResult> {
    const leadId = str(args.leadId);
    const templateId = str(args.templateId);
    if (!leadId || !templateId) {
      return { ok: false, error: 'send_template requires leadId and templateId' };
    }
    const lead = await this.prisma.lead.findFirst({ where: { id: leadId, companyId: ctx.companyId } });
    if (!lead) return { ok: false, error: 'Lead not found for this company' };

    const account = await this.prisma.whatsAppAccount.findFirst({ where: { companyId: ctx.companyId } });
    if (!account) return { ok: false, error: 'No WhatsAppAccount configured for this company' };

    const params = (args.params as Record<string, string>) ?? {};

    // M-06: same reasoning as whatsappSendMessage above — send_template is
    // just as real and irreversible, and templates are typically the exact
    // tool a retried outreach workflow would call again.
    try {
      const { result, deduped } = await this.idempotency.runIdempotent({
        companyId: ctx.companyId,
        skillKey: 'whatsapp',
        tool: 'send_template',
        key: whatsappSendTemplateIdempotencyKey(leadId, templateId, params),
        windowMs: WHATSAPP_SEND_DEDUPE_WINDOW_MS,
        effect: () =>
          this.whatsappClient.sendTemplate({
            accountSid: account.twilioAccountSid,
            authToken: this.crypto.decrypt(account.twilioAuthToken),
            from: account.whatsappSenderNumber,
            to: lead.phone,
            contentSid: templateId,
            contentVariables: params,
          }),
      });
      return { ok: true, result: { ...result, deduped } };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : 'send_template failed' };
    }
  }

  private async whatsappGetConversation(
    args: Record<string, unknown>,
    ctx: ExecutorContext,
  ): Promise<SkillExecutionResult> {
    const leadId = str(args.leadId);
    if (!leadId) return { ok: false, error: 'get_conversation requires leadId' };
    const lead = await this.prisma.lead.findFirst({
      where: { id: leadId, companyId: ctx.companyId },
      include: { conversation: { include: { messages: { orderBy: { createdAt: 'asc' } } } } },
    });
    if (!lead) return { ok: false, error: 'Lead not found for this company' };
    return { ok: true, result: { messages: lead.conversation?.messages ?? [] } };
  }
}
