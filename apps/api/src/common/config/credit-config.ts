/**
 * Credit system feature flags (docs/architecture/orlixa-ai-credit-usage-billing-plan.md).
 * Raw `process.env` reads, mirroring `queueWorkersEnabled()`'s pattern — cheap,
 * synchronous, and readable from anywhere without adding `ConfigService` as a
 * dependency to every call site.
 */

/**
 * Phase 3 (Usage Integration), Task 3.3. Default `false`: with the flag off,
 * every reserve/settle/release call site is a complete no-op — zero behavior
 * change from pre-Phase-3, verified by a spy in each call site's own test.
 * Set `true` to run the reservation lifecycle in SHADOW MODE (entries are
 * written and metriced; nothing is ever blocked — enforcement is Phase 8,
 * gated separately behind `CREDIT_ENFORCEMENT_ENABLED`).
 */
export function creditLedgerEnabled(): boolean {
  return process.env.CREDIT_LEDGER_ENABLED === 'true';
}

/**
 * Phase 4 (Free Credits), Task 4.1. Default `false`: with the flag off, no
 * grant logic is reachable at all (onboarding completes exactly as before
 * Phase 4 existed). Must not be flipped `true` in production before Task
 * 4.2's mail-enabled boot guard and domain-velocity counter are live —
 * enforced structurally by Task 4.2 shipping in the same release, not by
 * this flag alone.
 */
export function creditGrantsEnabled(): boolean {
  return process.env.CREDIT_GRANTS_ENABLED === 'true';
}

/** // FOUNDER-PENDING: one-time signup grant size. Illustrative — a round, easy-to-reason-about trial amount pending founder approval, not derived from any real cost model. */
export function freeGrantCredits(): number {
  const raw = Number(process.env.FREE_GRANT_CREDITS);
  return Number.isFinite(raw) && raw > 0 ? raw : 1_000;
}

/** // FOUNDER-PENDING: how long the free-signup CreditLot stays claimable before it expires unused. */
export function freeGrantExpiryDays(): number {
  const raw = Number(process.env.FREE_GRANT_EXPIRY_DAYS);
  return Number.isFinite(raw) && raw > 0 ? raw : 30;
}

/** // FOUNDER-PENDING: kill-critic Q11 abuse control — max free grants per email domain per 24h window. */
export function freeGrantDomainCap(): number {
  const raw = Number(process.env.FREE_GRANT_DOMAIN_CAP);
  return Number.isFinite(raw) && raw > 0 ? raw : 3;
}

/**
 * Phase 5 (PAYG), Task 5.2. Default `false`: the purchase endpoint returns a
 * clear "not available yet" response rather than creating a real Checkout
 * Session — independently revertible without touching Phase 6's webhook
 * grant loop.
 */
export function creditPaygEnabled(): boolean {
  return process.env.CREDIT_PAYG_ENABLED === 'true';
}

/**
 * Phase 8 (Enforcement), Task 8.3. Default `false` — the GLOBAL switch.
 * Even when `true`, a company only actually gets enforced if it is ALSO on
 * the per-company canary allowlist (`Company.creditEnforcementEnabledAt`,
 * see `companyEnforcementActive` below) — this flag alone does not turn
 * anything on for anyone; it only makes the ALLOWLIST meaningful. The
 * two-key design is deliberate: flipping this globally without ANY company
 * enrolled changes nothing (§36's staged-rollout requirement), and
 * unsetting it INSTANTLY reverts every enrolled company to shadow mode
 * regardless of their individual `creditEnforcementEnabledAt` value.
 */
export function creditEnforcementEnabled(): boolean {
  return process.env.CREDIT_ENFORCEMENT_ENABLED === 'true';
}

/**
 * Whether enforcement (Layers 1-3, Task 8.3) is actually active for THIS
 * company right now: the global flag must be on AND this company must be
 * individually enrolled (`creditEnforcementEnabledAt` set). With either
 * condition false, every real spend call site stays on the unchanged
 * Phase 3 shadow path — nothing is ever blocked.
 */
export function companyEnforcementActive(company: {
  creditEnforcementEnabledAt: Date | null;
}): boolean {
  return creditEnforcementEnabled() && company.creditEnforcementEnabledAt != null;
}
