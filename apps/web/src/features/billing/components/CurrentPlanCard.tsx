'use client';

import Link from 'next/link';
import { Check } from 'lucide-react';
import { usePlans, useSubscription, useOpenBillingPortal } from '../hooks';
import { STATUS_BADGE, STATUS_LABEL, formatPrice } from '../labels';

/** Header card: the company's current plan, price, features and status. */
export function CurrentPlanCard() {
  const { data: subscription, isLoading } = useSubscription();
  const { data: plans } = usePlans();
  const portal = useOpenBillingPortal();

  if (isLoading || !subscription) {
    return (
      <div className="flex h-full flex-col rounded-2xl border border-app-border bg-app-surface p-6">
        <p className="text-sm text-app-ink-3">Loading subscription…</p>
      </div>
    );
  }

  const plan = plans?.find((p) => p.plan === subscription.plan);
  const name = plan?.name ?? subscription.plan;

  return (
    <div className="flex h-full flex-col rounded-2xl border border-app-border bg-app-surface p-6">
      <div className="flex items-start justify-between">
        <p className="text-sm font-medium text-app-ink-2">Current Plan</p>
        <span
          className={`rounded-full px-2.5 py-1 text-xs font-semibold ${STATUS_BADGE[subscription.status]}`}
        >
          {STATUS_LABEL[subscription.status]}
        </span>
      </div>

      <h2 className="mt-1 text-xl font-bold text-app-ink">{name}</h2>
      {plan && (
        <p className="mt-1 text-3xl font-bold text-app-ink">
          {formatPrice(plan.priceMonthlyUsd)}
          {plan.priceMonthlyUsd !== null && plan.priceMonthlyUsd > 0 && (
            <span className="text-sm font-normal text-app-ink-3"> / month</span>
          )}
        </p>
      )}

      {plan && plan.features.length > 0 && (
        <ul className="mt-5 flex-1 space-y-2.5 text-sm text-app-ink-2">
          {plan.features.map((f) => (
            <li key={f} className="flex items-start gap-2.5">
              <Check className="mt-0.5 h-4 w-4 shrink-0 text-violet" strokeWidth={2.5} />
              <span>{f}</span>
            </li>
          ))}
        </ul>
      )}

      <p className="mt-4 text-xs text-app-ink-3">
        Billed via {subscription.provider}. Prices are illustrative.
      </p>

      <Link
        href="#plans"
        className="mt-6 block w-full rounded-xl bg-[linear-gradient(135deg,#6a30ec_0%,#5216dd_100%)] px-5 py-2.5 text-center text-sm font-semibold text-white shadow-[0_14px_34px_-12px_rgba(91,33,230,0.85)] transition-all hover:-translate-y-0.5 hover:brightness-110"
      >
        Change Plan
      </Link>

      {/* Real hosted portal (Stripe) when available; mock mode has no external
          customer, so the mutation resolves url: null and this becomes a no-op. */}
      <button
        type="button"
        onClick={() => portal.mutate()}
        disabled={portal.isPending}
        className="mt-2.5 w-full rounded-xl border border-app-border-strong bg-app-surface px-5 py-2.5 text-center text-sm font-medium text-app-ink-2 transition-colors hover:border-app-border-strong hover:bg-app-raised disabled:cursor-not-allowed disabled:opacity-50"
      >
        {portal.isPending ? 'Opening…' : 'Manage Billing (payment method, invoices, cancel)'}
      </button>
      {portal.isSuccess && !portal.data.url && (
        <p className="mt-2 text-xs text-app-ink-3">
          Billing management isn&rsquo;t available in mock mode.
        </p>
      )}
    </div>
  );
}
