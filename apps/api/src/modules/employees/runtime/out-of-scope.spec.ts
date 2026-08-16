import { OUT_OF_SCOPE_MARKER, readScope } from './out-of-scope';

/**
 * Refusal detection.
 *
 * The bug this guards is silent: an HR AI Employee given a recruiting step
 * declined it, the step was recorded COMPLETED, the run went green, and the
 * candidate was emailed an acknowledgement for a summary nobody wrote. Both
 * directions matter — a missed refusal is a silent success, and a false
 * positive fails a run that actually did its job.
 */
describe('readScope', () => {
  it('detects a marked refusal and hides the marker from the customer', () => {
    const raw = `${OUT_OF_SCOPE_MARKER} I'm sorry, summarizing candidate applications is recruiting work.`;
    const { answer, outOfScope } = readScope(raw);

    expect(outOfScope).toBe(true);
    expect(answer).toBe(
      "I'm sorry, summarizing candidate applications is recruiting work.",
    );
    expect(answer).not.toContain('OUT_OF_SCOPE');
  });

  it('treats an ordinary answer as an answer', () => {
    const raw = 'Annual leave entitlement is 18 days per calendar year.';
    expect(readScope(raw)).toEqual({ answer: raw, outOfScope: false });
  });

  it('does NOT guess from apologetic wording', () => {
    // Real answers say "sorry" and mention roles all the time. Sniffing for
    // phrases instead of the marker would fail runs that did their job.
    const raw =
      "I'm sorry to report the candidate is outside the required experience "
      + 'range for this recruiter role.';
    expect(readScope(raw).outOfScope).toBe(false);
  });

  it('survives the formatting a model wraps a marker in', () => {
    // Seen from real models: bolded, quoted, on its own line. A refusal that
    // slips through because of a stray asterisk is the exact silent success
    // this exists to stop.
    for (const raw of [
      `**${OUT_OF_SCOPE_MARKER}**\nThis is recruiting work.`,
      `"${OUT_OF_SCOPE_MARKER}": This is recruiting work.`,
      `${OUT_OF_SCOPE_MARKER.toLowerCase()} This is recruiting work.`,
    ]) {
      const { answer, outOfScope } = readScope(raw);
      expect(outOfScope).toBe(true);
      expect(answer).toBe('This is recruiting work.');
    }
  });

  it('strips a marker that arrives mid-sentence rather than leaving it visible', () => {
    const { answer, outOfScope } = readScope(
      `Sorry — ${OUT_OF_SCOPE_MARKER} that is HR work.`,
    );
    expect(outOfScope).toBe(true);
    // No double space left where the marker was cut out.
    expect(answer).toBe('Sorry — that is HR work.');
  });
});
