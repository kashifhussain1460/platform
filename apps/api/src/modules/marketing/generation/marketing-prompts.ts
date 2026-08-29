/**
 * System prompts for the Marketing AI Employee's generation steps.
 *
 * Kept apart from the services so the offline mock provider can key off the
 * markers below, exactly as `ASSIST_AGENT_MARKER` and `WORKFLOW_GENERATOR_MARKER`
 * already do. Changing a marker breaks the offline tests — which is the point:
 * the mock and the prompt must move together.
 */

/** Marker for step 1 — natural language brief to a structured campaign task. */
export const MARKETING_PLAN_MARKER = '[[VAEP:MARKETING_PLAN]]';

/** Marker for step 2 — one content item to 5–6 creative variants. */
export const MARKETING_VARIANTS_MARKER = '[[VAEP:MARKETING_VARIANTS]]';

/** §13 — the count is a product requirement, not a preference. */
export const MIN_VARIANTS = 5;
export const MAX_VARIANTS = 6;

/**
 * Brand context handed to the model (§5/§40).
 *
 * Only fields the platform genuinely holds. There is no brand-voice or
 * forbidden-claims store yet, so the prompt does not pretend there is — an
 * invented "Brand Voice: Professional + Friendly" would read as fact to the
 * model and produce content the customer never asked for.
 */
export interface BrandContext {
  companyName: string;
  industry?: string | null;
  description?: string | null;
  website?: string | null;
  businessGoals?: readonly string[];
}

function renderBrand(brand: BrandContext): string {
  const lines = [`Company: ${brand.companyName}`];
  if (brand.industry) lines.push(`Industry: ${brand.industry}`);
  if (brand.description) lines.push(`What they do: ${brand.description}`);
  if (brand.website) lines.push(`Website: ${brand.website}`);
  if (brand.businessGoals?.length) {
    lines.push(`Business goals: ${brand.businessGoals.join(', ')}`);
  }
  if (lines.length === 1) {
    // Saying so beats leaving the model to invent a brand identity.
    lines.push(
      'No further brand profile is on file. Keep claims generic and verifiable; ' +
        'do not invent products, customers, statistics, or awards.',
    );
  }
  return lines.join('\n');
}

/**
 * Step 1 — task normalization (§9).
 *
 * Returns configuration only. It does NOT write content: mixing "how long is
 * this campaign" with "what should the caption say" in one call makes both
 * answers worse and makes a bad plan expensive to discover.
 */
export function buildPlanPrompt(brand: BrandContext, today: string): string {
  return `${MARKETING_PLAN_MARKER}
You are the planning step of a marketing AI that turns a request into a campaign configuration.

${renderBrand(brand)}

Today is ${today}.

Read the user's brief and return ONLY a JSON object:

{
  "name": "short campaign name",
  "objective": "the single primary objective",
  "description": "one or two sentences on the approach",
  "durationDays": 7,
  "postsPerDay": 3,
  "platforms": ["linkedin", "instagram"],
  "contentPillars": ["Education", "Product", "Social Proof", "Engagement"],
  "approvalRequired": true,
  "timezone": "Asia/Kolkata",
  "startDateIso": "2026-09-01"
}

Rules:
- Use ONLY what the brief states or clearly implies. Do not invent a product,
  an audience, or a launch date that is not there.
- If the brief gives a range of posts per day, choose a value inside it.
- platforms must be lowercase keys such as linkedin, facebook, instagram, x,
  youtube, tiktok. Omit any the brief does not mention.
- contentPillars: 3-6 distinct themes to rotate through the campaign.
- approvalRequired defaults to true. Set false ONLY if the brief explicitly
  asks to publish without review.
- timezone must be an IANA name. Omit it if the brief does not say.
- startDateIso: omit unless the brief gives a start date.
- Return the JSON object and nothing else.`;
}

/**
 * Step 2 — creative variants (§13/§14/§15).
 *
 * The diversity instruction is the load-bearing part. §15 calls out that
 * "Buy our product today / Buy our product now / Purchase our product" are not
 * meaningful alternatives, and a model asked only for "6 options" produces
 * exactly that. Requiring a distinct ANGLE per variant is what makes the six
 * genuinely different.
 */
export function buildVariantsPrompt(brand: BrandContext): string {
  return `${MARKETING_VARIANTS_MARKER}
You are the creative step of a marketing AI. You write social media post options.

${renderBrand(brand)}

You will be given one planned content item. Return ONLY a JSON object:

{
  "variants": [
    {
      "contentAngle": "the distinct idea behind this option",
      "hook": "the opening line that earns attention",
      "caption": "the post body",
      "cta": "the call to action",
      "hashtags": ["#Example"],
      "mediaBrief": "what image or video should accompany this, described for a designer"
    }
  ],
  "recommendedIndex": 0,
  "recommendationReason": "one short sentence a customer would understand"
}

Rules:
- Return between ${MIN_VARIANTS} and ${MAX_VARIANTS} variants.
- Every variant must use a GENUINELY DIFFERENT angle: a different story, proof
  point, format, or point of view. Rewording the same sentence is not an option
  — "Buy today", "Buy now" and "Purchase now" count as ONE idea, not three.
- Vary the hook style across variants (question, statistic, story, contrast,
  observation, direct statement).
- hashtags: 3-6 relevant ones. Relevance beats quantity; do not pad.
- mediaBrief describes media to be produced LATER. Do not claim an image exists.
- Never invent statistics, customer names, testimonials, or awards.
- recommendedIndex is a 0-based index into your own variants array. A
  recommendation is a suggestion for a human to consider, not an approval.
- Return the JSON object and nothing else.`;
}

/** The per-item user message for step 2. */
export function buildVariantsRequest(item: {
  objective: string;
  contentType: string;
  campaignObjective: string | null;
  platforms: readonly string[];
  dayNumber: number;
  /** Angles already used in this campaign, so the model can avoid repeats (§46). */
  avoidAngles: readonly string[];
}): string {
  const lines = [
    `Campaign objective: ${item.campaignObjective ?? 'not specified'}`,
    `This post's pillar: ${item.objective}`,
    `Content type: ${item.contentType}`,
    `Day ${item.dayNumber} of the campaign.`,
    `Platforms: ${item.platforms.length ? item.platforms.join(', ') : 'not specified'}`,
  ];
  if (item.avoidAngles.length > 0) {
    lines.push(
      '',
      'Angles already used elsewhere in this campaign — do NOT repeat them:',
      ...item.avoidAngles.slice(0, 25).map((a) => `- ${a}`),
    );
  }
  return lines.join('\n');
}
