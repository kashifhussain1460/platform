import { IsEmail } from 'class-validator';

/** POST /auth/forgot-password — request a reset link by email. */
export class ForgotPasswordDto {
  @IsEmail()
  email!: string;
}
