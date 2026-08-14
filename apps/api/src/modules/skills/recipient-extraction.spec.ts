import { extractRecipients } from './recipient-extraction';

describe('recipient extraction (WAVE 3 §3.6)', () => {
  it('pulls to/cc/bcc from an email send', () => {
    const r = extractRecipients('gmail', 'send_email', {
      to: 'a@example.com',
      cc: 'b@example.com',
      bcc: 'c@example.com',
      subject: 'hi',
    });
    expect(r?.channel).toBe('EMAIL');
    expect(r?.addresses.sort()).toEqual([
      'a@example.com',
      'b@example.com',
      'c@example.com',
    ]);
  });

  it('splits a multi-recipient field', () => {
    const r = extractRecipients('email', 'send_email', {
      to: 'a@example.com, b@example.com; c@example.com',
    });
    expect(r?.addresses).toHaveLength(3);
  });

  it('accepts an array of recipients', () => {
    const r = extractRecipients('gmail', 'send_email', {
      to: ['a@example.com', 'b@example.com'],
    });
    expect(r?.addresses).toHaveLength(2);
  });

  it('unwraps a display name', () => {
    const r = extractRecipients('gmail', 'send_email', {
      to: 'Alice Example <alice@example.com>',
    });
    expect(r?.addresses).toEqual(['alice@example.com']);
  });

  it('returns null for a tool that addresses nobody', () => {
    // A Slack channel post is not addressed to a person, so there is nothing to
    // suppress against — and treating it as if there were would block
    // legitimate broadcasts.
    expect(
      extractRecipients('slack', 'send_message', {
        channel: '#general',
        text: 'hello',
      }),
    ).toBeNull();
  });

  it('does NOT scan the message body for anything email-shaped', () => {
    // The tempting heuristic. It would block a legitimate send whose BODY quotes
    // a suppressed customer's address — and would still miss a recipient in a
    // field the heuristic did not anticipate.
    const r = extractRecipients('gmail', 'send_email', {
      to: 'ok@example.com',
      body: 'Please follow up with suppressed@example.com about the refund.',
    });
    expect(r?.addresses).toEqual(['ok@example.com']);
  });

  it('returns null when the recipient field is empty', () => {
    expect(extractRecipients('gmail', 'send_email', { to: '   ' })).toBeNull();
  });
});
