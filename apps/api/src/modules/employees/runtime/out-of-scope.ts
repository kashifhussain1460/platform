/**
 * Telling a REFUSAL apart from an ANSWER.
 *
 * Every AI Employee runs under a hard role boundary: an HR employee asked to
 * screen a CV must decline rather than half-do recruiting work. That part works.
 * What did not work is what the platform then did with the decline — a workflow
 * step whose employee politely refused was recorded COMPLETED, the run went
 * green, and the next step sent the candidate an acknowledgement email for a
 * summary that was never written. Proven on a live run: the step output read
 * "summarizing candidate application details is a recruiting task, which is
 * outside my HR role" and the run status was COMPLETED.
 *
 * Guessing at refusals by reading the prose would be unreliable in both
 * directions (a summary ABOUT a declined request is not itself a refusal), so
 * the model is asked to prefix a decline with an exact marker and the marker is
 * stripped before anything is shown or stored.
 */
export const OUT_OF_SCOPE_MARKER = '[OUT_OF_SCOPE]';

export interface ScopeVerdict {
  /** The reply with the marker removed — what the customer should ever see. */
  answer: string;
  /** True when the employee declined the work as outside its role. */
  outOfScope: boolean;
}

/**
 * Detect and strip the refusal marker.
 *
 * Deliberately tolerant about placement and case: models wrap markers in
 * quotes, bold them, or put them on their own line, and a refusal that goes
 * undetected because of a stray asterisk is the exact silent success this
 * exists to stop. It is NOT tolerant about the marker itself — no fuzzy
 * matching on words like "sorry" or "outside my role", which appear in
 * perfectly good answers about other people's refusals.
 */
export function readScope(raw: string): ScopeVerdict {
  const index = raw.toUpperCase().indexOf(OUT_OF_SCOPE_MARKER);
  if (index === -1) {
    return { answer: raw, outOfScope: false };
  }
  const answer = (
    raw.slice(0, index) + raw.slice(index + OUT_OF_SCOPE_MARKER.length)
  )
    // Leading punctuation/formatting the model wrapped the marker in.
    .replace(/^[\s*_"'`:,-]+/, '')
    // Cutting the marker out of the middle of a sentence leaves a gap. Spaces
    // and tabs only — newlines are the model's paragraphing, not our debris.
    .replace(/[ \t]{2,}/g, ' ')
    .trim();
  return { answer, outOfScope: true };
}
