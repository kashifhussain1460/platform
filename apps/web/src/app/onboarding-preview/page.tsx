'use client';

import { OnboardingFlow } from '@/features/onboarding-flow/OnboardingFlow';
import { OnboardingPreviewAuthGate } from './OnboardingPreviewAuthGate';

/**
 * PREVIEW route for the new 12-screen onboarding UX (UI-first phase).
 *
 * Deliberately OUTSIDE the `(app)` route group: that group's layout redirects
 * any non-onboarded session straight to the real `/onboarding` for every
 * other route, which would make a route like `(app)/onboarding-preview`
 * unreachable for exactly the accounts most useful for reviewing this.
 *
 * REQUIRES SESSION: Guests are redirected to `/login?returnTo=/onboarding-preview`.
 * Authenticated users (onboarded or not) can access this page, since revisiting
 * to hire more employees later is a supported use case.
 *
 * The LIVE `/onboarding` route (`features/onboarding/components/
 * OnboardingWizard.tsx`) is untouched and still backend-wired — real signups
 * are unaffected. This preview is what gets cut over once Phase 2 (backend)
 * and Phase 3 (wiring) land.
 */
export default function OnboardingPreviewPage() {
  return (
    <OnboardingPreviewAuthGate>
      <OnboardingFlow />
    </OnboardingPreviewAuthGate>
  );
}
