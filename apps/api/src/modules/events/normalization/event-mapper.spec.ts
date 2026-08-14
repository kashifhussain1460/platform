import { mapRawEvent, type RawEventInput } from './event-mapper';

const raw = (over: Partial<RawEventInput>): RawEventInput => ({
  provider: 'chatwoot',
  externalId: null,
  headers: null,
  payload: null,
  ...over,
});

/**
 * WAVE 3 §3.3 — the canonical event contract, for the two engines this wave
 * brought onto the pipeline.
 *
 * These mappers are PURE, which is the point: the whole translation is testable
 * without Postgres, Redis, a queue or a signature.
 */
describe('event-mapper — Chatwoot (§3.4)', () => {
  const message = (over: Record<string, unknown> = {}) =>
    raw({
      provider: 'chatwoot',
      payload: {
        id: 1001,
        conversation: { id: 7 },
        message_type: 'incoming',
        content: 'my order never arrived',
        sender: { email: 'customer@example.com' },
        created_at: '2026-08-12T10:00:00.000Z',
        __conversationId: '7',
        __isFirstMessage: true,
        ...over,
      },
    });

  it('maps a conversation’s first inbound message to NEW_TICKET', () => {
    const m = mapRawEvent(message());
    expect(m.type).toBe('NEW_TICKET');
    expect(m.subject).toEqual({ type: 'conversation', conversationId: '7' });
    expect(m.data).toMatchObject({
      conversationId: '7',
      messageId: '1001',
      contactEmail: 'customer@example.com',
    });
    expect(m.occurredAt?.toISOString()).toBe('2026-08-12T10:00:00.000Z');
  });

  it('maps a later inbound message to TICKET_REPLIED', () => {
    expect(mapRawEvent(message({ __isFirstMessage: false })).type).toBe(
      'TICKET_REPLIED',
    );
  });

  it('does NOT emit an event for our own outgoing reply', () => {
    // Otherwise a support workflow reacts to its own reply and answers itself
    // in a loop — real messages to a real customer, for ever.
    expect(mapRawEvent(message({ message_type: 'outgoing' })).type).toBe(
      'UNKNOWN',
    );
  });

  it('keys dedupe on the MESSAGE id, so two messages in one conversation differ', () => {
    const a = mapRawEvent(message({ id: 1001 }));
    const b = mapRawEvent(message({ id: 1002 }));
    expect(a.dedupeKey).toBe('chatwoot:1001');
    expect(b.dedupeKey).not.toBe(a.dedupeKey);
  });
});

