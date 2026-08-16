import { describe, expect, it } from 'vitest';
import { MAX_FILES_PER_UPLOAD, planUpload } from '../upload-batch';

const named = (...names: string[]) => names.map((name) => ({ name }));

/**
 * Batch planning.
 *
 * Two different "we didn't upload this" cases share one screen, and telling them
 * apart is the whole point: a `.png` can never be ingested, while the sixth PDF
 * of a drop works perfectly on the next attempt. Merging them would either tell
 * someone to retry a file that cannot succeed, or make them give up on one that
 * can.
 */
describe('planUpload', () => {
  it('accepts the readable types', () => {
    const plan = planUpload(named('policy.pdf', 'notes.md', 'handbook.txt'));
    expect(plan.accepted.map((f) => f.name)).toEqual([
      'policy.pdf',
      'notes.md',
      'handbook.txt',
    ]);
    expect(plan.unreadable).toEqual([]);
    expect(plan.deferred).toEqual([]);
  });

  it('is case-insensitive about the extension', () => {
    // A phone-camera export is routinely `SCAN.PDF`.
    expect(planUpload(named('SCAN.PDF')).accepted).toHaveLength(1);
  });

  it('names what it cannot read instead of counting it', () => {
    const plan = planUpload(named('team.png', 'policy.pdf', 'sheet.xlsx'));
    expect(plan.accepted.map((f) => f.name)).toEqual(['policy.pdf']);
    expect(plan.unreadable).toEqual(['team.png', 'sheet.xlsx']);
  });

  it(`uploads the first ${MAX_FILES_PER_UPLOAD} and defers the rest by name`, () => {
    const plan = planUpload(named('a.pdf', 'b.pdf', 'c.pdf', 'd.pdf', 'e.pdf', 'f.pdf', 'g.pdf'));
    expect(plan.accepted).toHaveLength(MAX_FILES_PER_UPLOAD);
    // Deferred, NOT rejected — these succeed on the next drop, so the message
    // has to say something different from the unreadable one.
    expect(plan.deferred).toEqual(['f.pdf', 'g.pdf']);
    expect(plan.unreadable).toEqual([]);
  });

  it('counts unreadable files BEFORE the limit, so five good files still all go', () => {
    // Otherwise a stray screenshot silently costs the customer a real document.
    const plan = planUpload(
      named('shot.png', 'a.pdf', 'b.pdf', 'c.pdf', 'd.pdf', 'e.pdf'),
    );
    expect(plan.accepted).toHaveLength(5);
    expect(plan.deferred).toEqual([]);
    expect(plan.unreadable).toEqual(['shot.png']);
  });

  it('exactly at the limit defers nothing', () => {
    // Off-by-one here would show a scary message on a perfectly fine drop.
    const plan = planUpload(named('a.pdf', 'b.pdf', 'c.pdf', 'd.pdf', 'e.pdf'));
    expect(plan.accepted).toHaveLength(5);
    expect(plan.deferred).toEqual([]);
  });

  it('handles an empty drop', () => {
    expect(planUpload([])).toEqual({ accepted: [], unreadable: [], deferred: [] });
  });
});
