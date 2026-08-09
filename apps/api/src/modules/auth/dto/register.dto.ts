import {
  IsEmail,
  IsOptional,
  IsString,
  Matches,
  MaxLength,
  MinLength,
} from 'class-validator';
import {
  PASSWORD_HAS_LETTER,
  PASSWORD_HAS_NUMBER,
  PASSWORD_MIN_LENGTH,
  type RegisterDto as IRegisterDto,
} from '@vaep/types';

/** POST /auth/register body. Mirrors the shared @vaep/types contract. */
export class RegisterDto implements IRegisterDto {
  @IsString()
  @MinLength(2)
  @MaxLength(120)
  companyName!: string;

  @IsString()
  @MinLength(1)
  @MaxLength(120)
  name!: string;

  @IsEmail()
  email!: string;

  // Canonical password policy (shared @vaep/types): ≥8 chars + a letter + a
  // number. Backend is authoritative.
  @IsString()
  @MinLength(PASSWORD_MIN_LENGTH)
  @MaxLength(200)
  @Matches(PASSWORD_HAS_LETTER, { message: 'Password must include a letter.' })
  @Matches(PASSWORD_HAS_NUMBER, { message: 'Password must include a number.' })
  password!: string;

  // Optional company profile (Step 2 richer registration) + admin phone.
  @IsOptional()
  @IsString()
  @MaxLength(120)
  industry?: string;

  @IsOptional()
  @IsString()
  @MaxLength(40)
  size?: string;

  @IsOptional()
  @IsString()
  @MaxLength(120)
  country?: string;

  @IsOptional()
  @IsString()
  @MaxLength(80)
  timezone?: string;

  @IsOptional()
  @IsString()
  @MaxLength(200)
  website?: string;

  @IsOptional()
  @IsString()
  @MaxLength(500)
  logoUrl?: string;

  @IsOptional()
  @IsString()
  @MaxLength(2000)
  description?: string;

  @IsOptional()
  @IsString()
  @MaxLength(40)
  phone?: string;
}
