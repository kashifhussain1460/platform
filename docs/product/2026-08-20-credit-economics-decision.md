# Credit Economics — Founder Decision Record

Status: AWAITING SIGN-OFF. `CREDIT_ENFORCEMENT_ENABLED` must not be flipped for a real paying
company until every row below is either checked "Lock as-is" or replaced with a real number.

| # | Parameter | Current default | Source | Decision |
|---|-----------|------------------|--------|----------|
| 1 | $/credit peg | $0.01 (`DEFAULT_CREDITS_PER_USD=100`) | `apps/api/src/modules/credits/credit-rates.defaults.ts:18` | ☐ Lock as-is ☐ Override: ____ |
| 2 | Safety margin on provider cost | 10% | `credit-rates.defaults.ts:22`, `credit-cost-calculator.service.ts:70` | ☐ Lock as-is ☐ Override: ____ |
| 3 | Free signup credit grant | 1,000 credits | `apps/api/src/common/config/credit-config.ts:32` | ☐ Lock as-is ☐ Override: ____ |
| 4 | Signup grant expiry | 30 days | `credit-config.ts:38` | ☐ Lock as-is ☐ Override: ____ |
| 5 | Signup abuse domain cap | 3 signups/domain | `credit-config.ts:44` | ☐ Lock as-is ☐ Override: ____ |
| 6 | PRO plan monthly allotment | 4,000 credits | `apps/api/src/modules/billing/billing.plans.ts:38` | ☐ Lock as-is ☐ Override: ____ |
| 7 | BUSINESS plan monthly allotment | 18,000 credits | `billing.plans.ts:53` | ☐ Lock as-is ☐ Override: ____ |
| 8 | Credit pack: SMALL | $10 / 1,000 credits | `apps/api/src/modules/billing/credit-packs.ts:16` | ☐ Lock as-is ☐ Override: ____ |
| 9 | Credit pack: MEDIUM | $50 / 5,500 credits | `credit-packs.ts:27` | ☐ Lock as-is ☐ Override: ____ |
| 10 | Credit pack: LARGE | $100 / 12,000 credits | `credit-packs.ts:27` | ☐ Lock as-is ☐ Override: ____ |
| 11 | Nav badge Low/Critical thresholds | 25% / 10% of trailing spend | `apps/web/src/components/app-shell/CreditBadge.tsx:10-23` | ☐ Lock as-is ☐ Override: ____ |
| 12 | Company concurrency cap | see `company-concurrency-guard.service.ts:7` default | same file | ☐ Lock as-is ☐ Override: ____ |
| 13 | Reconciliation drift tolerance | see `credit-reconciliation.service.ts:7` default | same file | ☐ Lock as-is ☐ Override: ____ |

**Signed off by:** _______________  **Date:** _______________

Once every row is checked, update the corresponding constant (removing its `FOUNDER-PENDING`
comment) in a follow-up commit — this record is the sign-off, not the code change.
