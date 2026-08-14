import { IsIn, IsOptional, IsString, MaxLength, MinLength } from 'class-validator';

/** POST /audit-log/legal-holds body. */
export class CreateLegalHoldDto {
  /**
   * Why the hold exists. REQUIRED: a hold with no stated reason cannot be
   * reviewed later, and "why is this data still here?" is exactly the question
   * a hold has to answer.
   */
  @IsString()
  @MinLength(3)
  @MaxLength(2000)
  reason!: string;

  /**
   * What to freeze. Omitted = `ALL`, which is what someone asking for a legal
   * hold means: freeze the data under dispute, not only the record of who
   * touched it. `AUDIT` narrows it to the trail alone.
   */
  @IsOptional()
  @IsIn(['ALL', 'AUDIT'])
  scope?: 'ALL' | 'AUDIT';
}
