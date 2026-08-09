import {
  IsDateString,
  IsIn,
  IsNumber,
  IsOptional,
  IsString,
  Max,
  MaxLength,
  Min,
  MinLength,
} from 'class-validator';
import {
  STAFF_DOCUMENT_TYPES,
  type CreateStaffDocumentDto as ICreateStaffDocumentDto,
} from '@vaep/types';

/** POST /hr/staff/:staffId/documents body. */
export class CreateStaffDocumentDto implements ICreateStaffDocumentDto {
  @IsString()
  staffId!: string;

  @IsIn(STAFF_DOCUMENT_TYPES)
  docType!: string;

  @IsString()
  @MinLength(1)
  @MaxLength(1024)
  storageKey!: string;

  @IsString()
  @MinLength(1)
  @MaxLength(512)
  fileName!: string;

  @IsString()
  @MinLength(1)
  @MaxLength(255)
  mimeType!: string;

  @IsOptional()
  @IsNumber()
  @Min(0)
  @Max(1)
  aiConfidence?: number | null;

  @IsOptional()
  @IsDateString()
  expiresAt?: string | null;
}
