import { IsIn } from 'class-validator';
import { CREDIT_PACK_IDS, type CreditPackId } from '../credit-packs';

/** POST /billing/credits/purchase body. */
export class PurchaseCreditsDto {
  @IsIn(CREDIT_PACK_IDS)
  packId!: CreditPackId;
}
