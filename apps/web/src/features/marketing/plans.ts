/**
 * The plans the site sells — ONE list, used by the pricing page and the home
 * page section.
 *
 * They used to be written out separately in each place and had drifted into two
 * different price lists on the same site: the home section offered "Pro $99"
 * while the pricing page offered "Business $99". Whichever a visitor saw first
 * was wrong somewhere else.
 *
 * ⚠️ This is the SALES list. The product's own `PLAN_CATALOG`
 * (`apps/api/src/modules/billing/billing.plans.ts`) is a different list, and the
 * per-month run and storage quotas below are not metered anywhere yet. Change
 * one and you have to change the other on purpose.
 */

export type PlanIcon = 'rocket' | 'team' | 'briefcase' | 'building';

export interface MarketingPlan {
  key: string;
  name: string;
  blurb: string;
  icon: PlanIcon;
  /** Price per month on monthly billing. `null` = "Custom", talk to sales. */
  monthlyUsd: number | null;
  /** Price per month when billed yearly — the discounted rate. */
  yearlyMonthlyUsd: number | null;
  cta: string;
  ctaHref: string;
  /** Heading above the feature list — plans build on each other. */
  featuresLabel: string;
  features: string[];
  popular?: boolean;
}

export const MARKETING_PLANS: MarketingPlan[] = [
  {
    key: 'free',
    name: 'Free',
    blurb: 'For individuals exploring Orlixa.',
    icon: 'rocket',
    monthlyUsd: 0,
    yearlyMonthlyUsd: 0,
    cta: 'Get Started Free',
    ctaHref: '/register',
    featuresLabel: 'Includes:',
    features: [
      'Up to 2 AI Employees',
      '1,000 workflow runs / month',
      'Knowledge Base (5GB)',
      'Basic integrations',
      'Community support',
    ],
  },
  {
    key: 'starter',
    name: 'Starter',
    blurb: 'For small teams getting started.',
    icon: 'team',
    monthlyUsd: 36,
    yearlyMonthlyUsd: 29,
    cta: 'Start Free Trial',
    ctaHref: '/register',
    featuresLabel: 'Everything in Free, plus:',
    features: [
      'Up to 10 AI Employees',
      '10,000 workflow runs / month',
      'Knowledge Base (50GB)',
      'Advanced integrations',
      'Email & chat support',
      'Workflow templates',
    ],
  },
  {
    key: 'business',
    name: 'Business',
    blurb: 'For growing teams and departments.',
    icon: 'briefcase',
    monthlyUsd: 124,
    yearlyMonthlyUsd: 99,
    cta: 'Start Free Trial',
    ctaHref: '/register',
    featuresLabel: 'Everything in Starter, plus:',
    features: [
      'Up to 50 AI Employees',
      '50,000 workflow runs / month',
      'Knowledge Base (250GB)',
      'Custom integrations (webhooks)',
      'Priority support',
      'Advanced analytics',
      'Role-based access control',
    ],
    popular: true,
  },
  {
    key: 'enterprise',
    name: 'Enterprise',
    blurb: 'For large organizations with scale.',
    icon: 'building',
    monthlyUsd: null,
    yearlyMonthlyUsd: null,
    cta: 'Contact Sales',
    ctaHref: '/contact-sales',
    featuresLabel: 'Everything in Business, plus:',
    features: [
      'Unlimited AI Employees',
      'Unlimited workflow runs',
      'Unlimited Knowledge Base',
      'Dedicated account manager',
      'SLA & uptime guarantee',
      'On-premise / VPC options',
      'Custom contracts & compliance',
    ],
  },
];

/** What a plan costs per month on the chosen billing period. */
export function priceFor(plan: MarketingPlan, yearly: boolean): number | null {
  return yearly ? plan.yearlyMonthlyUsd : plan.monthlyUsd;
}
