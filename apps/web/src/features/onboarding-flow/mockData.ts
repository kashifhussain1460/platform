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
import type {
  EmployeeTemplate,
  EmployeeTemplateKey,
  PlanDef,
  WorkflowTemplateDef,
} from './types';

/**
 * All reference/catalog data on this screen is local and mock, per the
 * UI-first phase — Part 3 of the onboarding standard. Keys deliberately mirror
 * the REAL backend enums/catalog keys (EmployeeRole, the skill catalog's
 * `key`, the real Plan enum) so Phase 2 can map this 1:1 onto real data
 * instead of inventing a second vocabulary.
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

export const PLANS: readonly PlanDef[] = [
  {
    key: 'STARTER',
    displayName: 'Free',
    priceMonthly: 0,
    priceYearly: 0,
    maxRoles: 2,
    maxPerRole: 1,
    blurb: 'Try Orlixa with up to 2 AI Employee roles.',
    features: ['2 AI Employee roles', 'Workflow automation', 'Knowledge base'],
  },
  {
    key: 'PRO',
    displayName: 'Starter',
    priceMonthly: 20,
    priceYearly: 192,
    maxRoles: 2,
    maxPerRole: 1,
    blurb: 'For a small team getting real work done.',
    features: ['2 AI Employee roles', 'Connect your tools', 'Email & chat support'],
  },
  {
    key: 'BUSINESS',
    displayName: 'Growth',
    priceMonthly: 40,
    priceYearly: 384,
    maxRoles: 2,
    maxPerRole: 2,
    blurb: 'Up to 2 of each role — room for your busiest departments.',
    features: ['2 roles × 2 each', 'Priority support', 'Advanced workflows'],
    popular: true,
  },
  {
    key: 'ENTERPRISE',
    displayName: 'Enterprise',
    priceMonthly: null,
    priceYearly: null,
    maxRoles: null,
    maxPerRole: null,
    blurb: 'Unlimited roles and employees, custom onboarding.',
    features: ['Unlimited AI Employees', 'Dedicated support', 'Custom integrations'],
    custom: true,
  },
];

/** Illustrative pricing — not real Stripe prices. See PLAN_CATALOG on the backend for the real numbers. */
export const PLAN_PRICING_NOTE =
  'Prices shown are illustrative for this preview.';

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

export function templateFor(key: EmployeeTemplateKey): EmployeeTemplate {
  return EMPLOYEE_TEMPLATES.find((t) => t.key === key) ?? EMPLOYEE_TEMPLATES[7];
}

export const WORKFLOW_TEMPLATES: Readonly<Record<string, WorkflowTemplateDef>> = {
  'new-lead-follow-up': {
    key: 'new-lead-follow-up',
    name: 'New Lead Follow-up',
    description: 'Reply to a new lead within minutes, every time.',
  },
  'lead-qualification': {
    key: 'lead-qualification',
    name: 'Lead Qualification',
    description: 'Score and route leads by fit and intent.',
  },
  'daily-sales-report': {
    key: 'daily-sales-report',
    name: 'Daily Sales Report',
    description: 'A morning summary of yesterday’s pipeline activity.',
  },
  'ticket-triage': {
    key: 'ticket-triage',
    name: 'Ticket Triage & Response',
    description: 'Categorise and answer common support requests.',
  },
  'daily-support-summary': {
    key: 'daily-support-summary',
    name: 'Daily Support Summary',
    description: 'Open tickets, response times, and escalations.',
  },
  'social-post-scheduler': {
    key: 'social-post-scheduler',
    name: 'Social Post Scheduler',
    description: 'Plan and queue posts across channels.',
  },
  'content-approval': {
    key: 'content-approval',
    name: 'Content Approval Flow',
    description: 'Draft, review and approve before it goes out.',
  },
  'candidate-screening': {
    key: 'candidate-screening',
    name: 'Candidate Screening',
    description: 'Summarise and score new applications.',
  },
  'interview-scheduling': {
    key: 'interview-scheduling',
    name: 'Interview Scheduling',
    description: 'Book interviews from a shared slot pool.',
  },
  'invoice-follow-up': {
    key: 'invoice-follow-up',
    name: 'Invoice Follow-up',
    description: 'Chase overdue invoices automatically.',
  },
  'expense-summary': {
    key: 'expense-summary',
    name: 'Expense Report Summary',
    description: 'Weekly rollup of submitted expenses.',
  },
  'task-assignment': {
    key: 'task-assignment',
    name: 'Task Assignment',
    description: 'Route incoming requests to the right owner.',
  },
  'weekly-ops-report': {
    key: 'weekly-ops-report',
    name: 'Weekly Ops Report',
    description: 'A digest of operational metrics.',
  },
  'sprint-status-report': {
    key: 'sprint-status-report',
    name: 'Sprint Status Report',
    description: 'Where every tracked issue stands.',
  },
  'task-reminders': {
    key: 'task-reminders',
    name: 'Task Reminders',
    description: 'Nudge owners before a deadline slips.',
  },
};

export const KNOWLEDGE_SUGGESTIONS: readonly { name: string; sizeLabel: string }[] = [
  { name: 'Sales Playbook', sizeLabel: '1.2 MB' },
  { name: 'Pricing Guide', sizeLabel: '340 KB' },
  { name: 'Company FAQ', sizeLabel: '210 KB' },
];
