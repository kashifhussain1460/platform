'use client';

import { OnboardingWizard } from '@/features/onboarding/components/OnboardingWizard';

/**
 * The onboarding wizard route.
 *
 * Deliberately holds NO auth/redirect logic of its own. `AppLayout` (the (app)
 * route-group guard) already owns every decision for protected routes: it waits
 * for session rehydration, sends guests to /login, forces un-onboarded users
 * here, and sends onboarded users to /dashboard.
 *
 * This page previously duplicated those redirects off a SECOND source of truth
 * (the `onboarding/status` query, where the layout reads `company.onboardedAt`
 * from the session store). The two could disagree for a render — the layout
 * pushing to /onboarding while this page pushed to /dashboard — which is the
 * redirect loop the completion hook still carries a workaround comment about.
 * One guard, one source of truth.
 */
export default function OnboardingPage() {
  return <OnboardingWizard />;
}
