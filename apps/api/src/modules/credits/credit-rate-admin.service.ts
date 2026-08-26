import { Injectable } from '@nestjs/common';
import type { ModelCostRate, ToolCostRate } from '@prisma/client';
import { PrismaService } from '../../common/prisma/prisma.service';
import type { DefaultModelRate, DefaultToolRate } from './credit-rates.defaults';

/**
 * Enforces §16's "at-most-one-current-row-per-(provider,model), closed at
 * the service layer" rule (Phase 2, Task 2.4) — and its `(skillKey, tool)`
 * sibling for tool rates.
 */
@Injectable()
export class CreditRateAdminService {
  constructor(private readonly prisma: PrismaService) {}

  /** Admin-driven explicit rate change: closes the current open row (if any), creates a new one. */
  async setModelRate(input: {
    provider: string;
    model: string;
    promptRatePer1MUsd: number;
    completionRatePer1MUsd: number;
    creditsPerUsd: number;
  }): Promise<ModelCostRate> {
    return this.prisma.$transaction(async (tx) => {
      const now = new Date();
      await tx.modelCostRate.updateMany({
        where: { provider: input.provider, model: input.model, effectiveTo: null },
        data: { effectiveTo: now },
      });
      return tx.modelCostRate.create({
        data: {
          provider: input.provider,
          model: input.model,
          promptRatePer1MUsd: input.promptRatePer1MUsd,
          completionRatePer1MUsd: input.completionRatePer1MUsd,
          creditsPerUsd: input.creditsPerUsd,
          effectiveFrom: now,
        },
      });
    });
  }

  /** Admin-driven explicit rate change, tool-call sibling of {@link setModelRate}. */
  async setToolRate(input: {
    skillKey: string;
    tool: string;
    creditsPerCall: number;
  }): Promise<ToolCostRate> {
    return this.prisma.$transaction(async (tx) => {
      const now = new Date();
      await tx.toolCostRate.updateMany({
        where: { skillKey: input.skillKey, tool: input.tool, effectiveTo: null },
        data: { effectiveTo: now },
      });
      return tx.toolCostRate.create({
        data: {
          skillKey: input.skillKey,
          tool: input.tool,
          creditsPerCall: input.creditsPerCall,
          effectiveFrom: now,
        },
      });
    });
  }

  /**
   * Idempotent bootstrap: returns the current open rate row for
   * `(provider, model)` if one exists; otherwise creates the FIRST row from
   * the given defaults (§16 Option C) and returns it. Never opens a second
   * row for a pair that already has one — that is `setModelRate`'s job, and
   * only an explicit admin call should trigger a rate CHANGE.
   */
  async ensureModelRate(
    provider: string,
    model: string,
    fallback: DefaultModelRate,
  ): Promise<ModelCostRate> {
    const existing = await this.prisma.modelCostRate.findFirst({
      where: { provider, model, effectiveTo: null },
    });
    if (existing) return existing;
    return this.setModelRate({
      provider,
      model,
      promptRatePer1MUsd: fallback.promptRatePer1MUsd,
      completionRatePer1MUsd: fallback.completionRatePer1MUsd,
      creditsPerUsd: fallback.creditsPerUsd,
    });
  }

  /** Tool-call sibling of {@link ensureModelRate}. */
  async ensureToolRate(
    skillKey: string,
    tool: string,
    fallback: DefaultToolRate,
  ): Promise<ToolCostRate> {
    const existing = await this.prisma.toolCostRate.findFirst({
      where: { skillKey, tool, effectiveTo: null },
    });
    if (existing) return existing;
    return this.setToolRate({
      skillKey,
      tool,
      creditsPerCall: fallback.creditsPerCall,
    });
  }
}
