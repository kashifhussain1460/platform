import { IsIn, IsString, MaxLength, MinLength } from 'class-validator';
import {
  WORKFLOW_PERMISSION_ACTIONS,
  WORKFLOW_PERMISSION_SUBJECT_TYPES,
  type CreateWorkflowPermissionDto as ICreateWorkflowPermissionDto,
  type WorkflowPermissionAction,
  type WorkflowPermissionSubjectType,
} from '@vaep/types';

/** POST /workflows/:id/permissions body. */
export class CreateWorkflowPermissionDto
  implements ICreateWorkflowPermissionDto
{
  @IsIn(WORKFLOW_PERMISSION_SUBJECT_TYPES)
  subjectType!: WorkflowPermissionSubjectType;

  @IsString()
  @MinLength(1)
  @MaxLength(200)
  subjectId!: string;

  @IsIn(WORKFLOW_PERMISSION_ACTIONS)
  action!: WorkflowPermissionAction;
}
