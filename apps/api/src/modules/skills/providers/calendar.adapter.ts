import { googleApiGet, classifyGoogleError, accessTokenFrom } from './google-api.util';
import {
  createGoogleCalendarEvent,
  deleteGoogleCalendarEvent,
} from '../executors/google-calendar.util';
import type {
  AdapterCheck,
  AdapterInput,
  ConnectionFailureCode,
  DiscoveredAccount,
  SkillProviderAdapter,
} from './provider-adapter';

/** GOOGLE CALENDAR — plan §18. Reuses the existing real create/delete helpers. */

const MISSING = 'Reconnect this Google account — no access token is stored yet.';

interface CalendarListItem {
  id?: string;
  summary?: string;
  primary?: boolean;
}

export const calendarAdapter: SkillProviderAdapter = {
  key: 'calendar',

  async validateCredentials(input: AdapterInput): Promise<AdapterCheck> {
    const token = accessTokenFrom(input.creds);
    if (!token) return { ok: false, detail: MISSING, code: 'INVALID_CREDENTIALS' };
    const result = await googleApiGet<{ items?: CalendarListItem[] }>(
      'https://www.googleapis.com/calendar/v3/users/me/calendarList?maxResults=1',
      token,
    );
    if (!result.ok) {
      return { ok: false, detail: result.error.message, code: classifyGoogleError(result.error) };
    }
    return { ok: true, detail: 'Signed in to Google Calendar' };
  },

  async discoverAccount(input: AdapterInput): Promise<DiscoveredAccount> {
    const token = accessTokenFrom(input.creds);
    if (!token) return { account: null };
    const result = await googleApiGet<{ items?: CalendarListItem[] }>(
      'https://www.googleapis.com/calendar/v3/users/me/calendarList?maxResults=1',
      token,
    );
    if (!result.ok) return { account: null };
    const primary = (result.body.items ?? [])[0];
    return {
      account: primary?.id ?? null,
      metadata: primary ? { summary: primary.summary } : undefined,
    };
  },

  /**
   * §18 "Test Create Event" — a same-day, 1-minute test event, deleted right
   * after. A cleanup failure is reported but does not fail the test: the
   * create already proved the connection end to end.
   */
  async test(input: AdapterInput): Promise<AdapterCheck> {
    const token = accessTokenFrom(input.creds);
    if (!token) return { ok: false, detail: MISSING, code: 'INVALID_CREDENTIALS' };
    const start = new Date(Date.now() + 5 * 60_000);
    const end = new Date(start.getTime() + 60_000);
    const created = await createGoogleCalendarEvent(token, {
      title: 'Orlixa connection test',
      startIso: start.toISOString(),
      endIso: end.toISOString(),
    });
    if (!created.ok) {
      return { ok: false, detail: created.error, code: classifyGoogleError(created.error) };
    }
    const deleted = await deleteGoogleCalendarEvent(token, { eventId: created.id });
    return {
      ok: true,
      detail: deleted
        ? 'Created and removed a test event on your primary calendar.'
        : 'Created a test event on your primary calendar (could not remove it automatically — delete "Orlixa connection test" manually).',
    };
  },

  async healthCheck(input: AdapterInput): Promise<AdapterCheck> {
    return calendarAdapter.validateCredentials(input);
  },

  classifyError(error: unknown): ConnectionFailureCode {
    return classifyGoogleError(error);
  },
};
