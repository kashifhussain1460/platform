/**
 * Tolerant JSON extraction for LLM output.
 *
 * Models are asked for "only JSON" and frequently answer with a ```json fence,
 * a sentence of preamble, or both. A strict `JSON.parse` of the whole string
 * then fails and the caller burns a retry on a response that was actually fine
 * — the defect recorded as G35 against `WorkflowGeneratorService.parseResponse`.
 *
 * Shared by the workflow generator and the assist agent so the tolerance rules
 * are identical in both, and improving one improves both.
 */

/** Strip a leading/trailing markdown code fence, if the whole string is one. */
function stripFence(raw: string): string {
  const fence = /^\s*```(?:json|JSON)?\s*\n?([\s\S]*?)\n?\s*```\s*$/;
  const m = fence.exec(raw);
  return m ? m[1] : raw;
}

/**
 * Return the outermost balanced `{…}` (or `[…]`) span, ignoring braces that sit
 * inside string literals. Scanning rather than regex-matching is what makes a
 * nested object with braces in its string values survive.
 */
function outermostSpan(raw: string): string | null {
  const start = raw.search(/[{[]/);
  if (start === -1) return null;

  const open = raw[start];
  const close = open === '{' ? '}' : ']';
  let depth = 0;
  let inString = false;
  let escaped = false;

  for (let i = start; i < raw.length; i += 1) {
    const ch = raw[i];

    if (inString) {
      if (escaped) escaped = false;
      else if (ch === '\\') escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }

    if (ch === '"') inString = true;
    else if (ch === open) depth += 1;
    else if (ch === close) {
      depth -= 1;
      if (depth === 0) return raw.slice(start, i + 1);
    }
  }
  return null; // unbalanced — truncated output
}

/**
 * Best-effort parse of a JSON value out of model output. Returns `null` rather
 * than throwing: malformed model output is an expected condition to be fed back
 * for self-correction, not an exception.
 */
export function extractJson<T = unknown>(raw: string | undefined): T | null {
  if (!raw) return null;

  const candidates = [raw, stripFence(raw)];
  const span = outermostSpan(stripFence(raw));
  if (span) candidates.push(span);

  for (const candidate of candidates) {
    const trimmed = candidate.trim();
    if (!trimmed) continue;
    try {
      return JSON.parse(trimmed) as T;
    } catch {
      // Try the next, more aggressive, candidate.
    }
  }
  return null;
}
