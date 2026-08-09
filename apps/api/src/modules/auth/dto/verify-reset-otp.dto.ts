import { IsEmail, IsString, Length } from 'class-validator';

/** POST /auth/verify-reset-otp — email + the 6-digit reset code. */
export class VerifyResetOtpDto {
  @IsEmail()
  email!: string;

  @IsString()
  @Length(6, 6, { message: 'Enter the 6-digit code.' })
  code!: string;
}
