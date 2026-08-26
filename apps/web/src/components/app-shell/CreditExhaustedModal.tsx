'use client';

import Link from 'next/link';

/**
 * §21's Zero-state blocking modal — the one truly interruptive credit UI in
 * the product. Shown when a chat send / workflow trigger / AI Assist
 * generation is rejected by Layer 1 (company balance exhausted), detected via
 * `isCreditExhaustedError`. Every other credit state (Normal/Low/Critical)
 * stays non-blocking by design (§21) — only Zero gets this treatment.
 */
export function CreditExhaustedModal({ onClose }: { onClose: () => void }) {
  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label="Out of credits"
      className="fixed inset-0 z-[60] flex items-center justify-center bg-black/70 p-4"
    >
      <div className="w-full max-w-sm rounded-2xl border border-app-border bg-app-surface p-6 text-center">
        <h2 className="text-lg font-bold text-app-ink">Out of credits</h2>
        <p className="mt-2 text-sm text-app-ink-2">
          This company has run out of credits. An owner or admin needs to add more credits
          before this can continue.
        </p>
        <div className="mt-5 flex flex-col gap-2">
          <Link
            href="/billing#buy-credits"
            className="rounded-xl bg-[linear-gradient(135deg,#6a30ec_0%,#5216dd_100%)] px-4 py-2 text-sm font-semibold text-white transition-all hover:-translate-y-0.5 hover:brightness-110"
          >
            Buy credits
          </Link>
          <button
            type="button"
            onClick={onClose}
            className="rounded-xl border border-app-border-strong px-4 py-2 text-sm font-medium text-app-ink-2 hover:bg-app-raised"
          >
            Close
          </button>
        </div>
      </div>
    </div>
  );
}
