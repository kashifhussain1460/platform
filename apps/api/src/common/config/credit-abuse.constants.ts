import {
  KNOWLEDGE_UPLOAD_ALLOWED_EXTENSIONS,
  KNOWLEDGE_UPLOAD_DEFAULT_MAX_BYTES,
} from '@vaep/types';

/**
 * Credit system Phase 10, Task 10.6 (§26) — the remaining Option-A
 * conservative, fixed, env-overridable abuse-prevention constants: the
 * signup domain-velocity window (extends Task 4.2's counter, which had this
 * inline as a magic number) and a knowledge-upload size ceiling (closes the
 * confirmed gap that `FileInterceptor('file')` had no `limits.fileSize` at
 * all — an unbounded upload is buffered fully in memory before any other
 * check runs).
 */

/** How long a domain's free-grant count accumulates before resetting (Task 4.2). */
export function signupDomainVelocityWindowMs(): number {
  const raw = Number(process.env.SIGNUP_DOMAIN_VELOCITY_WINDOW_MS);
  return Number.isFinite(raw) && raw > 0 ? raw : 24 * 60 * 60 * 1000; // 24h
}

/** Max bytes for one knowledge-document upload, checked BEFORE ingestion — independent of credit balance. */
export function knowledgeUploadMaxBytes(): number {
  const raw = Number(process.env.KNOWLEDGE_UPLOAD_MAX_BYTES);
  return Number.isFinite(raw) && raw > 0 ? raw : KNOWLEDGE_UPLOAD_DEFAULT_MAX_BYTES;
}

/**
 * Live-discovered gap (closed here): `FileInterceptor('file')` had a size
 * limit but no `fileFilter` at all — any file extension was accepted and
 * silently marked READY. `extractText` (knowledge.util.ts) only has real
 * parsers for PDF and DOCX; everything else (including a binary file with
 * neither extension, e.g. a renamed image) falls through to a raw UTF-8
 * decode of the bytes, which for a non-text file produces garbled content
 * that still gets chunked and embedded with no error — a silently corrupted
 * knowledge base, not a rejected upload. Restricted to the types the wizard
 * UI actually advertises and the extractor actually knows how to read: PDF,
 * DOCX, TXT, MD. (Legacy binary `.doc` is deliberately NOT included — there
 * is no real parser for it either, and it would hit the same silent-garbage
 * path; the older UI copy claiming "DOC" support was itself inaccurate.)
 */
export const KNOWLEDGE_UPLOAD_ALLOWED_MIME_TYPES = [
  'application/pdf',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'text/plain',
  'text/markdown',
] as const;

// Extensions accepted alongside the mimetypes above — browsers are inconsistent
// about reporting `text/markdown` (some send `text/plain` or a blank mimetype
// for `.md`), so the extension is checked too, same dual-check `extractText`
// already does for PDF/DOCX. Shared with the frontend via `@vaep/types`
// (KNOWLEDGE_UPLOAD_ALLOWED_EXTENSIONS) so the two lists can't drift apart.
export function isAllowedKnowledgeUpload(mimetype: string, filename: string): boolean {
  const lower = filename.toLowerCase();
  return (
    (KNOWLEDGE_UPLOAD_ALLOWED_MIME_TYPES as readonly string[]).includes(mimetype) ||
    (KNOWLEDGE_UPLOAD_ALLOWED_EXTENSIONS as readonly string[]).some((ext) => lower.endsWith(ext))
  );
}
