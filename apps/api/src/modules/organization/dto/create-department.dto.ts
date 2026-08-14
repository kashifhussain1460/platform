import {
  ArrayMaxSize,
  IsArray,
  IsOptional,
  IsString,
  MaxLength,
  MinLength,
} from 'class-validator';
import type { CreateDepartmentDto as ICreateDepartmentDto } from '@vaep/types';

/** POST /departments body. Mirrors the shared @vaep/types contract. */
export class CreateDepartmentDto implements ICreateDepartmentDto {
  @IsString()
  @MinLength(1)
  @MaxLength(120)
  name!: string;

  @IsOptional()
  @IsString()
  @MaxLength(2000)
  description?: string;

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
