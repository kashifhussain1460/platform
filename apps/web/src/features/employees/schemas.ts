// Re-export the shared validation contract so components import from the feature.
import { z } from 'zod';
import { employeeConfigSchema } from '@vaep/types';

export {
  createEmployeeSchema,
  updateEmployeeSchema,
  employeeConfigSchema,
  kpiTargetsSchema,
  sendMessageSchema,
  createFeedbackSchema,
  createMemorySchema,
  EMPLOYEE_ROLES,
  EMPLOYEE_STATUSES,
  KNOWLEDGE_ACCESSES,
  FEEDBACK_RATINGS,
  MEMORY_KINDS,
} from '@vaep/types';
export type {
  AiEmployeeDto,
  ConversationDto,
  CreateEmployeeDto,
  UpdateEmployeeDto,
  EmployeeConfigDto,
  SendMessageDto,
  MessageDto,
  MessageMetadataDto,
  MessageValidationDto,
  RunResultDto,
  EmployeeRole,
  EmployeeStatus,
  KnowledgeAccess,
  KpiTargets,
  MessageRole,
  SearchResultDto,
  CreateFeedbackDto,
  CreateMemoryDto,
  EmployeeFeedbackDto,
  EmployeeMemoryDto,
  LearningSummaryDto,
  FeedbackRating,
  MemoryKind,
  MemorySource,
} from '@vaep/types';

/** The employee Settings panel form: name + the shared rich-config fields. */
export const employeeSettingsSchema = employeeConfigSchema.extend({
  name: z.string().min(1, 'Name is required').max(120),
  /**
   * The AI model this employee uses. Blank = the company default.
   *
   * Not part of the shared `employeeConfigSchema` because `createEmployeeSchema`
   * and `updateEmployeeSchema` already declare `model` alongside `persona`;
   * adding it to the config object too would give the same field two homes.
   * `PATCH /employees/:id` has always accepted it — the Settings panel simply
   * had no control, which is what made `AiEmployee.model` a dead setting
   * (audit P1-F).
   *
   * Length-capped and otherwise unvalidated on purpose: a model id is vendor
   * data that changes faster than this codebase ships, and only the provider can
   * meaningfully reject one.
   */
  model: z.string().max(120).optional(),
});

export type EmployeeSettingsDto = z.infer<typeof employeeSettingsSchema>;
