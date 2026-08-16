import { Logger } from '@nestjs/common';
import { extractInboundAttachments } from './attachment-extraction';

/**
 * Inbound MIME + attachment extraction.
 *
 * These use REAL RFC822 messages parsed by the real parser, because the failure
 * mode being guarded is silent: a mis-parsed multipart does not throw, it just
 * produces an empty or mangled `cv` — and the HR workflow then scores a real
 * candidate on nothing at all, with every screen showing success.
 */

/** A realistic multipart CV email: text + HTML alternative + a PDF attachment. */
function buildCvEmail(): Buffer {
  const pdfBytes = Buffer.from('%PDF-1.4 fake pdf body', 'utf8').toString('base64');
  const cvText = Buffer.from(
    'Kashif Hussain\nSenior Node.js Developer\n8 years experience\n',
    'utf8',
  ).toString('base64');
  return Buffer.from(
    [
      'From: Kashif Hussain <kashif.hussain@example.com>',
      'To: careers@dotsquares.com',
      // RFC 2047 encoded-word: a hand-rolled parser shows the raw gibberish.
      'Subject: =?UTF-8?B?QXBwbGljYXRpb24gZm9yIE5vZGUgRGV2ZWxvcGVy?=',
      'Message-ID: <cv-001@example.com>',
      'Date: Fri, 15 Aug 2026 09:00:00 +0000',
      'MIME-Version: 1.0',
      'Content-Type: multipart/mixed; boundary="OUTER"',
      '',
      '--OUTER',
      // Nested multipart — the shape a hand-rolled "split on blank line" misses.
      'Content-Type: multipart/alternative; boundary="INNER"',
      '',
      '--INNER',
      'Content-Type: text/plain; charset=utf-8',
      'Content-Transfer-Encoding: quoted-printable',
      '',
      'Dear Hiring Team,=0D=0A=0D=0APlease find my CV attached.',
      '',
      '--INNER',
      'Content-Type: text/html; charset=utf-8',
      '',
      '<p>Dear Hiring Team,</p><p>Please find my CV attached.</p>',
      '',
      '--INNER--',
      '',
      '--OUTER',
      'Content-Type: application/pdf; name="kashif-cv.pdf"',
      'Content-Disposition: attachment; filename="kashif-cv.pdf"',
      'Content-Transfer-Encoding: base64',
      '',
      pdfBytes,
      '',
      '--OUTER',
      'Content-Type: text/plain; name="cover.txt"',
      'Content-Disposition: attachment; filename="cover.txt"',
      'Content-Transfer-Encoding: base64',
      '',
      cvText,
      '',
      '--OUTER',
      // An inline signature image — must NOT clutter the attachment list.
      'Content-Type: image/png; name="logo.png"',
      'Content-Disposition: inline',
      'Content-Transfer-Encoding: base64',
      '',
      Buffer.from('fakepng').toString('base64'),
      '',
      '--OUTER--',
      '',
    ].join('\r\n'),
    'utf8',
  );
}

describe('inbound MIME parsing (mailparser)', () => {
  it('decodes a nested multipart, quoted-printable body and encoded subject', async () => {
    const { simpleParser } = await import('mailparser');
    const parsed = await simpleParser(buildCvEmail());

    // A hand-rolled parser typically returns the raw =?UTF-8?B?…?= here.
    expect(parsed.subject).toBe('Application for Node Developer');
    expect(parsed.from?.value?.[0]?.address).toBe('kashif.hussain@example.com');
    expect(parsed.messageId).toBe('<cv-001@example.com>');
    // quoted-printable `=0D=0A` decoded to real newlines, from the INNER part.
    expect(parsed.text).toContain('Dear Hiring Team');
    expect(parsed.text).toContain('Please find my CV attached.');
  });

  it('finds BOTH document attachments and decodes their bytes', async () => {
    const { simpleParser } = await import('mailparser');
    const parsed = await simpleParser(buildCvEmail());
    const names = (parsed.attachments ?? []).map((a) => a.filename);
    expect(names).toContain('kashif-cv.pdf');
    expect(names).toContain('cover.txt');

    const cover = parsed.attachments!.find((a) => a.filename === 'cover.txt')!;
    // Base64 decoded back to the original text — the whole point.
    expect(cover.content.toString('utf8')).toContain('Senior Node.js Developer');
  });
});

