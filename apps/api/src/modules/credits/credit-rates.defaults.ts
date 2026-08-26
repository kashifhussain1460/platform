/**
 * Checked-in bootstrap fallback rates (§16 Option C) — the successor to
 * `apps/api/src/modules/usage/usage-rates.ts`'s existing flat-rate constants,
 * which stay in place UNMODIFIED as the pre-ledger cost-estimation source
 * for `/billing`'s existing illustrative usage display (Task 2.3).
 *
 * Every numeric value here is a PLACEHOLDER — none of these numbers exist
 * anywhere in the repo today, per the plan's own Kill-Critic/Final-Decision
 * findings. Tagged FOUNDER-PENDING; Phase 13's sign-off greps for zero
 * remaining instances of that tag before enforcement can go live.
 *
 * These are used to SEED the real `ModelCostRate`/`ToolCostRate` DB rows the
 * first time a given (provider, model) or (skillKey, tool) is priced — see
 * `CreditRateAdminService.ensureModelRate`/`ensureToolRate` — never read
 * directly by the ledger (every DEBIT/RESERVATION freezes a real DB row id).
 */

/** // FOUNDER-PENDING: creditsPerUsd — Final Architecture Decision recommended $0.01/credit (100 credits per USD). */
export const DEFAULT_CREDITS_PER_USD = 100;

/** // FOUNDER-PENDING: safety margin — illustrated at 10% in the plan's worked example. */
export const DEFAULT_SAFETY_MARGIN_PCT = 10;

export interface DefaultModelRate {
  provider: string;
  model: string;
  promptRatePer1MUsd: number;
  completionRatePer1MUsd: number;
  creditsPerUsd: number;
}

/**
 * Reuses `usage-rates.ts`'s existing illustrative flat rate ($3/$15 per 1M
 * tokens) for every model — this repo has no per-model pricing data today,
 * and inventing DIFFERENT numbers per model would be fabrication, not a
 * placeholder. `"default"` is the fallback used for any (provider, model)
 * pair not explicitly listed below.
 */
export const DEFAULT_MODEL_RATES: DefaultModelRate[] = [
  {
    provider: 'default',
    model: 'default',
    promptRatePer1MUsd: 3,
    completionRatePer1MUsd: 15,
    creditsPerUsd: DEFAULT_CREDITS_PER_USD,
  },
  // Named per platform/CLAUDE.md's current LLM_MODEL defaults, same
  // illustrative numbers (no per-model data exists to differentiate them).
  {
    provider: 'openai',
    model: 'gpt-5.6-terra',
    promptRatePer1MUsd: 3,
    completionRatePer1MUsd: 15,
    creditsPerUsd: DEFAULT_CREDITS_PER_USD,
  },
  {
    provider: 'anthropic',
    model: 'claude-sonnet-5',
    promptRatePer1MUsd: 3,
    completionRatePer1MUsd: 15,
    creditsPerUsd: DEFAULT_CREDITS_PER_USD,
  },
  {
    provider: 'mock',
    model: 'mock',
    promptRatePer1MUsd: 0,
    completionRatePer1MUsd: 0,
    creditsPerUsd: DEFAULT_CREDITS_PER_USD,
  },
];

export interface DefaultToolRate {
  skillKey: string;
  tool: string;
  creditsPerCall: number;
}

/**
 * Only Postiz's two tools have a real, cost-incurring executor today (Part
 * A ground truth) — every other skill/tool is genuinely free to the
 * platform (no external API cost), so it is deliberately NOT listed here.
 * `CreditCostCalculatorService.priceToolCall` returns 0 credits for
 * anything not in this list.
 */
export const DEFAULT_TOOL_RATES: DefaultToolRate[] = [
  { skillKey: 'postiz', tool: 'schedule_post', creditsPerCall: 5 },
  { skillKey: 'postiz', tool: 'publish_now', creditsPerCall: 5 },
];
