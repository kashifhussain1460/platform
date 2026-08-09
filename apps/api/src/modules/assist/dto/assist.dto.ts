import {
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  MaxLength,
  Min,
  MinLength,
} from 'class-validator';
import { ASSIST_SESSION_STATUSES, type AssistSessionStatus } from '@vaep/types';

/** POST /assist/sessions */
export class CreateAssistSessionDto {
  /** The opening ask. Optional: the UI may open an empty session first. */
  @IsOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(4000)
  prompt?: string;

  /** Set to EDIT an existing workflow rather than build a new one. */
  @IsOptional()
  @IsString()
  targetWorkflowId?: string;

  /** Set when entered via "Fix with AI" from a failed run. */
  @IsOptional()
  @IsString()
  originRunId?: string;
}

/** GET /assist/sessions */
export class ListAssistSessionsDto {
  @IsOptional()
  @IsIn(ASSIST_SESSION_STATUSES)
  status?: AssistSessionStatus;

  @IsOptional()
  @IsInt()
  @Min(1)
  limit?: number;
}

/** POST /assist/sessions/:id/turns — say something to the agent. */
export class AssistTurnDto {
  @IsString()
  @MinLength(1)
  @MaxLength(4000)
  text!: string;
}

/**
 * POST /assist/sessions/:id/turns/stream — same as a turn, but `text` is
 * OPTIONAL: when a session was created with an opening prompt, that prompt is
 * already stored and the client just opens the stream to have it answered,
 * rather than sending the same words twice.
 */
export class AssistStreamTurnDto {
  @IsOptional()
  @IsString()
  @MaxLength(4000)
  text?: string;
}

/** POST /assist/sessions/:id/accept — turn the draft into a real workflow. */
export class AcceptAssistSessionDto {
  @IsString()
  @MinLength(1)
  @MaxLength(120)
  name!: string;

  @IsOptional()
  @IsString()
  @MaxLength(2000)
  description?: string;
}
