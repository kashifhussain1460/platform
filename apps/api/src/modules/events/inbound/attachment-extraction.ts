import { Logger } from '@nestjs/common';
import { extractText } from '../../knowledge/knowledge.util';
import {
  GMAIL_ATTACHMENT_MAX_BYTES,
  GMAIL_ATTACHMENT_MAX_CHARS,
  GMAIL_MAX_ATTACHMENTS,
} from '../events.constants';

/**
 * Inbound-email attachment extraction, shared by EVERY mail transport.
 *
 * ## Why this is one function and not two
 *
 * Gmail and IMAP differ in exactly one respect — where the bytes come from
 * (an authenticated API download vs a MIME part already in memory). Everything
 * that MATTERS is identical: which file types are readable, the size and
 * character caps, the `# filename\ntext` format the AI step reads, and the
 * REC-13 rule that a skipped attachment must be RECORDED rather than merely
 * logged.
 *
 * Duplicating that per transport would let the two drift, and the way it would
 * surface is ugly: the same candidate's CV scored one way when they emailed a
 * Gmail-connected inbox and another way when they emailed the company's own
 * mailbox, with nothing in the run to explain the difference.
 *
 * The caps stay named `GMAIL_*` because they are already exported, referenced
 * and tested under those names; renaming them is churn for no behaviour change.
 * They are transport-agnostic limits despite the prefix.
 */

/**
 * Bounded attachment metadata carried into the trigger payload (never the full
 * text). A skipped attachment is recorded here too (docs/test-cases REC-13):
 * without it, a good candidate whose CV happened to be a scanned image was
 * silently scored on their email body alone, with no visible reason anywhere.
 */
export interface InboundAttachment {
  filename: string;
  chars: number;
  /** Present only for a skipped attachment; absent means it parsed fine. */
  skipped?: boolean;
  skipReason?: string;
}

/**
 * One attachment to consider. `load` is a thunk so a transport that must
 * DOWNLOAD the bytes (Gmail) does not pay for attachments the type/size gate
 * rejects anyway — the cheap checks run first.
 */
export interface AttachmentCandidate {
  filename: string;
  /** Declared MIME type, if the transport knows it. */
  mimeType?: string;
  /** Declared size in bytes, if known — checked BEFORE downloading. */
  declaredSize?: number;
  load: () => Promise<Buffer | null>;
}

export interface ExtractedAttachments {
  /** Concatenated text of every parsed attachment, or null when none parsed. */
  cv: string | null;
  attachments: InboundAttachment[];
}

/** Which types we can actually read text out of. */
function classify(filename: string, mimeType: string | undefined) {
  const mime = (mimeType ?? '').toLowerCase();
  const lower = filename.toLowerCase();
  const isPdf = mime === 'application/pdf' || lower.endsWith('.pdf');
  const isDocx =
    mime ===
      'application/vnd.openxmlformats-officedocument.wordprocessingml.document' ||
    lower.endsWith('.docx');
  const isText = mime.startsWith('text/') || lower.endsWith('.txt');
  return { isPdf, isDocx, isText, mime, supported: isPdf || isDocx || isText };
}

/**
 * Extract text from each candidate. Never throws: a per-attachment failure is
 * recorded as a skip, so one unreadable file can never fail an entire poll.
 */
export async function extractInboundAttachments(
  candidates: AttachmentCandidate[],
  logger: Logger,
  label: string,
): Promise<ExtractedAttachments> {
  const texts: string[] = [];
  const attachments: InboundAttachment[] = [];

  const skip = (filename: string, reason: string) => {
    logger.warn(`${label} attachment "${filename}" skipped: ${reason}`);
    attachments.push({ filename, chars: 0, skipped: true, skipReason: reason });
  };

  for (const candidate of candidates.slice(0, GMAIL_MAX_ATTACHMENTS)) {
    const filename = candidate.filename;
    try {
      // Cheap gates first, so an oversized or unreadable file is never fetched.
      if (
        typeof candidate.declaredSize === 'number' &&
        candidate.declaredSize > GMAIL_ATTACHMENT_MAX_BYTES
      ) {
        skip(filename, `${candidate.declaredSize}B over the size cap`);
        continue;
      }
      const kind = classify(filename, candidate.mimeType);
      if (!kind.supported) {
        skip(filename, `unsupported file type (${kind.mime || 'unknown'})`);
        continue;
      }

      const bytes = await candidate.load();
      if (!bytes || bytes.length === 0) {
        skip(filename, 'download returned no data');
        continue;
      }
      if (bytes.length > GMAIL_ATTACHMENT_MAX_BYTES) {
        skip(filename, `${bytes.length}B over the size cap`);
        continue;
      }

      // Reuse the knowledge module's extractor (PDF → pdf-parse, DOCX →
      // mammoth, else utf8) so a CV read from an email and the SAME CV
      // uploaded to the knowledge base produce identical text.
      const raw = await extractText(
        bytes,
        kind.isPdf
          ? 'application/pdf'
          : kind.isDocx
            ? 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
            : 'text/plain',
        filename,
      );
      const text = (raw ?? '').trim().slice(0, GMAIL_ATTACHMENT_MAX_CHARS);
      if (!text) {
        skip(filename, 'no extractable text (possibly a scanned/image-only file)');
        continue;
      }
      texts.push(`# ${filename}\n${text}`);
      attachments.push({ filename, chars: text.length });
    } catch (err) {
      skip(
        filename,
        `parse error: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  return { cv: texts.length > 0 ? texts.join('\n\n') : null, attachments };
}
