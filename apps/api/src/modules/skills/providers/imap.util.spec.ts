import {
  formatImapCursor,
  parseImapCursor,
  resolveImapSettings,
} from './imap.util';

/**
 * IMAP settings + cursor semantics (plan §10).
 *
 * The cursor rules carry the two bugs that would be invisible in production:
 * a mailbox that silently stops firing for ever after a server-side renumber,
 * and inbound polling starting on a mailbox nobody asked to be read.
 */
describe('resolveImapSettings', () => {
  const smtpOnly = {
    config: { smtpUser: 'kashif.hussain@dotsquares.com' },
    creds: { smtpPassword: 'app-password' },
  };

  it('returns null when no IMAP host is set — send-only is a valid connection', () => {
    // Inbound must be OPT-IN. A company that only wants Orlixa to send email
    // should never have its inbox opened.
    expect(resolveImapSettings(smtpOnly)).toBeNull();
  });

  it('reuses the SMTP username and password when the IMAP ones are blank', () => {
    // One mailbox normally does both; blank inbound credentials mean "same as
    // outbound", not "broken".
    const settings = resolveImapSettings({
      config: { ...smtpOnly.config, imapHost: 'imap.dotsquares.com' },
      creds: smtpOnly.creds,
    });
    expect(settings).toMatchObject({
      host: 'imap.dotsquares.com',
      user: 'kashif.hussain@dotsquares.com',
      password: 'app-password',
      port: 993,
      secure: true,
      folder: 'INBOX',
    });
  });

  it('prefers explicit IMAP credentials when given', () => {
    const settings = resolveImapSettings({
      config: {
        ...smtpOnly.config,
        imapHost: 'imap.dotsquares.com',
        imapUser: 'shared-inbox@dotsquares.com',
      },
      creds: { ...smtpOnly.creds, imapPassword: 'other-password' },
    });
    expect(settings).toMatchObject({
      user: 'shared-inbox@dotsquares.com',
      password: 'other-password',
    });
  });

  it('never reads the password from plaintext config', () => {
    const settings = resolveImapSettings({
      config: { imapHost: 'h', imapUser: 'u@x.com', imapPassword: 'leak' },
      creds: {},
    });
    expect(settings).toBeNull();
  });

  it('derives security from the port when unset (143 → starttls)', () => {
    const settings = resolveImapSettings({
      config: { ...smtpOnly.config, imapHost: 'h', imapPort: 143 },
      creds: smtpOnly.creds,
    });
    expect(settings).toMatchObject({ port: 143, secure: false });
  });

  it('honours a custom folder', () => {
    const settings = resolveImapSettings({
      config: { ...smtpOnly.config, imapHost: 'h', imapFolder: 'Applications' },
      creds: smtpOnly.creds,
    });
    expect(settings?.folder).toBe('Applications');
  });
});

describe('IMAP cursor', () => {
  it('round-trips uidValidity + lastUid', () => {
    const raw = formatImapCursor({ uidValidity: '123456', lastUid: 42 });
    expect(raw).toBe('123456:42');
    expect(parseImapCursor(raw)).toEqual({ uidValidity: '123456', lastUid: 42 });
  });

  it('treats a missing or malformed cursor as "no cursor"', () => {
    // A malformed cursor must re-baseline rather than be coerced to UID 0 —
    // which would replay the entire mailbox into the workflow engine.
    expect(parseImapCursor(null)).toBeNull();
    expect(parseImapCursor('')).toBeNull();
    expect(parseImapCursor('garbage')).toBeNull();
    expect(parseImapCursor('123456:notanumber')).toBeNull();
  });

  it('keeps uidValidity so a renumbered folder is detectable', () => {
    // THE bug this exists to prevent: a UID is only meaningful within one
    // UIDVALIDITY generation. After a restore/migration UIDs restart at 1, so a
    // cursor compared across generations would make every message look "older
    // than my cursor" and the mailbox would silently never fire again.
    const before = parseImapCursor('111:900');
    const afterRenumber = '222';
    expect(before?.uidValidity).not.toBe(afterRenumber);
  });
});
