import {
  ArrayMaxSize,
  IsArray,
  IsOptional,
  IsString,
  MaxLength,
  MinLength,
} from 'class-validator';
import type { UpdateDepartmentDto as IUpdateDepartmentDto } from '@vaep/types';

/** PATCH /departments/:id body. Mirrors the shared @vaep/types contract. */
export class UpdateDepartmentDto implements IUpdateDepartmentDto {
  @IsOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(120)
  name?: string;

  // @IsOptional() also skips validation for an explicit null (clears the field).
  @IsOptional()
  @IsString()
  @MaxLength(2000)
  description?: string | null;

  /**
   * WAVE 2 §2.1 — resource scopes this department may act on. Replaces the whole
   * list; `[]` turns department isolation back OFF.
   */
  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  @MaxLength(60, { each: true })
  @ArrayMaxSize(50)
  scopes?: string[];
}