describe('ImapInboundService.toInboundEmail (the whole flatten path)', () => {
  /** Build the service with no real dependencies — this method touches none. */
  async function flatten(source: Buffer) {
    const { ImapInboundService } = await import('./imap-inbound.service');
    const service = new ImapInboundService(
      {} as never,
      {} as never,
      {} as never,
      {} as never,
    );
    return (
      service as unknown as {
        toInboundEmail(
          msg: { uid: number; source: Buffer; envelope?: unknown },
          settings: { host: string; folder: string },
        ): Promise<{
          messageId: string;
          from: string | null;
          subject: string | null;
          body: string | null;
          cv: string | null;
          attachments: Array<{ filename: string; skipped?: boolean }>;
          isReply: boolean;
          looksLikeApplication: boolean;
        } | null>;
      }
    ).toInboundEmail({ uid: 42, source }, { host: 'imap.dotsquares.com', folder: 'INBOX' });
  }

  // Parses a real PDF, so it is genuinely slower than Jest's 5s default —
  // which it exceeded under full-suite load while passing in isolation.
  it('produces the full inbound-email shape, CV text included', async () => {
    const email = await flatten(buildCvEmail());

    expect(email).not.toBeNull();
    expect(email!.messageId).toBe('<cv-001@example.com>');
    expect(email!.from).toBe('kashif.hussain@example.com');
    expect(email!.subject).toBe('Application for Node Developer');
    expect(email!.body).toContain('Please find my CV attached.');
    // THE point of this whole piece of work: an own-domain mailbox now yields
    // CV text, so the HR scoring step has something real to read.
    expect(email!.cv).toContain('# cover.txt');
    expect(email!.cv).toContain('Senior Node.js Developer');
    expect(email!.looksLikeApplication).toBe(true);
    expect(email!.isReply).toBe(false);
  }, 20_000);

  it('keeps the inline signature image out of the attachment list', async () => {
    const email = await flatten(buildCvEmail());
    const names = email!.attachments.map((a) => a.filename);
    // Otherwise every candidate's record fills with
    // "logo.png skipped: unsupported file type" noise.
    expect(names).not.toContain('logo.png');
    expect(names).toContain('kashif-cv.pdf');
    expect(names).toContain('cover.txt');
  });

  it('detects a threaded reply so it is not re-scored as a new application', async () => {
    const reply = Buffer.from(
      [
        'From: Kashif Hussain <kashif.hussain@example.com>',
        'To: careers@dotsquares.com',
        'Subject: Re: Application for Node Developer',
        'Message-ID: <reply-001@example.com>',
        'In-Reply-To: <cv-001@example.com>',
        'References: <cv-001@example.com>',
        'Content-Type: text/plain; charset=utf-8',
        '',
        'Thanks for the update!',
        '',
      ].join('\r\n'),
      'utf8',
    );
    const email = await flatten(reply);
    // Fires NEW_EMAIL_REPLY instead of NEW_EMAIL, so a candidate replying to
    // their own rejection is never fed back into the scoring step.
    expect(email!.isReply).toBe(true);
  });

  it('falls back to the HTML part when there is no text/plain', async () => {
    const htmlOnly = Buffer.from(
      [
        'From: a@b.com',
        'Subject: HTML only',
        'Message-ID: <html-1@b.com>',
        'MIME-Version: 1.0',
        'Content-Type: text/html; charset=utf-8',
        '',
        '<p>Hello</p><p>World</p>',
        '',
      ].join('\r\n'),
      'utf8',
    );
    const email = await flatten(htmlOnly);
    expect(email!.body).toContain('Hello');
    expect(email!.body).toContain('World');
    expect(email!.body).not.toContain('<p>');
  });
});

