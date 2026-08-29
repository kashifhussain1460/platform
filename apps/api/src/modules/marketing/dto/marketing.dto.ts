import type { ManualCampaignStatus } from '@vaep/types';
import { MANUAL_CAMPAIGN_STATUSES } from '@vaep/types';
import {
  IsBoolean,
  IsIn,
  IsISO8601,
  IsOptional,
  IsString,
  MaxLength,
  MinLength,
} from 'class-validator';

export class StartConnectDto {
  /** Postiz provider identifier, e.g. "instagram", "linkedin". */
  @IsString()
  @MinLength(2)
  @MaxLength(40)
  platform!: string;
}

export class CreatePostDto {
  @IsString()
  socialAccountId!: string;

  /**
   * Bounded well above any real platform limit rather than at one specific
   * platform's cap — the providers disagree (X is short, LinkedIn is long) and
   * Postiz is the one that knows which applies. This only stops abuse.
   */
  @IsString()
  @MinLength(1)
  @MaxLength(10_000)
  content!: string;

  @IsOptional()
  @IsISO8601()
  publishAt?: string;

  @IsOptional()
  @IsString()
  campaignId?: string;

  /** true actually hands the post to Postiz; false/absent saves a local draft. */
  @IsOptional()
  @IsBoolean()
  schedule?: boolean;
}

export class UpdatePostDto {
  @IsOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(10_000)
  content?: string;

  @IsOptional()
  @IsISO8601()
  publishAt?: string;

  @IsOptional()
  @IsString()
  campaignId?: string;
}

export class CreateCampaignBodyDto {
  @IsString()
  @MinLength(1)
  @MaxLength(200)
  name!: string;

  @IsOptional()
  @IsString()
  @MaxLength(2_000)
  goal?: string;

  @IsOptional()
  @IsString()
  aiEmployeeId?: string;
}

export class UpdateCampaignBodyDto {
  @IsOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(200)
  name?: string;

  @IsOptional()
  @IsString()
  @MaxLength(2_000)
  goal?: string;

  /**
   * Only the operational states. The generation states are owned by the
   * pipeline — accepting them here would let a client PATCH straight to
   * READY_FOR_REVIEW and skip generation, or claim PUBLISHING for work that
   * never ran.
   */
  @IsOptional()
  @IsIn(MANUAL_CAMPAIGN_STATUSES)
  status?: ManualCampaignStatus;
}

export class SetPostizCustomerGroupDto {
  /**
   * Nullable on purpose: clearing the bridge must be possible, and clearing it
   * makes the import fail closed again rather than silently keeping the last
   * value.
   */
  @IsOptional()
  @IsString()
  @MaxLength(200)
  postizCustomerGroupId?: string | null;
}

export class CreateAiCampaignBodyDto {
  /**
   * The brief in the user's own words (§8). Bounded generously — a detailed
   * brief produces a better plan — but bounded, because this string is sent to
   * a model.
   */
  @IsString()
  @MinLength(10)
  @MaxLength(4_000)
  brief!: string;

  /** IANA zone. When supplied it WINS over whatever the AI infers (§35). */
  @IsOptional()
  @IsString()
  @MaxLength(64)
  timezone?: string;

  @IsOptional()
  @IsString()
  aiEmployeeId?: string;
}

export class SelectVariantBodyDto {
  @IsString()
  variantId!: string;
}
