import {
  Headphones,
  Kanban,
  Megaphone,
  Sparkles,
  TrendingUp,
  Users,
  CreditCard,
  UserSearch,
} from 'lucide-react';
import type { EmployeeRole } from '@vaep/types';
import type { EmployeeTemplate } from './types';

/**
 * Static reference data this flow needs but has no backend table for: the
 * `EMPLOYEE_TEMPLATES`/`templateForRole` role-template catalog (name, icon,
 * avatar colors, default persona, suggested skill/workflow keys) plus the
 * `GOALS`/`INDUSTRIES`/`COMPANY_SIZES` picklists. Skills, plans, and
 * workflows are NOT mocked here — those are fetched live from the real
 * catalogs (`useCatalog`, `usePlans`, `useWorkflowTemplates`). Keys here
 * (`EmployeeTemplateKey`) deliberately match the real `EmployeeRole` enum
 * values so `templateForRole` is a direct lookup, not a translation layer.
 */

export const INDUSTRIES: readonly string[] = [
  'Real Estate',
  'SaaS',
  'Ecommerce',
  'Healthcare',
  'Finance',
  'Education',
  'Professional Services',
  'Marketing Agency',
  'Other',
];

export const COMPANY_SIZES: readonly string[] = [
  '1 – 10',
  '11 – 50',
  '51 – 200',
  '201 – 500',
  '500+',
];

export interface GoalDef {
  key: string;
  label: string;
}

export const GOALS: readonly GoalDef[] = [
  { key: 'more_leads', label: 'Get more leads' },
  { key: 'customer_support', label: 'Improve customer support' },
  { key: 'automate_work', label: 'Automate internal work' },
  { key: 'social_media', label: 'Manage social media' },
  { key: 'process_documents', label: 'Process documents' },
  { key: 'hire_manage', label: 'Hire and manage employees' },
  { key: 'improve_sales', label: 'Improve sales' },
  { key: 'financial_ops', label: 'Financial operations' },
  { key: 'other', label: 'Other / Custom' },
];

export const EMPLOYEE_TEMPLATES: readonly EmployeeTemplate[] = [
  {
    key: 'SALES',
    name: 'Sales AI',
    department: 'Sales',
    description: 'Drive revenue & manage leads',
    icon: TrendingUp,
    colorClass: 'bg-emerald-500/15 text-emerald-400',
    avatarFrom: '#34D399',
    avatarTo: '#059669',
    defaultPersona: 'Friendly, persuasive, results-driven',
    suggestedSkillKeys: ['gmail', 'hubspot', 'calendar'],
    suggestedWorkflowKeys: ['new-lead-follow-up', 'lead-qualification', 'daily-sales-report'],
  },
  {
    key: 'SUPPORT',
    name: 'Support AI',
    department: 'Support',
    description: 'Handle customer support',
    icon: Headphones,
    colorClass: 'bg-sky-500/15 text-sky-400',
    avatarFrom: '#38BDF8',
    avatarTo: '#0284C7',
    defaultPersona: 'Patient, empathetic, clear communicator',
    suggestedSkillKeys: ['gmail', 'slack'],
    suggestedWorkflowKeys: ['ticket-triage', 'daily-support-summary'],
  },
  {
    key: 'MARKETING',
    name: 'Marketing AI',
    department: 'Marketing',
    description: 'Create & manage content',
    icon: Megaphone,
    colorClass: 'bg-pink-500/15 text-pink-400',
    avatarFrom: '#F472B6',
    avatarTo: '#DB2777',
    defaultPersona: 'Creative, on-brand, audience-aware',
    suggestedSkillKeys: ['gmail', 'postiz', 'calendar'],
    suggestedWorkflowKeys: ['social-post-scheduler', 'content-approval'],
  },
  {
    key: 'HR',
    name: 'HR AI',
    department: 'HR',
    description: 'Recruit & manage talent',
    icon: Users,
    colorClass: 'bg-violet/15 text-violet',
    avatarFrom: '#8B6EF2',
    avatarTo: '#5E3CE8',
    defaultPersona: 'Warm, professional, discreet',
    suggestedSkillKeys: ['gmail', 'calendar', 'gdrive'],
    suggestedWorkflowKeys: ['candidate-screening', 'interview-scheduling'],
  },
  {
    key: 'ACCOUNTANT',
    name: 'Finance AI',
    department: 'Finance',
    description: 'Invoices, expenses & reporting',
    icon: CreditCard,
    colorClass: 'bg-amber-500/15 text-amber-400',
    avatarFrom: '#FBBF24',
    avatarTo: '#D97706',
    defaultPersona: 'Precise, careful, methodical',
    suggestedSkillKeys: ['stripe', 'gdrive'],
    suggestedWorkflowKeys: ['invoice-follow-up', 'expense-summary'],
  },
  {
    key: 'RECRUITER',
    name: 'Recruiter AI',
    department: 'Recruiting',
    description: 'Source & screen candidates',
    icon: UserSearch,
    colorClass: 'bg-cyan-500/15 text-cyan-400',
    avatarFrom: '#22D3EE',
    avatarTo: '#0891B2',
    defaultPersona: 'Organised, efficient, detail-oriented',
    suggestedSkillKeys: ['gmail', 'calendar', 'scheduling'],
    suggestedWorkflowKeys: ['candidate-screening', 'interview-scheduling'],
  },
  {
    key: 'PROJECT_MANAGER',
    name: 'Project Manager AI',
    department: 'Delivery',
    description: 'Track projects & timelines',
    icon: Kanban,
    colorClass: 'bg-indigo-500/15 text-indigo-400',
    avatarFrom: '#818CF8',
    avatarTo: '#4F46E5',
    defaultPersona: 'Structured, proactive, clear on deadlines',
    suggestedSkillKeys: ['jira', 'slack', 'calendar'],
    suggestedWorkflowKeys: ['sprint-status-report', 'task-reminders'],
  },
  {
    key: 'CUSTOM',
    name: 'Custom AI',
    department: 'Custom',
    description: 'Build your own',
    icon: Sparkles,
    colorClass: 'bg-fuchsia-500/15 text-fuchsia-400',
    avatarFrom: '#E879F9',
    avatarTo: '#A21CAF',
    defaultPersona: '',
    suggestedSkillKeys: [],
    suggestedWorkflowKeys: [],
  },
];

/**
 * Same lookup, keyed by the real backend `EmployeeRole` instead of the mock
 * `EmployeeTemplateKey` — the two share the same 8 string values, so this is
 * a direct match, not a mapping. Lets real `AiEmployeeDto.role` values drive
 * the same template/avatar catalog this mock screen already uses.
 */
export function templateForRole(role: EmployeeRole): EmployeeTemplate {
  return EMPLOYEE_TEMPLATES.find((t) => t.key === role) ?? EMPLOYEE_TEMPLATES[7];
}