describe('extractInboundAttachments', () => {
  const logger = new Logger('test');

  it('extracts CV text and reports the character count', async () => {
    const result = await extractInboundAttachments(
      [
        {
          filename: 'cover.txt',
          mimeType: 'text/plain',
          load: async () => Buffer.from('Kashif Hussain — 8 years Node.js', 'utf8'),
        },
      ],
      logger,
      'IMAP',
    );

    expect(result.cv).toContain('# cover.txt');
    expect(result.cv).toContain('8 years Node.js');
    expect(result.attachments[0].filename).toBe('cover.txt');
    // A parsed attachment carries NO `skipped` key at all — that absence is
    // what `looksLikeApplication` and the UI key off.
    expect(result.attachments[0].skipped).toBeUndefined();
    expect(result.attachments[0].chars).toBeGreaterThan(0);
  });

  it('RECORDS an unsupported type as skipped, with a reason (REC-13)', async () => {
    // Not merely logged: a candidate whose CV was a scanned image was otherwise
    // scored on their email body alone, with nothing anywhere explaining why.
    const result = await extractInboundAttachments(
      [
        {
          filename: 'photo.png',
          mimeType: 'image/png',
          load: async () => Buffer.from('x'),
        },
      ],
      logger,
      'IMAP',
    );

    expect(result.cv).toBeNull();
    expect(result.attachments[0]).toMatchObject({
      filename: 'photo.png',
      chars: 0,
      skipped: true,
    });
    expect(result.attachments[0].skipReason).toMatch(/unsupported file type/i);
  });

  it('does not download an attachment that fails the declared-size gate', async () => {
    const load = jest.fn();
    const result = await extractInboundAttachments(
      [
        {
          filename: 'huge.pdf',
          mimeType: 'application/pdf',
          declaredSize: 50 * 1024 * 1024,
          load,
        },
      ],
      logger,
      'Gmail',
    );

    // The cheap gate must run FIRST — otherwise Gmail pays to download a file
    // it is about to throw away.
    expect(load).not.toHaveBeenCalled();
    expect(result.attachments[0].skipReason).toMatch(/over the size cap/i);
  });

  it('records an empty extraction as a skip rather than a silent pass', async () => {
    const result = await extractInboundAttachments(
      [
        {
          filename: 'scanned.pdf',
          mimeType: 'application/pdf',
          // Not a real PDF → the extractor yields nothing.
          load: async () => Buffer.from('not really a pdf'),
        },
      ],
      logger,
      'IMAP',
    );
    expect(result.cv).toBeNull();
    expect(result.attachments[0].skipped).toBe(true);
    expect(result.attachments[0].skipReason).toBeTruthy();
  });

  it('never throws when one attachment fails — a poll survives a bad file', async () => {
    const result = await extractInboundAttachments(
      [
        {
          filename: 'broken.pdf',
          mimeType: 'application/pdf',
          load: async () => {
            throw new Error('stream closed');
          },
        },
        {
          filename: 'good.txt',
          mimeType: 'text/plain',
          load: async () => Buffer.from('still readable', 'utf8'),
        },
      ],
      logger,
      'IMAP',
    );

    expect(result.attachments).toHaveLength(2);
    expect(result.attachments[0].skipReason).toMatch(/parse error/i);
    // The good one still made it through.
    expect(result.cv).toContain('still readable');
  });

  it('bounds how many attachments it will inspect', async () => {
    const many = Array.from({ length: 25 }, (_, i) => ({
      filename: `f${i}.txt`,
      mimeType: 'text/plain',
      load: async () => Buffer.from(`file ${i}`, 'utf8'),
    }));
    const result = await extractInboundAttachments(many, logger, 'IMAP');
    expect(result.attachments.length).toBeLessThanOrEqual(10);
  });
});
