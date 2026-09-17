import { redirect } from 'next/navigation';

/**
 * This preview route has been cut over: the flow that used to live here
 * (`features/onboarding-flow/OnboardingFlow.tsx`) is now the real
 * `/onboarding` route itself. Kept as a redirect, not deleted outright, so
 * an existing bookmark or external link doesn't 404.
 */
export default function OnboardingPreviewPage() {
  redirect('/onboarding');
}
