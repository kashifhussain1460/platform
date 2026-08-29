/**
 * Validation and de-duplication of model-produced campaign output — PURE.
 *
 * The model is asked for well-formed JSON, but "asked for" is not "guaranteed"
 * (the LlmCompletionInput doc says exactly this about `json: true`). Everything
 * below treats the model's answer as untrusted input.
 *
 * §46 requires similarity checking, and §15 is explicit that near-identical
 * rewordings are not alternatives. That check lives here rather than in the
 * prompt because a prompt is a request and this is a guarantee.
 */

import { MAX_VARIANTS, MIN_VARIANTS } from './marketing-prompts';

export interface RawVariant {
  contentAngle?: unknown;
  hook?: unknown;
  caption?: unknown;
  cta?: unknown;
  hashtags?: unknown;
  mediaBrief?: unknown;
}

export interface ValidatedVariant {
  contentAngle: string;
  hook: string;
  caption: string;
  cta: string;
  hashtags: string[];
  mediaBrief: string | null;
}

export interface ValidatedVariantSet {
  variants: ValidatedVariant[];
  recommendedIndex: number;
  recommendationReason: string | null;
  /** Variants dropped as too similar, for logging/observability (§81). */
  droppedAsDuplicate: number;
}

export class VariantValidationError extends Error {}

const MAX_CAPTION_CHARS = 5_000;
const MAX_HASHTAGS = 12;

/**
 * Similarity threshold above which two variants count as the same idea.
 *
 * 0.8 on normalised token overlap. Tuned to catch §15's example
 * ("Buy our product today" vs "Buy our product now" ≈ 0.8+) while leaving two
 * genuinely different posts about the same product comfortably below it.
 */
const SIMILARITY_THRESHOLD = 0.8;

function asText(value: unknown, field: string, { required = true } = {}): string {
  if (typeof value !== 'string' || value.trim() === '') {
    if (required) throw new VariantValidationError(`Variant is missing "${field}".`);
    return '';
  }
  return value.trim();
}

/** Normalise for comparison: lowercase, strip punctuation, collapse spaces. */
function tokenise(text: string): Set<string> {
  return new Set(
    text
      .toLowerCase()
      .replace(/[^a-z0-9\s]/g, ' ')
      .split(/\s+/)
      .filter((w) => w.length > 2),
  );
}

/** Jaccard overlap of two token sets — 1 = identical, 0 = nothing shared. */
export function similarity(a: string, b: string): number {
  const left = tokenise(a);
  const right = tokenise(b);
  if (left.size === 0 && right.size === 0) return 1;
  if (left.size === 0 || right.size === 0) return 0;
  let shared = 0;
  for (const token of left) if (right.has(token)) shared += 1;
  return shared / (left.size + right.size - shared);
}

/** Hashtags normalised to a leading '#', de-duplicated, capped. */
function normaliseHashtags(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of value) {
    if (typeof raw !== 'string') continue;
    const tag = raw.trim().replace(/^#+/, '');
    if (!tag) continue;
    const key = tag.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(`#${tag}`);
    if (out.length >= MAX_HASHTAGS) break;
  }
  return out;
}

/**
 * Validate one model response into a usable variant set.
 *
 * Throws when the response cannot be salvaged. It does NOT quietly return an
 * empty set — a content item with zero options would surface to the customer as
 * a blank review screen with no explanation, which is the silent-failure
 * pattern this codebase treats as a defect.
 */
