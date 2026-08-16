import { IsBoolean, IsEmail, IsOptional } from 'class-validator';

/**
 * POST /skills/installed/:id/verify body (plan §3 TESTING stage).
 *
 * Both fields are optional and default to the safe choice: verification runs the
 * authentication + account stages only, and a test action happens ONLY when the
 * caller explicitly asks. A "test" that quietly emails somebody the first time a
 * page loads is an outbound action, not a diagnostic.
 */
export class VerifyConnectionDto {
  /** Run the provider's real test action (e.g. send a test email). */
  @IsOptional()
  @IsBoolean()
  sendTest?: boolean;

  /**
   * Where the test action should go. Omitted → the connection's own address, so
   * the default can never reach a third party.
   */
  @IsOptional()
  @IsEmail()
  testTo?: string;
}
