'use client';

import { OnboardingFlow } from '@/features/onboarding-flow/OnboardingFlow';

/**
 * The onboarding wizard route — the full multi-step flow (Company, Goals,
 * Plan, hire AI Employees with real skills/connections/knowledge/workflows,
 * server-computed readiness), formerly staged at `/onboarding-preview` while
 * this route ran the old 4-step wizard (Company → 2 roles only → Goals →
 * Departments, no skills/connections/knowledge/workflows/readiness at all).
 * See docs/superpowers/plans/2026-09-12-onboarding-preview-backend-wiring.md
 * for how this flow was built and verified before the cutover.
 *
 * Deliberately holds NO auth/redirect logic of its own. `AppLayout` (the (app)
 * route-group guard) already owns every decision for protected routes: it waits
 * for session rehydration, sends guests to /login, and forces un-onboarded
 * users here — it does NOT bounce an already-onboarded company away, since
 * this flow explicitly supports revisiting to hire more AI Employees later.
 *
 * This page previously duplicated those redirects off a SECOND source of truth
 * (the `onboarding/status` query, where the layout reads `company.onboardedAt`
 * from the session store). The two could disagree for a render — the layout
 * pushing to /onboarding while this page pushed to /dashboard — which is the
 * redirect loop the completion hook still carries a workaround comment about.
 * One guard, one source of truth.
 */
export default function OnboardingPage() {
  return <OnboardingFlow />;
}
