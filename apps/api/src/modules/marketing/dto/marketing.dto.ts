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

  @IsOptional()
  @IsIn(['ACTIVE', 'PAUSED', 'COMPLETED'])
  status?: string;
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
