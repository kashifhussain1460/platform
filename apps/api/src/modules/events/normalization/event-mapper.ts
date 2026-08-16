import { createHash } from 'node:crypto';
import { CANONICAL_EVENT_TYPES, type CanonicalEventType } from '@vaep/types';

/**
 * Provider MAPPERS: pure functions (raw → canonical) that translate a provider's
 * native payload into the one internal canonical envelope (§3). Being pure they
 * are trivially unit-testable and side-effect free; the normalization worker owns
 * all persistence + workflow firing. A provider we do not recognise, or an event
 * shape we do not map, yields type `UNKNOWN` (never throws).
 */

/** The subset of a RawEvent a mapper reads (no DB access — pure input). */
export interface RawEventInput {
  provider: string;
  externalId: string | null;
  headers: Record<string, unknown> | null;
  payload: Record<string, unknown> | null;
}

/** A mapper's output: the canonical fields (the envelope minus ids/provenance). */
export interface CanonicalMapping {
  type: CanonicalEventType;
  dedupeKey: string;
  occurredAt: Date | null;
  subject: Record<string, unknown> | null;
  data: Record<string, unknown> | null;
}

const CANONICAL_SET = new Set<string>(CANONICAL_EVENT_TYPES);

/** Read a nested object field safely (returns undefined for non-objects). */
function obj(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

/** Read a string field (or undefined). */
function str(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

/** Parse a provider timestamp into a Date, or null if absent/unparseable. */
function parseDate(value: unknown): Date | null {
  const s = str(value);
  if (!s) {
    return null;
  }
  const d = new Date(s);
  return Number.isNaN(d.getTime()) ? null : d;
}

/** Stable sha256 (hex, truncated) of a JSON value — a dedupe key of last resort. */
function hashPayload(payload: unknown): string {
  return createHash('sha256')
    .update(JSON.stringify(payload ?? {}))
    .digest('hex')
    .slice(0, 32);
}

/**
 * GitHub mapper. The native event type is the `X-GitHub-Event` header (e.g.
 * `pull_request`, `issues`) and the sub-action is `payload.action`. We map:
 *   pull_request.opened → NEW_GITHUB_PR
 *   issues.opened       → NEW_GITHUB_ISSUE
 * Everything else → UNKNOWN. dedupeKey = `github:<delivery|node_id>`.
 */
function mapGithub(raw: RawEventInput): CanonicalMapping {
  const headers = raw.headers ?? {};
  const payload = raw.payload ?? {};
  const ghEvent = str(headers['x-github-event']) ?? '';
  const action = str(payload['action']) ?? '';
  const pr = obj(payload['pull_request']);
  const issue = obj(payload['issue']);
  const repo = obj(payload['repository']);
  const repoName = str(repo?.['full_name']) ?? null;

  let type: CanonicalEventType = 'UNKNOWN';
  let subject: Record<string, unknown> | null = null;
  let data: Record<string, unknown> | null = null;
  let occurredAt: Date | null = null;
  let nodeId: string | undefined;

  if (ghEvent === 'pull_request' && action === 'opened' && pr) {
    type = 'NEW_GITHUB_PR';
    nodeId = str(pr['node_id']);
    occurredAt = parseDate(pr['created_at']);
    subject = { type: 'pull_request', repo: repoName, number: pr['number'] ?? null };
    data = {
      number: pr['number'] ?? null,
      title: pr['title'] ?? null,
      url: pr['html_url'] ?? null,
      author: obj(pr['user'])?.['login'] ?? null,
      repo: repoName,
    };
  } else if (ghEvent === 'issues' && action === 'opened' && issue) {
    type = 'NEW_GITHUB_ISSUE';
    nodeId = str(issue['node_id']);
    occurredAt = parseDate(issue['created_at']);
    subject = { type: 'issue', repo: repoName, number: issue['number'] ?? null };
    data = {
      number: issue['number'] ?? null,
      title: issue['title'] ?? null,
      url: issue['html_url'] ?? null,
      author: obj(issue['user'])?.['login'] ?? null,
      repo: repoName,
    };
  }

  const idPart = raw.externalId ?? nodeId ?? hashPayload(payload);
  return { type, dedupeKey: `github:${idPart}`, occurredAt, subject, data };
}

/**
 * Generic mapper for any provider without a dedicated one. Passes through
 * `payload.type` when it names a known CanonicalEventType, else UNKNOWN. Carries
 * `payload.subject` / `payload.data` verbatim when present. dedupeKey =
 * `generic:<externalId>` (or a payload hash when no delivery id was supplied).
 */
function mapGeneric(raw: RawEventInput): CanonicalMapping {
  const payload = raw.payload ?? {};
  const declared = str(payload['type']);
  const type: CanonicalEventType =
    declared && CANONICAL_SET.has(declared)
      ? (declared as CanonicalEventType)
      : 'UNKNOWN';
  const idPart = raw.externalId ?? hashPayload(payload);
  return {
    type,
    dedupeKey: `generic:${idPart}`,
    occurredAt: parseDate(payload['occurredAt']) ?? parseDate(payload['occurred_at']),
    subject: obj(payload['subject']) ?? null,
    data: obj(payload['data']) ?? null,
  };
}

/**
 * Gmail mapper. Fed by the INBOUND polling driver (GmailInboundService), whose
 * RawEvent payload already carries the flattened message metadata
 * `{ messageId, from, subject, snippet, date }` (pulled via the Gmail REST API).
 * Every inbound message maps to a `NEW_EMAIL` canonical event; the subject frames
 * the sender as a candidate so the RecruitAI EVENT workflow can screen it.
 * dedupeKey = `gmail:msg:<messageId>` (idempotent per Gmail message id).
 */
function mapGmail(raw: RawEventInput): CanonicalMapping {
  return mapInboundEmail(raw, 'gmail');
}

/**
 * IMAP mapper — a mailbox connected over SMTP/IMAP rather than Gmail's API
 * (the `email` skill). Fed by ImapInboundService.
 *
 * It produces the IDENTICAL canonical shape as Gmail, deliberately: a workflow
 * triggered on NEW_EMAIL reads `{{trigger.subject}}` / `{{trigger.body}}` /
 * `{{trigger.from}}` and must not care which transport the mail arrived over.
 * That is what lets a company move from a Gmail OAuth connector to their own
 * mail server (or run both) without touching a single workflow.
 *
 * Only the dedupeKey namespace differs (`imap:msg:` vs `gmail:msg:`), so the
 * same message seen through two different connectors is not collapsed into one
 * event — they are genuinely two deliveries to two mailboxes.
 */
function mapImap(raw: RawEventInput): CanonicalMapping {
  return mapInboundEmail(raw, 'imap');
}

/** The shared inbound-email mapping used by every mail transport. */
function mapInboundEmail(
  raw: RawEventInput,
  namespace: 'gmail' | 'imap',
): CanonicalMapping {
  const payload = raw.payload ?? {};
  const messageId =
    str(payload['messageId']) ?? raw.externalId ?? hashPayload(payload);
  const from = str(payload['from']) ?? null;
  const subject = str(payload['subject']) ?? null;
  const snippet = str(payload['snippet']) ?? null;
  // Full-body + attachment text supplied by the INBOUND driver's format=full
  // fetch (null/absent for a metadata-only or webhook-sourced payload).
  const body = str(payload['body']) ?? null;
  const cv = str(payload['cv']) ?? null;
  const attachments = Array.isArray(payload['attachments'])
    ? (payload['attachments'] as unknown[])
    : [];
  // Passed through for audit visibility (`/events/canonical`) — the actual
  // reply-skip / spam-filter decisions happen in GmailInboundService, which
  // computes these; the mapper just carries them onto the canonical record.
  const isReply = payload['isReply'] === true;
  const looksLikeApplication = payload['looksLikeApplication'] === true;
  return {
    type: 'NEW_EMAIL',
    dedupeKey: `${namespace}:msg:${messageId}`,
    occurredAt: parseDate(payload['date']),
    subject: { type: 'candidate', email: from },
    // `body` (full text) + `cv` (attachment text) drive the RecruitAI screen;
    // `attachments` carries metadata only (filename + chars) to stay bounded.
    data: {
      from,
      subject,
      snippet,
      body,
      cv,
      attachments,
      messageId,
      isReply,
      looksLikeApplication,
    },
  };
}


/**
 * WAVE 3 §3.4 — Chatwoot.
 *
 * A conversation's FIRST inbound message is a new ticket; any later inbound one
 * is a reply. Outgoing (agent/bot) messages are deliberately not canonical
 * events: they are our OWN side effects coming back, and turning them into
 * events is how a support workflow ends up replying to itself in a loop.
 *
 * dedupeKey is the Chatwoot message id when present. Two different messages in
 * one conversation must not collide, so the conversation id alone is not enough.
 */
function mapChatwoot(raw: RawEventInput): CanonicalMapping {
  const payload = raw.payload ?? {};
  const conversation = obj(payload['conversation']);
  const conversationId =
    str(payload['__conversationId']) ??
    (conversation?.['id'] != null ? String(conversation['id']) : undefined);
  const messageId = payload['id'] != null ? String(payload['id']) : undefined;
  const messageType = str(payload['message_type']) ?? '';
  const isFirst = payload['__isFirstMessage'] === true;

  // Chatwoot names the delivery in `event`; message deliveries carry
  // `message_type` instead. Both shapes arrive on the same webhook.
  const event = str(payload['event']) ?? '';

  let type: CanonicalEventType = 'UNKNOWN';
  if (messageType === 'incoming' || messageType === '0') {
    type = isFirst ? 'NEW_TICKET' : 'TICKET_REPLIED';
  } else if (
    event === 'conversation_updated' ||
    event === 'conversation.updated'
  ) {
    // §16 lists assignment.changed and status.changed as required, and Chatwoot
    // delivers BOTH as `conversation_updated` — the difference is which field
    // moved. Reading `changed_attributes` is the only way to tell them apart;
    // without it a workflow could not distinguish "handed to a human" from
    // "resolved", which are opposite outcomes.
    const changed = changedAttributeKeys(payload);
    if (changed.includes('assignee_id') || changed.includes('assignee')) {
      type = 'ASSIGNMENT_CHANGED';
    } else if (changed.includes('status')) {
      type = 'STATUS_CHANGED';
    }
  }

  // A lifecycle change has no message id, so the message-id key would collapse
  // every update of one conversation into a single event and dedupe all but the
  // first away. The changed fields + timestamp make each transition distinct.
  const lifecycleStamp =
    type === 'ASSIGNMENT_CHANGED' || type === 'STATUS_CHANGED'
      ? `${conversationId ?? 'unknown'}:${type}:${
          str(payload['updated_at']) ?? hashPayload(payload)
        }`
      : undefined;
  const idPart =
    lifecycleStamp ?? messageId ?? raw.externalId ?? hashPayload(payload);
  return {
    type,
    dedupeKey: `chatwoot:${idPart}`,
    occurredAt: parseDate(payload['created_at']),
    subject:
      conversationId != null
        ? { type: 'conversation', conversationId }
        : null,
    data: {
      conversationId: conversationId ?? null,
      messageId: messageId ?? null,
      content: payload['content'] ?? null,
      contactEmail: obj(payload['sender'])?.['email'] ?? null,
      messageType: messageType || null,
      status: conversation?.['status'] ?? payload['status'] ?? null,
      assigneeId:
        obj(payload['assignee'])?.['id'] ?? payload['assignee_id'] ?? null,
      changedAttributes: changedAttributeKeys(payload),
    },
  };
}

/**
 * The keys Chatwoot reports as changed.
 *
 * It sends `changed_attributes: [{ status: { current_value, previous_value } }]`
 * — an ARRAY OF OBJECTS, not a list of names, which is the shape that makes a
 * naive `includes('status')` silently never match.
 */
function changedAttributeKeys(payload: Record<string, unknown>): string[] {
  const raw = payload['changed_attributes'];
  if (!Array.isArray(raw)) return [];
  return raw.flatMap((entry) =>
    entry && typeof entry === 'object' ? Object.keys(entry) : [],
  );
}

/**
 * WAVE 3 §3.5 — Plane.
 *
 * Plane sends `{ event, action, data }`. Only issue events are mapped; anything
 * else is UNKNOWN rather than an error, so connecting Plane cannot start failing
 * deliveries for event kinds we do not model yet.
 */
function mapPlane(raw: RawEventInput): CanonicalMapping {
  const payload = raw.payload ?? {};
  const event = str(payload['event']) ?? '';
  const action = str(payload['action']) ?? '';
  const data = obj(payload['data']) ?? {};
  const issueId = data['id'] != null ? String(data['id']) : undefined;
  const projectId = data['project'] != null ? String(data['project']) : undefined;

  let type: CanonicalEventType = 'UNKNOWN';
  if (event === 'issue') {
    if (action === 'created') type = 'NEW_PROJECT_ISSUE';
    else if (action === 'updated') {
      // §17 requires status.changed and assignment.changed as distinct events.
      // Plane delivers both as `issue.updated`, so — as with Chatwoot — the
      // changed field is what separates them. A generic "updated" is still
      // emitted when neither moved, so nothing that used to trigger stops.
      const changed = planeChangedKeys(payload);
      if (changed.includes('assignees') || changed.includes('assignee_ids')) {
        type = 'ASSIGNMENT_CHANGED';
      } else if (changed.includes('state') || changed.includes('state_id')) {
        type = 'STATUS_CHANGED';
      } else {
        type = 'PROJECT_ISSUE_UPDATED';
      }
    }
  }

  // An UPDATE must not dedupe against the CREATE of the same issue, nor against
  // a later update — so the key carries the action and the update timestamp.
  const stamp =
    str(data['updated_at']) ?? str(data['created_at']) ?? hashPayload(payload);
  const idPart = issueId ? `${issueId}:${action}:${stamp}` : hashPayload(payload);
  return {
    type,
    dedupeKey: `plane:${idPart}`,
    occurredAt: parseDate(data['updated_at'] ?? data['created_at']),
    subject: issueId
      ? { type: 'issue', issueId, projectId: projectId ?? null }
      : null,
    data: {
      issueId: issueId ?? null,
      projectId: projectId ?? null,
      name: data['name'] ?? null,
      state: data['state'] ?? null,
      priority: data['priority'] ?? null,
      sequenceId: data['sequence_id'] ?? null,
      action: action || null,
      assignees: data['assignees'] ?? null,
      changedKeys: planeChangedKeys(payload),
    },
  };
}

/**
 * Which fields Plane says moved on an `issue.updated`.
 *
 * Plane has shipped more than one shape here (`activity.field`, and a plain
 * `changed_fields` list), so both are read. Returning `[]` when neither is
 * present is deliberate: an update whose changed fields are unknown stays a
 * generic `PROJECT_ISSUE_UPDATED` rather than being guessed into a status
 * change, because a wrong event type fires the wrong workflow.
 */
function planeChangedKeys(payload: Record<string, unknown>): string[] {
  const activity = obj(payload['activity']);
  const field = str(activity?.['field']);
  const listed = payload['changed_fields'];
  const fromList = Array.isArray(listed)
    ? listed.filter((v): v is string => typeof v === 'string')
    : [];
  return field ? [field, ...fromList] : fromList;
}

/** Dispatch to the provider's mapper (generic fallback). Pure + total. */
export function mapRawEvent(raw: RawEventInput): CanonicalMapping {
  switch (raw.provider) {
    case 'github':
      return mapGithub(raw);
    case 'gmail':
      return mapGmail(raw);
    case 'imap':
      return mapImap(raw);
    case 'chatwoot':
      return mapChatwoot(raw);
    case 'plane':
      return mapPlane(raw);
    default:
      return mapGeneric(raw);
  }
}
