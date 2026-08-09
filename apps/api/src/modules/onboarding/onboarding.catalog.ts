import { DEPARTMENTS, type EmployeeRoleTemplate } from '@vaep/types';

/**
 * The code-defined catalog of hireable AI-employee role templates surfaced by
 * the onboarding wizard. This is the source of truth (like the Skills catalog);
 * the wizard filters it by the departments the company selected.
 */
export const ONBOARDING_CATALOG: readonly EmployeeRoleTemplate[] = [
  {
    role: 'RECRUITER',
    suggestedName: 'RecruitAI',
    title: 'AI Recruiter',
    description:
      'Sources and screens candidates, schedules interviews, and keeps your pipeline moving.',
    departments: ['RECRUITMENT', 'HR'],
  },
  {
    role: 'SALES',
    suggestedName: 'SalesAI',
    title: 'AI Sales Rep',
    description:
      'Qualifies leads, answers product questions, and follows up to move deals forward.',
    departments: ['SALES'],
  },
  {
    role: 'SUPPORT',
    suggestedName: 'SupportAI',
    title: 'AI Support Agent',
    description:
      'Resolves customer questions grounded in your knowledge base, escalating when needed.',
    departments: ['CUSTOMER_SUPPORT'],
  },
  {
    role: 'HR',
    suggestedName: 'HRAI',
    title: 'AI HR Assistant',
    description:
      'Answers policy questions, helps with onboarding, and supports your team day to day.',
    departments: ['HR'],
  },
  {
    role: 'ACCOUNTANT',
    suggestedName: 'FinanceAI',
    title: 'AI Accountant',
    description:
      'Handles bookkeeping questions, expense checks, and finance-related requests.',
    departments: ['FINANCE'],
  },
  {
    role: 'MARKETING',
    suggestedName: 'MarketingAI',
    title: 'AI Marketing Specialist',
    description:
      'Plans campaigns, drafts on-brand content, and manages social scheduling and publishing.',
    departments: ['MARKETING'],
  },
  {
    role: 'PROJECT_MANAGER',
    suggestedName: 'PMAI',
    title: 'AI Project Manager',
    description:
      'Coordinates tasks, chases status updates, and keeps projects on track.',
    // Genuinely cross-functional, unlike every other role here — was
    // previously mis-tied to CUSTOMER_SUPPORT alone (irrelevant: a project
    // manager isn't a support-department hire), which also hid it from every
    // OTHER department a company might pick. Surfaced regardless of which
    // department(s) are chosen, matching what the role actually does.
    departments: [...DEPARTMENTS],
  },
] as const;
