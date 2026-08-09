import {
  IsDateString,
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  Max,
  MaxLength,
  Min,
} from 'class-validator';
import {
  PERFORMANCE_REVIEW_STATUSES,
  type CreatePerformanceReviewDto as ICreatePerformanceReviewDto,
  type UpdatePerformanceReviewDto as IUpdatePerformanceReviewDto,
} from '@vaep/types';

/** POST /hr/reviews body. */
export class CreatePerformanceReviewDto
  implements ICreatePerformanceReviewDto
{
  @IsString()
  staffId!: string;

  @IsDateString()
  periodStart!: string;

  @IsDateString()
  periodEnd!: string;

  @IsOptional()
  @IsString()
  @MaxLength(64)
  reviewerUserId?: string | null;

  @IsOptional()
  @IsString()
  @MaxLength(20000)
  aiDraft?: string | null;

  @IsOptional()
  @IsString()
  @MaxLength(20000)
  finalReview?: string | null;

  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(5)
  rating?: number | null;

  @IsOptional()
  @IsIn(PERFORMANCE_REVIEW_STATUSES)
  status?: string;
}

/** PATCH /hr/reviews/:id body. */
export class UpdatePerformanceReviewDto
  implements IUpdatePerformanceReviewDto
{
  @IsOptional()
  @IsString()
  @MaxLength(20000)
  aiDraft?: string | null;

  @IsOptional()
  @IsString()
  @MaxLength(20000)
  finalReview?: string | null;

  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(5)
  rating?: number | null;

  @IsOptional()
  @IsIn(PERFORMANCE_REVIEW_STATUSES)
  status?: string;
}
