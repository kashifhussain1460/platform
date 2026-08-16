import { resolveImapSettings, withImap } from './imap.util';
import type {
  AdapterCheck,
  AdapterInput,
  ConnectionFailureCode,
  DiscoveredAccount,
  SkillProviderAdapter,
} from './provider-adapter';

/**
 * CUSTOM SMTP — the "your own mailbox" provider (plan §7 Custom SMTP, §10).
 *
 * ## Why this exists
 *
 * An address like `kashif.hussain@dotsquares.com` does not tell you whether the
 * mailbox lives on Google Workspace, Microsoft 365, Hostinger or a cPanel box
 * (§7, verbatim). OAuth cannot answer that — every provider needs its own app
 * registration and consent screen. SMTP can: it is the one transport every mail
 * host on earth exposes, so it is what makes "connect the company's real email"
 * work on day one, for any customer, with no Orlixa-side provider onboarding.
 *
 * It also covers Gmail and Outlook via app passwords, which is why this ships
 * before the Microsoft OAuth adapter (§9) rather than after it.
 *
 * ## What it replaces
 *
 * The `email` skill previously offered a single generic "API key" box, stored
 * whatever was typed, and marked the connection CONNECTED without contacting
 * anything — while `email.send_email` had no real executor at all and silently
 * fell through to the mock. Every part of that is the §1 anti-pattern.
 *
 * `nodemailer` is already a dependency (MailService uses it for system mail) and
 * is LAZY-imported here for the same reason it is there: the offline/mock path
 * and the test suite must never load it.
 */

/** Config/credential keys this adapter reads. Kept next to the catalog schema. */
export const SMTP_FIELDS = {
  host: 'smtpHost',
  port: 'smtpPort',
  security: 'smtpSecurity',
  user: 'smtpUser',
  password: 'smtpPassword',
  from: 'fromAddress',
  fromName: 'fromName',
} as const;

/** `smtpSecurity` values offered in the catalog's select. */
export type SmtpSecurity = 'tls' | 'starttls' | 'none';

export interface SmtpSettings {
  host: string;
  port: number;
  /** nodemailer's `secure`: implicit TLS on connect (port 465). */
  secure: boolean;
  /** Refuse to continue unencrypted after STARTTLS (port 587). */
  requireTLS: boolean;
  user: string;
  password: string;
  from: string;
  fromName: string;
}

/**
 * Read SMTP settings from the connector's config + decrypted credentials.
 *
 * Exported because the executor and the health probe need the exact same
 * resolution — two readers that disagree about which port means TLS is a
 * "works when you test it, fails when it runs" bug.
 */
export function resolveSmtpSettings(input: AdapterInput): SmtpSettings | null {
  const cfg = input.config ?? {};
  const creds = input.creds ?? {};

  const host = str(cfg[SMTP_FIELDS.host]) || str(creds[SMTP_FIELDS.host]);
  const user = str(cfg[SMTP_FIELDS.user]) || str(creds[SMTP_FIELDS.user]);
  // The password is a `secret: true` catalog field, so it lives ENCRYPTED in
  // credentials — never in config. Reading config too would silently accept a
  // plaintext password if the schema were ever mis-edited.
  const password = str(creds[SMTP_FIELDS.password]);
  if (!host || !user || !password) return null;

  const port = Number(cfg[SMTP_FIELDS.port] ?? creds[SMTP_FIELDS.port] ?? 587);
  const security = (str(cfg[SMTP_FIELDS.security]) || defaultSecurityFor(port)) as SmtpSecurity;
  const from = str(cfg[SMTP_FIELDS.from]) || user;

  return {
    host,
    port: Number.isFinite(port) && port > 0 ? port : 587,
    secure: security === 'tls',
    // STARTTLS must be REQUIRED, not merely offered. Without this nodemailer
    // will happily fall back to an unencrypted session if the server's
    // advertisement is missing or stripped, and the mailbox password crosses
    // the wire in clear.
    requireTLS: security === 'starttls',
    user,
    password,
    from,
    fromName: str(cfg[SMTP_FIELDS.fromName]),
  };
}

/** 465 is implicit TLS; everything else is assumed STARTTLS. */
function defaultSecurityFor(port: number): SmtpSecurity {
  return Number(port) === 465 ? 'tls' : 'starttls';
}

