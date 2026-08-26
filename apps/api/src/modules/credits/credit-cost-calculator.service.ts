import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { CreditRateAdminService } from './credit-rate-admin.service';
import { decimalToNumber } from './credits.types';
import {
  DEFAULT_MODEL_RATES,
  DEFAULT_SAFETY_MARGIN_PCT,
  DEFAULT_TOOL_RATES,
} from './credit-rates.defaults';

export interface PriceLlmCallInput {
  provider: string;
  model: string;
  promptTokens: number;
  completionTokens: number;
}

export interface PriceToolCallInput {
  skillKey: string;
  tool: string;
}

/**
 * Implements the §5/§6/§16 pipeline (Provider Cost → Internal Cost Unit →
 * Credit Multiplier → Credits Charged) as one pure-function-shaped service
 * (Phase 2, Task 2.3). No ledger writes here — this only computes a credit
 * amount and resolves which frozen rate row produced it.
 *
 * Pricing is a pure, reproducible function of `(rate row id, usage)`: the
 * resolved rate row's numbers never change after creation (§16 — closing
 * the old row and opening a new one is the ONLY way a rate changes, never a
 * mutation), so the same `(rate id, tokens)` pair always reprices
 * identically, satisfying the immutability requirement directly.
 */
@Injectable()
export class CreditCostCalculatorService {
  constructor(
    private readonly rateAdmin: CreditRateAdminService,
    private readonly config: ConfigService,
  ) {}

  /** Missing-rate falls back to the checked-in defaults WITHOUT throwing — it seeds a real DB row via {@link CreditRateAdminService.ensureModelRate} so the returned id is always usable for `CreditLedgerService.append`'s rate-presence assertion. */
  async priceLlmCall(input: PriceLlmCallInput): Promise<{ credits: number; modelCostRateId: string }> {
    const fallback =
      DEFAULT_MODEL_RATES.find((r) => r.provider === input.provider && r.model === input.model) ??
      DEFAULT_MODEL_RATES.find((r) => r.provider === 'default' && r.model === 'default')!;
    const rate = await this.rateAdmin.ensureModelRate(input.provider, input.model, fallback);

    const providerCostUsd =
      (input.promptTokens / 1_000_000) * decimalToNumber(rate.promptRatePer1MUsd) +
      (input.completionTokens / 1_000_000) * decimalToNumber(rate.completionRatePer1MUsd);
    const withMargin = providerCostUsd * (1 + this.safetyMarginPct() / 100);
    const credits = Math.ceil(withMargin * decimalToNumber(rate.creditsPerUsd));

    return { credits, modelCostRateId: rate.id };
  }

  /** Returns `{ credits: 0, toolCostRateId: null }` for any tool with no real external cost today (Part A ground truth) — callers should skip reservation entirely for a free action rather than append a zero-amount, no-rate-id DEBIT. */
  async priceToolCall(
    input: PriceToolCallInput,
  ): Promise<{ credits: number; toolCostRateId: string | null }> {
    const fallback = DEFAULT_TOOL_RATES.find(
      (r) => r.skillKey === input.skillKey && r.tool === input.tool,
    );
    if (!fallback) return { credits: 0, toolCostRateId: null };
    const rate = await this.rateAdmin.ensureToolRate(input.skillKey, input.tool, fallback);
    return { credits: Math.ceil(decimalToNumber(rate.creditsPerCall)), toolCostRateId: rate.id };
  }

  /** // FOUNDER-PENDING: safety margin percentage — env-overridable, illustrated at 10% in the plan's worked example. */
  private safetyMarginPct(): number {
    const raw = this.config.get<string>('CREDIT_SAFETY_MARGIN_PCT');
    const parsed = raw !== undefined ? Number(raw) : NaN;
    return Number.isFinite(parsed) ? parsed : DEFAULT_SAFETY_MARGIN_PCT;
  }
}
