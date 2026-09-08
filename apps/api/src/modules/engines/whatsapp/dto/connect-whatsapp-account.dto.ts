import { IsOptional, IsString, Matches, MinLength } from 'class-validator';
import type { ConnectWhatsAppAccountDto as IConnectWhatsAppAccountDto } from '@vaep/types';

// E.164: '+' followed by 8-15 digits, first digit 1-9 (no leading zero).
const E164_PATTERN = /^\+[1-9]\d{7,14}$/;

/**
 * POST /engines/whatsapp/accounts body.
 *
 * `WhatsAppAccount` is its own top-level Prisma model (not nested under
 * `InstalledSkill`) with no FK between the two tables, so the generic Skill
 * Config `api_key` connect flow (`POST /skills/installed/:id/connect`) has no
 * path to populate it — it only ever writes `InstalledSkill.credentials`. This
 * DTO is the dedicated request shape for the route that actually creates/
 * updates a `WhatsAppAccount` row. Mirrors @vaep/types.
 */
export class ConnectWhatsAppAccountDto implements IConnectWhatsAppAccountDto {
  @IsString()
  @MinLength(1)
  twilioAccountSid!: string;

  @IsString()
  @MinLength(1)
  twilioAuthToken!: string;

  // E.164 format (e.g. "+15550001111"), matching the catalog's field help text.
  @IsString()
  @Matches(E164_PATTERN, { message: 'whatsappSenderNumber must be E.164 format, e.g. +15550001111' })
  whatsappSenderNumber!: string;

  @IsOptional()
  @IsString()
  employeeId?: string;
}
