/**
 * "Automation by team" categories shown on `/automation`.
 *
 * Source of truth: `apps/api/src/modules/workflow-templates/*-workflow-templates.catalog.ts`
 * — the first-party, shipped workflow-template catalog. Only two categories
 * exist there today (`HR`, 11 templates; `MARKETING`, 11 templates); every
 * other business function has an AI Employee role (see
 * `features/marketing/ai-employees.ts`) but no shipped workflow templates
 * yet. Do not mark a category `available` here until a matching catalog
 * file actually exists — that flag is what keeps this list honest.
 */

export interface AutomationCategory {
  name: string;
  description: string;
  available: boolean;
  /** Only set when `available` — the best existing page to send interest to. */
  href?: string;
}

export const AUTOMATION_CATEGORIES: AutomationCategory[] = [
  {
    name: 'HR Automation',
    description: 'Onboarding tasks, leave requests, performance reviews and more — 11 ready-to-use templates.',
    available: true,
    href: '/ai-employees/hr-ai',
  },
  {
    name: 'Marketing Automation',
    description: 'Campaign drafts, content calendars, social scheduling and more — 11 ready-to-use templates.',
    available: true,
    href: '/ai-employees/marketing-ai',
  },
  { name: 'Recruiting Automation', description: 'Workflow templates for recruiting are on our roadmap.', available: false },
  { name: 'Sales Automation', description: 'Workflow templates for sales are on our roadmap.', available: false },
  { name: 'Support Automation', description: 'Workflow templates for customer support are on our roadmap.', available: false },
  { name: 'Finance Automation', description: 'Workflow templates for finance are on our roadmap.', available: false },
  { name: 'Project Management Automation', description: 'Workflow templates for project management are on our roadmap.', available: false },
  { name: 'Procurement Automation', description: 'Workflow templates for procurement are on our roadmap.', available: false },
  { name: 'Operations Automation', description: 'Workflow templates for operations are on our roadmap.', available: false },
  { name: 'Legal Automation', description: 'Workflow templates for legal are on our roadmap.', available: false },
];