function str(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

/** Build a nodemailer transport. Lazy import — see the header. */
async function transportFor(settings: SmtpSettings) {
  const nodemailer = (await import('nodemailer')) as typeof import('nodemailer');
  return nodemailer.createTransport({
    host: settings.host,
    port: settings.port,
    secure: settings.secure,
    requireTLS: settings.requireTLS,
    auth: { user: settings.user, pass: settings.password },
    // A hung mail server must not hold a worker or a request open. These are
    // deliberately short: this runs inside an HTTP request during setup.
    connectionTimeout: 10_000,
    greetingTimeout: 10_000,
    socketTimeout: 15_000,
  });
}

const MISSING =
  'Enter the mail server address, username and password before connecting.';

export const smtpAdapter: SkillProviderAdapter = {
  key: 'email',

  /**
   * A real SMTP connect + AUTH. `transport.verify()` opens the socket,
   * negotiates TLS and authenticates, then disconnects — no message is sent, so
   * this is safe to run as often as the user presses the button.
   */
  async validateCredentials(input: AdapterInput): Promise<AdapterCheck> {
    const settings = resolveSmtpSettings(input);
    if (!settings) {
      return { ok: false, detail: MISSING, code: 'INVALID_CREDENTIALS' };
    }
    const transport = await transportFor(settings);
    try {
      await transport.verify();
      return {
        ok: true,
        detail: `Signed in to ${settings.host}:${settings.port} as ${settings.user}`,
      };
    } catch (error) {
      return {
        ok: false,
        detail: humanise(error, settings),
        code: smtpAdapter.classifyError(error),
      };
    } finally {
      transport.close();
    }
  },

  /**
   * The mailbox this connection sends as. There is no SMTP command that returns
   * an identity, so this is the configured From address — which IS the identity
   * that matters for §6 least-privilege assignment (HR AI → hr@company.com).
   */
  async discoverAccount(input: AdapterInput): Promise<DiscoveredAccount> {
    const settings = resolveSmtpSettings(input);
    if (!settings) return { account: null };
    return {
      account: settings.from,
      metadata: {
        host: settings.host,
        port: settings.port,
        security: settings.secure ? 'tls' : settings.requireTLS ? 'starttls' : 'none',
        // Recorded because a From address on a different domain to the login is
        // the single most common cause of mail landing in spam later.
        fromDomainMatchesUser:
          settings.from.split('@')[1]?.toLowerCase() ===
          settings.user.split('@')[1]?.toLowerCase(),
      },
    };
  },

  /**
   * §7 "Test Send". Sends a real message, so it only runs when the caller asked
   * for it and defaults to the connection's OWN address — a test that emails a
   * stranger is not a test, it is an incident.
   */
  async test(input: AdapterInput, opts?: { to?: string }): Promise<AdapterCheck> {
    const settings = resolveSmtpSettings(input);
    if (!settings) {
      return { ok: false, detail: MISSING, code: 'INVALID_CREDENTIALS' };
    }
    const to = (opts?.to ?? '').trim() || settings.from;
    const transport = await transportFor(settings);
    try {
      const info = await transport.sendMail({
        from: settings.fromName
          ? `${settings.fromName} <${settings.from}>`
          : settings.from,
        to,
        subject: 'Orlixa test email',
        text:
          'This is a test message from Orlixa confirming your email connection works.\n\n' +
          'If you did not expect this, someone in your company just connected this mailbox to Orlixa.',
      });
      return { ok: true, detail: `Test email accepted for delivery to ${to} (${info.messageId})` };
    } catch (error) {
      return {
        ok: false,
        detail: humanise(error, settings),
        code: smtpAdapter.classifyError(error),
      };
    } finally {
      transport.close();
    }
  },

  /**
   * §10 — the INBOUND half. Log in to IMAP and open the watched folder.
   *
   * Returns `assumed: true` when no IMAP host is configured: a send-only mailbox
   * is a legitimate, complete connection, so "inbound not set up" must read as
   * skipped rather than failed. Configuring a host and getting it WRONG, on the
   * other hand, is a real failure — otherwise a workflow would sit waiting for
   * email that is never polled, with every screen showing green.
   */
  async validateInbound(input: AdapterInput): Promise<AdapterCheck> {
    const settings = resolveImapSettings(input);
    if (!settings) {
      return {
        ok: true,
        assumed: true,
        detail:
          'No incoming (IMAP) server set — this mailbox can send, but Orlixa will not read it.',
      };
    }
    try {
      const summary = await withImap(settings, async (client) => {
        // `readOnly` so opening the folder can never mark anything \Seen. A
        // diagnostic that silently marks the customer's unread mail as read is
        // not a diagnostic.
        const lock = await client.getMailboxLock(settings.folder, { readOnly: true });
        try {
          const box = client.mailbox;
          const exists = typeof box === 'object' ? box.exists : 0;
          return `Opened ${settings.folder} on ${settings.host} (${exists} message${exists === 1 ? '' : 's'})`;
        } finally {
          lock.release();
        }
      });
      return { ok: true, detail: summary };
    } catch (error) {
      return {
        ok: false,
        detail: humaniseImap(error, settings.host, settings.port, settings.folder),
        code: smtpAdapter.classifyError(error),
      };
    }
  },

  /** §33 liveness: the same authenticated handshake, no send. */
  async healthCheck(input: AdapterInput): Promise<AdapterCheck> {
    return smtpAdapter.validateCredentials(input);
  },

  classifyError(error: unknown): ConnectionFailureCode {
    const code = String(
      (error as { code?: unknown; responseCode?: unknown })?.code ??
        (error as { responseCode?: unknown })?.responseCode ??
        '',
    ).toUpperCase();
    const text = (error instanceof Error ? error.message : String(error ?? '')).toLowerCase();

    if (code === 'EAUTH' || text.includes('invalid login') || text.includes('authentication failed')) {
      return 'INVALID_CREDENTIALS';
    }
    // Both the `code` AND the message are checked: nodemailer wraps a socket
    // failure as `code: 'ESOCKET'` and puts the real cause in the text
    // ("connect ECONNREFUSED 127.0.0.1:1"), so keying on `code` alone let a
    // plainly unreachable server fall through to the generic ERROR branch —
    // which then showed the customer a raw socket error instead of "check the
    // server address and port".
    const CONNECTION_CODES = [
      'ECONNECTION',
      'ECONNREFUSED',
      'ETIMEDOUT',
      'ESOCKET',
      'ENOTFOUND',
      'EDNS',
      'EHOSTUNREACH',
      'ENETUNREACH',
      'ECONNRESET',
    ];
    if (
      CONNECTION_CODES.includes(code) ||
      CONNECTION_CODES.some((c) => text.includes(c.toLowerCase())) ||
      text.includes('getaddrinfo') ||
      text.includes('timeout') ||
      text.includes('certificate') ||
      text.includes('self signed') ||
      text.includes('tls')
    ) {
      return 'CONNECTION_FAILED';
    }
    if (code === 'EENVELOPE' || text.includes('recipient') || text.includes('sender')) {
      return 'TEST_FAILED';
    }
    return 'ERROR';
  },
};

/**
 * Turn nodemailer's error into something a non-technical admin can act on.
 *
 * The raw errors are genuinely unhelpful ("Invalid login: 535-5.7.8 Username and
 * Password not accepted") and are the reason people give up at this step. Each
 * branch names the ONE thing to change.
 */
/**
 * The IMAP equivalent of {@link humanise}. Same reasoning: name the one thing to
 * change. A missing folder is called out separately because "Mailbox doesn't
 * exist" is the single most common IMAP setup mistake (people type "Inbox" on a
 * case-sensitive server, or a localised folder name).
 */
function humaniseImap(
  error: unknown,
  host: string,
  port: number,
  folder: string,
): string {
  const code = smtpAdapter.classifyError(error);
  const raw = error instanceof Error ? error.message : String(error ?? '');

  if (/no.*mailbox|mailbox.*not.*exist|nonexistent/i.test(raw)) {
    return `Signed in, but the folder "${folder}" doesn't exist on ${host}. Folder names are case-sensitive — INBOX is the usual value. (${raw})`;
  }
  if (code === 'INVALID_CREDENTIALS') {
    return (
      `The incoming mail server rejected the username or password. ` +
      `If this mailbox uses 2-factor sign-in, use the same app password you used for sending. (${raw})`
    );
  }
  if (code === 'CONNECTION_FAILED') {
    return (
      `Couldn't reach ${host} on port ${port}. Check the incoming server address, ` +
      `and that the port matches the security setting (993 for SSL/TLS, 143 for STARTTLS). (${raw})`
    );
  }
  return raw;
}

function humanise(error: unknown, settings: SmtpSettings): string {
  const code = smtpAdapter.classifyError(error);
  const raw = error instanceof Error ? error.message : String(error ?? '');

  if (code === 'INVALID_CREDENTIALS') {
    return (
      `The mail server rejected the username or password for ${settings.user}. ` +
      `If this mailbox is on Google Workspace or Microsoft 365 with 2-factor sign-in, ` +
      `you need an app password rather than the normal one. (${raw})`
    );
  }
  if (code === 'CONNECTION_FAILED') {
    return (
      `Couldn't reach ${settings.host} on port ${settings.port}. ` +
      `Check the server address, and that the port matches the security setting ` +
      `(465 for SSL/TLS, 587 for STARTTLS). (${raw})`
    );
  }
  if (code === 'TEST_FAILED') {
    return (
      `The server accepted the sign-in but refused the message. ` +
      `This usually means the From address (${settings.from}) is not one this ` +
      `mailbox is allowed to send as. (${raw})`
    );
  }
  return raw;
}
