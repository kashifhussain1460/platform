import { IsNumber, IsString, MinLength } from 'class-validator';

/** POST /internal/platform-admin/companies/:companyId/credits/adjustments body. */
export class AdjustCreditsDto {
  /** Signed — positive grants, negative debits. */
  @IsNumber()
  amount!: number;

  /** §31.5 — mandatory, minimum 10 characters (no one-word "fix" reasons on the most protected mutation in the system). */
  @IsString()
  @MinLength(10)
  reason!: string;
}
