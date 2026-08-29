import type { LlmCompletionInput, LlmCompletionResult } from './llm.provider';

/**
 * Deterministic offline answers for the Marketing AI Employee's two generation
 * steps, so campaign generation is fully testable with no network and no API
 * key — the same reason `mock-assist-script.ts` exists.
 *
 * These are NOT samples of good marketing copy. They exist to be structurally
 * valid and, critically, GENUINELY DISTINCT: the real validator drops
 * near-duplicate variants (§15/§46), so a mock that returned six rewordings of
 * one line would fail validation and make every offline test look like a
 * product bug.
 */

/** Six angles with no meaningful vocabulary overlap, mirroring the §15 rule. */
const ANGLES: ReadonlyArray<{
  contentAngle: string;
  hook: string;
  caption: string;
  cta: string;
  hashtags: string[];
  mediaBrief: string;
}> = [
  {
    contentAngle: 'Problem framing',
    hook: 'Most teams lose a full day each week to work nobody asked for',
    caption:
      'Duplicated status updates, approvals that never needed a human, reports read by no one. Start by naming one.',
    cta: 'See where your week goes',
    hashtags: ['#Productivity', '#Operations'],
    mediaBrief: 'Illustration of a calendar with recurring blocks greyed out',
  },
  {
    contentAngle: 'Customer outcome',
    hook: 'One finance team cut invoice approval from nine days to two',
    caption:
      'They removed three handoffs and changed nothing else about how the work is done.',
    cta: 'Read the walkthrough',
    hashtags: ['#Finance', '#CaseStudy'],
    mediaBrief: 'Before and after timeline comparison graphic',
  },
  {
    contentAngle: 'Contrarian view',
    hook: 'Adding people rarely makes a slow process faster',
    caption:
      'Every extra person multiplies coordination. Shorten the queue before growing the roster.',
    cta: 'Challenge an assumption',
    hashtags: ['#Leadership', '#Scaling'],
    mediaBrief: 'Diagram contrasting headcount growth against removed steps',
  },
  {
    contentAngle: 'Practical guide',
    hook: 'Three questions that expose your slowest handoff',
    caption:
      'Which step waits longest? Who is it waiting on? Why is that person busy? Answers usually arrive fast.',
    cta: 'Try the exercise',
    hashtags: ['#HowTo', '#Workflow'],
    mediaBrief: 'Carousel with one question per card',
  },
  {
    contentAngle: 'Behind the scenes',
    hook: 'We deleted eleven of our own approval rules last quarter',
    caption:
      'Two survived review. The rest existed because nobody had ever removed them.',
    cta: 'See what we kept',
    hashtags: ['#BuildInPublic'],
    mediaBrief: 'Candid photo of a whiteboard covered in crossed-out rules',
  },
  {
    contentAngle: 'Direct invitation',
    hook: 'Bring one broken process to a thirty minute session',
    caption:
      'We map it live. You keep the map, whether or not anything else follows.',
    cta: 'Book a session',
    hashtags: ['#Demo'],
    mediaBrief: 'Clean typographic card stating the session details',
  },
];

/**
 * Step 1 — a structured campaign plan.
 *
 * Reads the numbers back out of the brief where they are stated, so a test can
 * assert "asked for 7 days x 3/day, got 21 items" rather than a fixed shape.
 */
export function completeMarketingPlan(input: LlmCompletionInput): LlmCompletionResult {
  const brief = [...input.messages].reverse().find((m) => m.role === 'user')?.content ?? '';

  const days = Number(/(\d+)\s*[- ]?\s*day/i.exec(brief)?.[1] ?? 7);
  // "3 times per day", "3 posts a day", "2-5 posts per day" -> take the upper.
  const perDayRange = /(\d+)\s*(?:-|to)\s*(\d+)\s*(?:posts?|times?)/i.exec(brief);
  const perDaySingle = /(\d+)\s*(?:posts?|times?)\s*(?:per|a|each)\s*day/i.exec(brief);
  const postsPerDay = Number(perDayRange?.[2] ?? perDaySingle?.[1] ?? 2);

  const platforms = ['linkedin', 'facebook', 'instagram', 'x', 'youtube', 'tiktok'].filter((p) =>
    new RegExp(p, 'i').test(brief),
  );

  const plan = {
    name: 'Offline mock campaign',
    objective: 'Product awareness',
    description: 'Deterministic plan produced by the offline mock provider.',
    durationDays: Number.isFinite(days) && days > 0 ? days : 7,
    postsPerDay: Number.isFinite(postsPerDay) && postsPerDay > 0 ? postsPerDay : 2,
    platforms: platforms.length > 0 ? platforms : ['linkedin'],
    contentPillars: ['Education', 'Product', 'Social Proof', 'Engagement'],
    // Mirrors the real default: only an explicit request turns approval off.
    approvalRequired: !/without (?:approval|review)|auto[- ]?publish/i.test(brief),
  };

  return { content: JSON.stringify(plan) };
}

/** Step 2 — six distinct creative variants for one content item. */
export function completeMarketingVariants(input: LlmCompletionInput): LlmCompletionResult {
  const request = [...input.messages].reverse().find((m) => m.role === 'user')?.content ?? '';
  const day = Number(/Day (\d+)/i.exec(request)?.[1] ?? 1);

  // Rotate the starting angle by day so consecutive items in one campaign do
  // not return an identical set — the real generator is told to avoid repeats,
  // and an offline test of that behaviour needs the mock to vary too.
  const offset = (day - 1) % ANGLES.length;
  const variants = Array.from({ length: 6 }, (_, i) => ANGLES[(offset + i) % ANGLES.length]);

  return {
    content: JSON.stringify({
      variants,
      recommendedIndex: 0,
      recommendationReason: 'Offline mock recommendation.',
    }),
  };
}
