import type { WorkflowTemplateManifest } from '@vaep/types';
import { HR_WORKFLOW_TEMPLATES } from './hr-workflow-templates.catalog';
import { MARKETING_WORKFLOW_TEMPLATES } from './marketing-workflow-templates.catalog';

/**
 * The full first-party workflow-template catalog — trusted, code-defined, and
 * seeded into the WorkflowTemplate table (companyId = null, status PUBLISHED) on
 * boot. Split by domain: 11 HR (P3-03) + 11 Marketing (P3-04). Every manifest is
 * validated by `validateManifest` on seed and by `workflow-templates.catalog.spec.ts`.
 */
export const FIRST_PARTY_WORKFLOW_TEMPLATES: readonly WorkflowTemplateManifest[] =
  [...HR_WORKFLOW_TEMPLATES, ...MARKETING_WORKFLOW_TEMPLATES];