export function validateVariantSet(parsed: unknown): ValidatedVariantSet {
  if (!parsed || typeof parsed !== 'object') {
    throw new VariantValidationError('The model did not return a JSON object.');
  }
  const body = parsed as { variants?: unknown; recommendedIndex?: unknown; recommendationReason?: unknown };
  if (!Array.isArray(body.variants) || body.variants.length === 0) {
    throw new VariantValidationError('The model returned no variants.');
  }

  const accepted: ValidatedVariant[] = [];
  let droppedAsDuplicate = 0;

  for (const raw of body.variants as RawVariant[]) {
    if (accepted.length >= MAX_VARIANTS) break;
    let candidate: ValidatedVariant;
    try {
      const caption = asText(raw.caption, 'caption');
      candidate = {
        contentAngle: asText(raw.contentAngle, 'contentAngle'),
        hook: asText(raw.hook, 'hook'),
        caption: caption.slice(0, MAX_CAPTION_CHARS),
        cta: asText(raw.cta, 'cta'),
        hashtags: normaliseHashtags(raw.hashtags),
        mediaBrief: asText(raw.mediaBrief, 'mediaBrief', { required: false }) || null,
      };
    } catch {
      // One malformed entry must not lose the other five.
      continue;
    }

    // §15/§46 — compare on hook + caption, which is where a reworded duplicate
    // shows up. Two variants may legitimately share a CTA.
    const fingerprint = `${candidate.hook} ${candidate.caption}`;
    const isDuplicate = accepted.some(
      (a) => similarity(`${a.hook} ${a.caption}`, fingerprint) >= SIMILARITY_THRESHOLD,
    );
    if (isDuplicate) {
      droppedAsDuplicate += 1;
      continue;
    }
    accepted.push(candidate);
  }

  if (accepted.length < MIN_VARIANTS) {
    throw new VariantValidationError(
      `Only ${accepted.length} usable option(s) came back; ${MIN_VARIANTS} are required` +
        (droppedAsDuplicate > 0
          ? ` (${droppedAsDuplicate} were near-duplicates of each other).`
          : '.'),
    );
  }

  const rawIndex = body.recommendedIndex;
  const recommendedIndex =
    typeof rawIndex === 'number' && Number.isInteger(rawIndex) && rawIndex >= 0 && rawIndex < accepted.length
      ? rawIndex
      : 0;

  const reason =
    typeof body.recommendationReason === 'string' && body.recommendationReason.trim()
      ? body.recommendationReason.trim()
      : null;

  return { variants: accepted, recommendedIndex, recommendationReason: reason, droppedAsDuplicate };
}

// ---------------------------------------------------------------------------
// Campaign plan (step 1)
// ---------------------------------------------------------------------------

export interface ValidatedCampaignPlan {
  name: string;
  objective: string;
  description: string | null;
  durationDays: number;
  postsPerDay: number;
  platforms: string[];
  contentPillars: string[];
  approvalRequired: boolean;
  timezone: string | null;
  startDateIso: string | null;
}

/** Platform keys the publishing layer can actually target today. */
const KNOWN_PLATFORMS = new Set([
  'linkedin',
  'facebook',
  'instagram',
  'x',
  'youtube',
  'tiktok',
  'threads',
  'pinterest',
  'mastodon',
]);

export function validateCampaignPlan(parsed: unknown): ValidatedCampaignPlan {
  if (!parsed || typeof parsed !== 'object') {
    throw new VariantValidationError('The model did not return a campaign plan.');
  }
  const b = parsed as Record<string, unknown>;

  const durationDays = Number(b.durationDays);
  const postsPerDay = Number(b.postsPerDay);
  if (!Number.isInteger(durationDays) || durationDays < 1) {
    throw new VariantValidationError('The plan is missing a valid campaign length in days.');
  }
  if (!Number.isInteger(postsPerDay) || postsPerDay < 1) {
    throw new VariantValidationError('The plan is missing a valid posts-per-day figure.');
  }

  const platforms = Array.isArray(b.platforms)
    ? [
        ...new Set(
          (b.platforms as unknown[])
            .filter((p): p is string => typeof p === 'string')
            .map((p) => p.trim().toLowerCase())
            // Drop anything we cannot publish to rather than storing a target
            // that silently never receives a post.
            .filter((p) => KNOWN_PLATFORMS.has(p)),
        ),
      ]
    : [];

  const contentPillars = Array.isArray(b.contentPillars)
    ? [
        ...new Set(
          (b.contentPillars as unknown[])
            .filter((p): p is string => typeof p === 'string')
            .map((p) => p.trim())
            .filter(Boolean),
        ),
      ].slice(0, 6)
    : [];

  return {
    name: asText(b.name, 'name', { required: false }) || 'Untitled campaign',
    objective: asText(b.objective, 'objective', { required: false }) || 'Awareness',
    description: asText(b.description, 'description', { required: false }) || null,
    durationDays,
    postsPerDay,
    platforms,
    contentPillars,
    // Approval is opt-OUT: anything other than an explicit false stays true.
    approvalRequired: b.approvalRequired !== false,
    timezone: asText(b.timezone, 'timezone', { required: false }) || null,
    startDateIso: asText(b.startDateIso, 'startDateIso', { required: false }) || null,
  };
}
