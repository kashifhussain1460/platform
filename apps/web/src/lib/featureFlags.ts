/**
 * Build-time feature flags.
 *
 * `simplifiedWorkflowUX` gates the AI-first workflow experience (single create
 * entry point, Review & Publish instead of validate → publish → activate). It
 * defaults ON, and the legacy controls stay in the code behind it so a rollout
 * problem is one environment variable away from being reverted — no redeploy of
 * removed code (UX plan §63).
 *
 * Read via the literal `process.env.NEXT_PUBLIC_*` expression, not a computed
 * key: Next.js inlines these at build time only when it can see the full name.
 */
export const simplifiedWorkflowUX =
  process.env.NEXT_PUBLIC_SIMPLIFIED_WORKFLOW_UX !== 'false';
