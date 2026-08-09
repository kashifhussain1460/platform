import { IsString, Length } from 'class-validator';

/** POST /auth/verify-email — a 6-digit one-time code. */
export class VerifyEmailDto {
  @IsString()
  @Length(6, 6, { message: 'Enter the 6-digit code.' })
  code!: string;
}
