'use client';

import { useCreditBalance, useCreditPacks, usePurchaseCredits } from '../credits-hooks';

/** Formats a credit-pack size with its bonus, e.g. "5,500 credits (+10%)". */
function formatPack(creditAmount: number, bonusPercent: number): string {
  const base = creditAmount.toLocaleString();
  return bonusPercent > 0 ? `${base} credits (+${bonusPercent}%)` : `${base} credits`;
}

/**
 * §22 CREATE NEW — buy-credits section (Task 9.3). Mirrors CurrentPlanCard's
 * "isn't available in mock mode" pattern for the mock/stubbed-Stripe case: a
 * null `checkoutUrl` is a normal, expected response under the mock provider,
 * not an error.
 */
export function CreditPurchaseSection() {
  const { data: balance, isLoading: balanceLoading } = useCreditBalance();
  const { data: packs, isLoading: packsLoading } = useCreditPacks();
  const purchase = usePurchaseCredits();

  return (
    <div id="buy-credits" className="rounded-2xl border border-app-border bg-app-surface p-6">
      <div className="flex items-baseline justify-between">
        <p className="text-sm font-medium text-app-ink-2">Credit Balance</p>
        {!balanceLoading && balance && (
          <p className="text-2xl font-bold text-app-ink">
            {balance.balance.toLocaleString()} <span className="text-sm font-normal text-app-ink-3">credits</span>
          </p>
        )}
      </div>

      <p className="mt-4 text-sm font-medium text-app-ink-2">Buy more credits</p>
      {packsLoading && <p className="mt-2 text-sm text-app-ink-3">Loading packs…</p>}
      <div className="mt-3 grid gap-3 sm:grid-cols-3">
        {packs?.map((pack) => (
          <div
            key={pack.id}
            className="flex flex-col rounded-xl border border-app-border-strong bg-app-raised p-4"
          >
            <p className="text-sm font-semibold text-app-ink">{pack.displayName}</p>
            <p className="mt-1 text-xs text-app-ink-3">
              {formatPack(pack.creditAmount, pack.bonusPercent)}
            </p>
            <p className="mt-2 text-lg font-bold text-app-ink">${pack.priceUsd}</p>
            <button
              type="button"
              onClick={() => purchase.mutate(pack.packKey)}
              disabled={purchase.isPending}
              className="mt-3 w-full rounded-lg bg-[linear-gradient(135deg,#6a30ec_0%,#5216dd_100%)] px-3 py-2 text-center text-xs font-semibold text-white transition-all hover:-translate-y-0.5 hover:brightness-110 disabled:cursor-not-allowed disabled:opacity-50"
            >
              {purchase.isPending ? 'Starting…' : 'Buy'}
            </button>
          </div>
        ))}
      </div>
      {purchase.isSuccess && !purchase.data.checkoutUrl && (
        <p className="mt-3 text-xs text-app-ink-3">
          Credit purchase isn&rsquo;t available in mock mode.
        </p>
      )}
      <p className="mt-4 text-xs text-app-ink-3">Prices are illustrative.</p>
    </div>
  );
}
