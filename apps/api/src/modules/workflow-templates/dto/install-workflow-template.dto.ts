import { IsObject, IsOptional, IsString, MaxLength } from 'class-validator';
import type { InstallWorkflowTemplateDto as IInstallWorkflowTemplateDto } from '@vaep/types';

/** POST /workflow-templates/:id/install body. Deep parameter validation is done
 *  by the service against the template's declared parameters. */
export class InstallWorkflowTemplateDto implements IInstallWorkflowTemplateDto {
  @IsOptional()
  @IsString()
  @MaxLength(200)
  name?: string;

  @IsOptional()
  @IsObject()
  parameters?: Record<string, unknown>;
}
