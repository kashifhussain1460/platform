/**
 * Shared helpers for the knowledge module: pgvector literal formatting, text
 * chunking, and (lazy) text extraction. Kept pure/framework-free so they are
 * trivial to unit-test and reuse from both the service and the ingestion worker.
 */

/** Serialize an embedding to the pgvector text literal format: `[0.1,0.2,...]`. */
export function toVectorLiteral(vec: number[]): string {
  return `[${vec.join(',')}]`;
}

/**
 * Split text into overlapping, roughly fixed-size chunks (~1000 chars, ~150
 * overlap). Whitespace is collapsed first so chunk boundaries are stable.
 */
export function chunkText(text: string, size = 1000, overlap = 150): string[] {
  const clean = text.replace(/\s+/g, ' ').trim();
  if (!clean) {
    return [];
  }
  if (clean.length <= size) {
    return [clean];
  }
  const step = Math.max(1, size - overlap);
  const chunks: string[] = [];
  for (let start = 0; start < clean.length; start += step) {
    chunks.push(clean.slice(start, start + size));
    if (start + size >= clean.length) {
      break;
    }
  }
  return chunks;
}

/**
 * Extract plain text from an uploaded document. txt/md/plain are decoded as
 * utf-8; PDFs are parsed with a lazily-imported `pdf-parse` (the internal lib
 * path avoids its debug harness that reads a bundled test file at import time);
 * DOCX (docs/test-cases REC-10 — previously a resume in this format was
 * invisible to scoring, same failure mode as an unsupported CV attachment) is
 * parsed with a lazily-imported `mammoth`.
 */
export async function extractText(
  bytes: Buffer,
  mimeType: string,
  filename: string,
): Promise<string> {
  const name = filename.toLowerCase();
  const isPdf = mimeType === 'application/pdf' || name.endsWith('.pdf');
  if (isPdf) {
     
    // @ts-expect-error pdf-parse has no types for its internal lib entrypoint
    const mod = await import('pdf-parse/lib/pdf-parse.js');
    const pdfParse = (mod.default ?? mod) as (
      data: Buffer,
    ) => Promise<{ text: string }>;
    const parsed = await pdfParse(bytes);
    return parsed.text;
  }
  const isDocx =
    mimeType ===
      'application/vnd.openxmlformats-officedocument.wordprocessingml.document' ||
    name.endsWith('.docx');
  if (isDocx) {
    const mammoth = await import('mammoth');
    const parsed = await mammoth.extractRawText({ buffer: bytes });
    return parsed.value;
  }
  return bytes.toString('utf8');
}
