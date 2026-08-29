import {
  VariantValidationError,
  similarity,
  validateCampaignPlan,
  validateVariantSet,
} from './variant-validation';

/**
 * The model's output is untrusted input. These tests pin the two guarantees the
 * prompt cannot make on its own:
 *
 *   1. Six options must be six IDEAS (§15) — the spec's own counter-example is
 *      "Buy our product today / Buy now / Purchase our product".
 *   2. A campaign never reaches a human with a blank or half-formed option set;
 *      it fails loudly instead.
 */
describe('variant-validation', () => {
  /**
   * Deliberately distinct copy, not `Hook ${n}` templates.
   *
   * Numbered templates share every word once short tokens are filtered, so the
   * de-duplicator correctly collapses them — which makes them useless as
   * fixtures for the happy path. Real variants differ in vocabulary, and the
   * fixtures have to as well.
   */
  const ANGLES = [
    {
      contentAngle: 'Common onboarding mistake',
      hook: 'Most teams lose their first week to paperwork nobody reads',
      caption: 'Onboarding drags when documents live in five places. Here is a tighter sequence.',
      mediaBrief: 'Flat illustration of a cluttered desk becoming an ordered checklist',
    },
    {
      contentAngle: 'Customer outcome',
      hook: 'A finance team cut invoice approval from nine days to two',
      caption: 'They removed three handoffs. Nothing else about their process changed.',
      mediaBrief: 'Before and after timeline graphic',
    },
    {
      contentAngle: 'Contrarian take',
      hook: 'Hiring more people rarely fixes a slow process',
      caption: 'Extra headcount multiplies coordination. Fix the queue before the roster.',
      mediaBrief: 'Diagram contrasting added headcount against removed steps',
    },
    {
      contentAngle: 'Practical how-to',
      hook: 'Three questions that expose where your week disappears',
      caption: 'Ask which step waits longest, who it waits on, and why that person is busy.',
      mediaBrief: 'Numbered card carousel, one question per card',
    },
    {
      contentAngle: 'Behind the scenes',
      hook: 'We rebuilt our own approvals last quarter and it was uncomfortable',
      caption: 'Two rules survived review. The other eleven existed because nobody deleted them.',
      mediaBrief: 'Candid photograph of a whiteboard mid-argument',
    },
    {
      contentAngle: 'Direct offer',
      hook: 'Bring one broken workflow to a thirty minute session',
      caption: 'We will map it live and you keep the map whether or not you continue.',
      mediaBrief: 'Clean typographic card with the session details',
    },
    {
      contentAngle: 'Industry observation',
      hook: 'Software budgets grew while cycle times stayed flat',
      caption: 'Tools rarely remove a step. Somebody has to decide to delete it.',
      mediaBrief: 'Simple two-line chart',
    },
    {
      contentAngle: 'Myth buster',
      hook: 'Automation does not need to replace anyone to pay for itself',
      caption: 'Most savings come from waiting time, not from labour.',
      mediaBrief: 'Split panel separating waiting from working',
    },
    {
      contentAngle: 'Question prompt',
      hook: 'Which approval in your company exists purely out of habit?',
      caption: 'Every team has one. Naming it is usually harder than removing it.',
      mediaBrief: 'Bold question on a plain background',
    },
  ];

  const variant = (n: number, over: Record<string, unknown> = {}) => ({
    ...ANGLES[(n - 1) % ANGLES.length],
    cta: 'Book a demo',
    hashtags: ['#Marketing'],
    ...over,
  });

  const setOf = (n: number) => ({
    variants: Array.from({ length: n }, (_, i) => variant(i + 1)),
    recommendedIndex: 0,
    recommendationReason: 'Fits the brand',
  });

  describe('similarity', () => {
    it('scores the spec’s non-alternatives as near-identical', () => {
      expect(similarity('Buy our product today', 'Buy our product now')).toBeGreaterThan(0.5);
    });

    it('scores genuinely different posts as different', () => {
      expect(
        similarity(
          'Three mistakes teams make when onboarding new staff',
          'Our customer cut invoicing time by half last quarter',
        ),
      ).toBeLessThan(0.2);
    });

    it('treats identical text as 1', () => {
      expect(similarity('same words here', 'same words here')).toBe(1);
    });
  });

  describe('validateVariantSet', () => {
    it('accepts a well-formed set of six', () => {
      const result = validateVariantSet(setOf(6));
      expect(result.variants).toHaveLength(6);
      expect(result.recommendedIndex).toBe(0);
      expect(result.recommendationReason).toBe('Fits the brand');
    });

    it('drops a near-duplicate rather than passing off a reworded option', () => {
      const payload = setOf(6);
      // Make #6 a reworded #1 — exactly the §15 failure.
      payload.variants[5] = variant(6, {
        hook: payload.variants[0].hook,
        caption: payload.variants[0].caption,
      });
      const result = validateVariantSet(payload);
      expect(result.droppedAsDuplicate).toBe(1);
      expect(result.variants).toHaveLength(5);
    });

    it('FAILS when de-duplication leaves fewer than five real ideas', () => {
      // Six rewordings of one thought is not five options. Better to fail and
      // regenerate than to show a customer a padded list.
      const same = variant(1);
      expect(() =>
        validateVariantSet({ variants: Array.from({ length: 6 }, () => ({ ...same })) }),
      ).toThrow(VariantValidationError);
    });

    it('keeps the other five when one entry is malformed', () => {
      const payload = setOf(6);
      (payload.variants[2] as Record<string, unknown>).caption = '';
      const result = validateVariantSet(payload);
      expect(result.variants).toHaveLength(5);
    });

    it('never returns an empty set silently', () => {
      expect(() => validateVariantSet({ variants: [] })).toThrow(VariantValidationError);
      expect(() => validateVariantSet(null)).toThrow(VariantValidationError);
      expect(() => validateVariantSet('nope')).toThrow(VariantValidationError);
    });

    it('caps at six even if the model returns more', () => {
      expect(validateVariantSet(setOf(9)).variants).toHaveLength(6);
    });

    it('normalises hashtags and removes duplicates', () => {
      const payload = setOf(5);
      payload.variants[0].hashtags = ['ai', '#AI', '  #Marketing  ', ''] as never;
      const [first] = validateVariantSet(payload).variants;
      expect(first.hashtags).toEqual(['#ai', '#Marketing']);
    });

    it('falls back to the first variant when recommendedIndex is out of range', () => {
      // An out-of-range recommendation must not point at nothing.
      const payload = { ...setOf(5), recommendedIndex: 99 };
      expect(validateVariantSet(payload).recommendedIndex).toBe(0);
    });
  });

  describe('validateCampaignPlan', () => {
    const plan = (over: Record<string, unknown> = {}) => ({
      name: 'Autumn launch',
      objective: 'Product awareness',
      durationDays: 7,
      postsPerDay: 3,
      platforms: ['linkedin', 'instagram'],
      contentPillars: ['Education', 'Product'],
      approvalRequired: true,
      ...over,
    });

    it('accepts a well-formed plan', () => {
      const result = validateCampaignPlan(plan());
      expect(result).toMatchObject({ durationDays: 7, postsPerDay: 3 });
      expect(result.platforms).toEqual(['linkedin', 'instagram']);
    });

    it('drops platforms we cannot actually publish to', () => {
      // Storing an unpublishable target would mean a post that silently never
      // goes anywhere.
      const result = validateCampaignPlan(plan({ platforms: ['linkedin', 'myspace'] }));
      expect(result.platforms).toEqual(['linkedin']);
    });

    it('keeps approval required unless the model explicitly said false', () => {
      expect(validateCampaignPlan(plan({ approvalRequired: undefined })).approvalRequired).toBe(true);
      expect(validateCampaignPlan(plan({ approvalRequired: 'no' })).approvalRequired).toBe(true);
      expect(validateCampaignPlan(plan({ approvalRequired: false })).approvalRequired).toBe(false);
    });

    it('rejects a plan with no usable length or cadence', () => {
      expect(() => validateCampaignPlan(plan({ durationDays: 0 }))).toThrow(VariantValidationError);
      expect(() => validateCampaignPlan(plan({ postsPerDay: 'lots' }))).toThrow(
        VariantValidationError,
      );
    });

    it('de-duplicates pillars and caps them at six', () => {
      const result = validateCampaignPlan(
        plan({ contentPillars: ['A', 'A', 'B', 'C', 'D', 'E', 'F', 'G'] }),
      );
      expect(result.contentPillars).toEqual(['A', 'B', 'C', 'D', 'E', 'F']);
    });
  });
});