describe('event-mapper — Plane (§3.5)', () => {
  const issue = (over: Record<string, unknown> = {}) =>
    raw({
      provider: 'plane',
      payload: {
        event: 'issue',
        action: 'created',
        data: {
          id: 'issue-1',
          project: 'proj-1',
          name: 'Fix login',
          priority: 'high',
          created_at: '2026-08-12T09:00:00.000Z',
          updated_at: '2026-08-12T09:00:00.000Z',
        },
        ...over,
      },
    });

  it('maps issue.created to NEW_PROJECT_ISSUE', () => {
    const m = mapRawEvent(issue());
    expect(m.type).toBe('NEW_PROJECT_ISSUE');
    expect(m.subject).toEqual({
      type: 'issue',
      issueId: 'issue-1',
      projectId: 'proj-1',
    });
    expect(m.data).toMatchObject({ name: 'Fix login', priority: 'high' });
  });

  it('maps issue.updated to PROJECT_ISSUE_UPDATED', () => {
    expect(mapRawEvent(issue({ action: 'updated' })).type).toBe(
      'PROJECT_ISSUE_UPDATED',
    );
  });

  it('does not reuse the Jira event types', () => {
    // A workflow that triggers on "a Jira issue was created" must not start
    // firing for Plane the day Plane is connected.
    const m = mapRawEvent(issue());
    expect(m.type).not.toBe('NEW_JIRA_ISSUE');
  });

  it('an UPDATE does not dedupe against the CREATE of the same issue', () => {
    const created = mapRawEvent(issue());
    const updated = mapRawEvent(
      issue({
        action: 'updated',
        data: {
          id: 'issue-1',
          project: 'proj-1',
          updated_at: '2026-08-12T11:00:00.000Z',
        },
      }),
    );
    expect(updated.dedupeKey).not.toBe(created.dedupeKey);
  });

  it('two DIFFERENT updates to one issue are distinct events', () => {
    const at = (t: string) =>
      mapRawEvent(
        issue({
          action: 'updated',
          data: { id: 'issue-1', project: 'proj-1', updated_at: t },
        }),
      ).dedupeKey;
    expect(at('2026-08-12T11:00:00.000Z')).not.toBe(
      at('2026-08-12T12:00:00.000Z'),
    );
  });

  it('the SAME update redelivered is one event', () => {
    // Canonical dedupe is the second line of defence behind RawEvent dedupe.
    const same = () =>
      mapRawEvent(
        issue({
          action: 'updated',
          data: {
            id: 'issue-1',
            project: 'proj-1',
            updated_at: '2026-08-12T11:00:00.000Z',
          },
        }),
      ).dedupeKey;
    expect(same()).toBe(same());
  });

  it('an unmodelled Plane event is UNKNOWN, never an error', () => {
    // Connecting Plane must not start failing deliveries for event kinds we do
    // not model yet.
    expect(mapRawEvent(issue({ event: 'cycle', action: 'created' })).type).toBe(
      'UNKNOWN',
    );
  });

  // ── §16/§17 — the two lifecycle events that used to fall to UNKNOWN ────────
  // Neither Chatwoot nor Plane sends a distinct "assigned" or "status changed"
  // delivery: both arrive as a generic update, and the CHANGED FIELD is the only
  // thing separating them. Getting that wrong fires the wrong workflow.

  describe('lifecycle events (§16/§17)', () => {
    it('chatwoot: an assignee change maps to ASSIGNMENT_CHANGED', () => {
      const mapping = mapRawEvent({
        provider: 'chatwoot',
        externalId: 'd1',
        headers: null,
        payload: {
          event: 'conversation_updated',
          conversation: { id: 42, status: 'open' },
          changed_attributes: [
            { assignee_id: { current_value: 7, previous_value: null } },
          ],
          updated_at: '2026-08-14T10:00:00.000Z',
        },
      });

      expect(mapping.type).toBe('ASSIGNMENT_CHANGED');
      expect(mapping.data?.conversationId).toBe('42');
    });

    it('chatwoot: a status change maps to STATUS_CHANGED', () => {
      const mapping = mapRawEvent({
        provider: 'chatwoot',
        externalId: 'd2',
        headers: null,
        payload: {
          event: 'conversation_updated',
          conversation: { id: 42, status: 'resolved' },
          changed_attributes: [
            { status: { current_value: 'resolved', previous_value: 'open' } },
          ],
          updated_at: '2026-08-14T10:05:00.000Z',
        },
      });

      expect(mapping.type).toBe('STATUS_CHANGED');
    });

    it('chatwoot: two updates of the SAME conversation do not dedupe into one', () => {
      // The trap: keying a lifecycle event by message id collapses every update
      // of one conversation into a single event and silently drops all but the
      // first — so "assigned" would arrive and "resolved" never would.
      const make = (stamp: string, attr: string) =>
        mapRawEvent({
          provider: 'chatwoot',
          externalId: 'd3',
          headers: null,
          payload: {
            event: 'conversation_updated',
            conversation: { id: 42 },
            changed_attributes: [{ [attr]: { current_value: 'x' } }],
            updated_at: stamp,
          },
        }).dedupeKey;

      expect(make('2026-08-14T10:00:00.000Z', 'status')).not.toBe(
        make('2026-08-14T10:05:00.000Z', 'status'),
      );
      expect(make('2026-08-14T10:00:00.000Z', 'status')).not.toBe(
        make('2026-08-14T10:00:00.000Z', 'assignee_id'),
      );
    });

    it('plane: a state change maps to STATUS_CHANGED, an assignee change to ASSIGNMENT_CHANGED', () => {
      const plane = (field: string) =>
        mapRawEvent({
          provider: 'plane',
          externalId: 'p1',
          headers: null,
          payload: {
            event: 'issue',
            action: 'updated',
            activity: { field },
            data: { id: 'iss_1', project: 'proj_1', updated_at: '2026-08-14T10:00:00.000Z' },
          },
        }).type;

      expect(plane('state')).toBe('STATUS_CHANGED');
      expect(plane('assignees')).toBe('ASSIGNMENT_CHANGED');
    });

    it('plane: an update with NO known changed field stays a generic update', () => {
      // Nothing that used to trigger may stop triggering, and an unknown change
      // must not be guessed into a status change.
      const mapping = mapRawEvent({
        provider: 'plane',
        externalId: 'p2',
        headers: null,
        payload: {
          event: 'issue',
          action: 'updated',
          data: { id: 'iss_2', updated_at: '2026-08-14T10:00:00.000Z' },
        },
      });

      expect(mapping.type).toBe('PROJECT_ISSUE_UPDATED');
    });
  });
});
