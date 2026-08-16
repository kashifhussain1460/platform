import type { AdapterInput } from './provider-adapter';

/**
 * IMAP settings for the `email` skill — the INBOUND half of a company mailbox
 * (plan §10 "Custom Company Email": SMTP config + IMAP config + both tested).
 *
 * Kept in its own module, next to the SMTP resolver and with the same shape, so
 * the adapter, the poller and any future reader all read settings through ONE
 * implementation. Two readers that disagree about which port implies TLS is a
 * "works when you test it, fails when it runs" bug.
 */

export const IMAP_FIELDS = {
  host: 'imapHost',
  port: 'imapPort',
  security: 'imapSecurity',
  user: 'imapUser',
  password: 'imapPassword',
  folder: 'imapFolder',
} as const;

export interface ImapSettings {
  host: string;
  port: number;
  /** imapflow's `secure`: implicit TLS on connect (port 993). */
  secure: boolean;
  user: string;
  password: string;
  folder: string;
}

function str(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

/**
 * Resolve IMAP settings, falling back to the SMTP credentials.
 *
 * Returns null when no IMAP host is configured — which is the normal state for
 * a send-only mailbox, NOT an error. Inbound is opt-in: a company that only
 * wants Orlixa to send email should never have its inbox polled.
 *
 * The password is read ONLY from credentials (it is a `secret: true` catalog
 * field, so `configureSkill` stores it encrypted); reading config too would
 * silently accept a plaintext password if the schema were ever mis-edited.
 */
export function resolveImapSettings(input: AdapterInput): ImapSettings | null {
  const cfg = input.config ?? {};
  const creds = input.creds ?? {};

  const host = str(cfg[IMAP_FIELDS.host]);
  if (!host) return null;

  // One mailbox usually does both, so blank inbound credentials mean "same as
  // outbound" rather than "broken".
  const user = str(cfg[IMAP_FIELDS.user]) || str(cfg.smtpUser);
  const password = str(creds[IMAP_FIELDS.password]) || str(creds.smtpPassword);
  if (!user || !password) return null;

  const port = Number(cfg[IMAP_FIELDS.port] ?? 993);
  const security = str(cfg[IMAP_FIELDS.security]) || (port === 143 ? 'starttls' : 'tls');

  return {
    host,
    port: Number.isFinite(port) && port > 0 ? port : 993,
    secure: security === 'tls',
    user,
    password,
    folder: str(cfg[IMAP_FIELDS.folder]) || 'INBOX',
  };
}

/**
 * Open an authenticated IMAP connection. Lazy import for the same reason
 * nodemailer is lazily imported in MailService: the offline/mock path and the
 * test suite must never load it.
 *
 * The caller ALWAYS owns closing it — see `withImap`.
 */
export async function openImap(settings: ImapSettings) {
  const { ImapFlow } = (await import('imapflow')) as typeof import('imapflow');
  const client = new ImapFlow({
    host: settings.host,
    port: settings.port,
    secure: settings.secure,
    auth: { user: settings.user, pass: settings.password },
    // imapflow logs every protocol line at info by default, which would put
    // mailbox contents (and headers) into the application log.
    logger: false,
    // A hung mail server must not hold a worker or an HTTP request open.
    socketTimeout: 20_000,
    greetingTimeout: 10_000,
    connectionTimeout: 10_000,
  });
  await client.connect();
  return client;
}

/**
 * Run `fn` against a connected client and ALWAYS log out.
 *
 * IMAP servers cap concurrent connections per account aggressively (Gmail
 * allows 15, many hosts far fewer). A poller that leaks one connection per
 * sweep locks the customer out of their own mailbox within the hour, so the
 * teardown is not optional and must survive a throw.
 */
export async function withImap<T>(
  settings: ImapSettings,
  fn: (client: Awaited<ReturnType<typeof openImap>>) => Promise<T>,
): Promise<T> {
  const client = await openImap(settings);
  try {
    return await fn(client);
  } finally {
    await client.logout().catch(() => client.close());
  }
}

/**
 * The inbound cursor, stored on `InstalledSkill.inboundCursor` (the same column
 * the Gmail poller uses for its historyId).
 *
 * UIDVALIDITY is carried alongside the UID because a UID is only meaningful
 * within one UIDVALIDITY generation. When a server renumbers a folder — a
 * restore, a migration, some cPanel hosts on any mailbox rename — UIDs restart
 * from 1. Without the check, the poller would treat the whole mailbox as "older
 * than my cursor" and never fire again, silently, for ever.
 */
export interface ImapCursor {
  uidValidity: string;
  lastUid: number;
}

export function parseImapCursor(raw: string | null | undefined): ImapCursor | null {
  if (!raw) return null;
  const [uidValidity, uid] = String(raw).split(':');
  const lastUid = Number(uid);
  if (!uidValidity || !Number.isFinite(lastUid)) return null;
  return { uidValidity, lastUid };
}

export function formatImapCursor(cursor: ImapCursor): string {
  return `${cursor.uidValidity}:${cursor.lastUid}`;
}
