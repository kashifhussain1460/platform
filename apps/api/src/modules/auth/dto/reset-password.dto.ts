import { IsString, Matches, MinLength } from 'class-validator';
import {
  PASSWORD_HAS_LETTER,
  PASSWORD_HAS_NUMBER,
  PASSWORD_MIN_LENGTH,
} from '@vaep/types';

/** POST /auth/reset-password — set a new password using an emailed token. */
export class ResetPasswordDto {
  @IsString()
  @MinLength(1)
  token!: string;

  // Same canonical policy as register (shared @vaep/types).
  @IsString()
  @MinLength(PASSWORD_MIN_LENGTH, { message: 'Password must be at least 8 characters.' })
  @Matches(PASSWORD_HAS_LETTER, { message: 'Password must include a letter.' })
  @Matches(PASSWORD_HAS_NUMBER, { message: 'Password must include a number.' })
  password!: string;
}
