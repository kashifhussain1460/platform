/**
 * WAVE 3 §3.6 — which tool arguments name a PERSON we are about to contact.
 *
 * Suppression can only be enforced if we know who a call is addressed to, and
 * that is tool-specific: `gmail.send_email` addresses `to`/`cc`/`bcc`, while
 * `slack.send_message` addresses a channel (nobody in particular). Encoded as
 * data rather than scattered `if (tool === …)` checks, so adding a
 * person-facing tool is one line here instead of a rule someone has to remember.
 *
 * Deliberately NOT a heuristic over every string argument. Scanning args for
 * anything email-shaped would suppress on an address that merely appears in a
 * message BODY — blocking a legitimate send because it quoted a customer's
 * address — and would still miss a recipient in a field the heuristic did not
 * anticipate. Explicit is both safer and more predictable.
 */
export type RecipientChannel = 'EMAIL' | 'SMS' | 'SOCIAL';

interface RecipientRule {
  channel: RecipientChannel;
  /** Argument keys that carry an address of a real person. */
  keys: readonly string[];
}

const RECIPIENT_RULES: Record<string, RecipientRule> = {
  'gmail.send_email': { channel: 'EMAIL', keys: ['to', 'cc', 'bcc'] },
  'email.send_email': { channel: 'EMAIL', keys: ['to', 'cc', 'bcc'] },
  // A Chatwoot reply goes to whoever is in the conversation, addressed by
  // conversation rather than by address, so it cannot be checked here — it is
  // covered by the contact's own suppression at the point the conversation is
  // created. Recorded as a known limitation rather than a silent gap.
};

export interface ExtractedRecipients {
  channel: RecipientChannel;
  addresses: string[];
}

/** Recipients a `skillKey.tool` call is addressed to, or null if it addresses nobody. */
export function extractRecipients(
  skillKey: string,
  tool: string,
  args: Record<string, unknown>,
): ExtractedRecipients | null {
  const rule = RECIPIENT_RULES[`${skillKey}.${tool}`];
  if (!rule) return null;

  const addresses: string[] = [];
  for (const key of rule.keys) {
    const value = args[key];
    if (typeof value === 'string') {
      // One field may carry several, comma- or semicolon-separated.
      addresses.push(...value.split(/[,;]/));
    } else if (Array.isArray(value)) {
      addresses.push(...value.filter((v): v is string => typeof v === 'string'));
    }
  }

  const cleaned = addresses
    .map((a) => extractAddress(a))
    .filter((a): a is string => Boolean(a));

  return cleaned.length > 0 ? { channel: rule.channel, addresses: cleaned } : null;
}

/** `"Alice <a@b.com>"` → `a@b.com`; a bare address passes through. */
function extractAddress(raw: string): string | null {
  const trimmed = raw.trim();
  if (!trimmed) return null;
  const angled = /<([^>]+)>/.exec(trimmed);
  return (angled?.[1] ?? trimmed).trim() || null;
}
