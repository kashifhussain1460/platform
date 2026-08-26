import { IsBoolean } from 'class-validator';

/** PATCH /internal/platform-admin/companies/:companyId/credit-enforcement body. */
export class SetCreditEnforcementDto {
  /** true = enroll now (stamps `creditEnforcementEnabledAt`); false = revert to advisory-only (clears it). */
  @IsBoolean()
  enabled!: boolean;
}
