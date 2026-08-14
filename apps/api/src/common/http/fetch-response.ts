/**
 * Minimal shape of the global `fetch()` Response actually used across the
 * codebase. Cast every `fetch()` result through this instead of trusting the
 * ambient global `Response` type — `@types/node`'s fetch typings live behind
 * a `typesVersions` redirect keyed on the resolved TypeScript version, which
 * can differ between build environments (observed dropping `ok`/`status`/
 * `text`/`json` on Vercel's Node function type-check pass, which resolves a
 * different tsconfig than our own `nest build`).
 */
export interface FetchResponseLike {
  ok: boolean;
  status: number;
  headers: { get(name: string): string | null };
  text(): Promise<string>;
  json(): Promise<unknown>;
  /** Present on a real fetch Response; absent on hand-rolled test doubles. */
  body?: {
    getReader(): {
      read(): Promise<{ done: boolean; value?: Uint8Array }>;
      cancel(): Promise<void>;
    };
  } | null;
}

export function asFetchResponse(res: unknown): FetchResponseLike {
  return res as FetchResponseLike;
}

/**
 * WAVE 2 §2.6 — read a response body with a HARD byte cap.
 *
 * `await res.text()` buffers the WHOLE body before anything can truncate it, so
 * a caller that "limits" the result by slicing the string afterwards has already
 * allocated it. A hostile or merely broken endpoint returning a multi-gigabyte
 * (or endless, chunked) body then takes the process down with it — the cap reads
 * as a protection while providing none.
 *
 * This stops READING at the limit, so the memory ceiling is the limit itself.
 * Falls back to `text()` only when the runtime gives us no stream, which is the
 * case for hand-rolled test doubles rather than for real traffic.
 */
export async function readCappedText(
  res: FetchResponseLike,
  maxBytes: number,
): Promise<{ text: string; truncated: boolean }> {
  // Cheap pre-check: a well-behaved server that declares an oversized body is
  // rejected before a single chunk is transferred.
  const declared = Number(res.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > maxBytes) {
    return { text: '', truncated: true };
  }

  const reader = res.body?.getReader?.();
  if (!reader) {
    const text = await res.text();
    return text.length > maxBytes
      ? { text: text.slice(0, maxBytes), truncated: true }
      : { text, truncated: false };
  }

  const chunks: Uint8Array[] = [];
  let total = 0;
  let truncated = false;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (!value) continue;
    total += value.byteLength;
    if (total > maxBytes) {
      chunks.push(value.subarray(0, value.byteLength - (total - maxBytes)));
      truncated = true;
      // Stop the transfer; we already have everything we are willing to keep.
      await reader.cancel().catch(() => undefined);
      break;
    }
    chunks.push(value);
  }
  return { text: Buffer.concat(chunks).toString('utf8'), truncated };
}
