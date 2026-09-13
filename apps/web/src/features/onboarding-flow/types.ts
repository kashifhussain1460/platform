import type { ElementType } from 'react';

/**
 * The 12 screens, in navigation order. `welcome` carries no progress dot (a
 * pre-step splash) and `selectEmployees`/`configureEmployees` share ONE
 * progress milestone ("AI Employees") — see `PROGRESS_STEPS` below. Kept as
 * two distinct entries here because Back/Continue must move between them
 * independently.
 */
export type FlowStep =
  | 'welcome'
  | 'company'
  | 'goals'
  | 'plan'
  | 'selectEmployees'
  | 'configureEmployees'
  | 'skills'
  | 'connections'
  | 'knowledge'
  | 'workflows'
  | 'review'
  | 'success';

export const FLOW_STEPS: readonly FlowStep[] = [
  'welcome',
  'company',
  'goals',
  'plan',
  'selectEmployees',
  'configureEmployees',
  'skills',
  'connections',
  'knowledge',
  'workflows',
  'review',
  'success',
];

/** Short label for each real step, in order — what the top tracker (12 items,
 * one per `FLOW_STEPS` entry) shows. Kept 1:1 with `FLOW_STEPS` rather than
 * grouped into milestones, so the tracker never claims progress on a screen
 * that doesn't exist. */
export const STEP_LABELS: Record<FlowStep, string> = {
  welcome: 'Welcome',
  company: 'Company',
  goals: 'Goals',
  plan: 'Plan',
  selectEmployees: 'Employees',
  configureEmployees: 'Configure',
  skills: 'Skills',
  connections: 'Connections',
  knowledge: 'Knowledge',
  workflows: 'Workflows',
  review: 'Review',
  success: 'Complete',
};

// --- AI Employee catalog (mock reference data, mirrors the real EmployeeRole
// enum + role catalog so Phase 2 wiring maps 1:1 — see mockData.ts) ----------

export type EmployeeTemplateKey =
  | 'SALES'
  | 'SUPPORT'
  | 'MARKETING'
  | 'HR'
  | 'ACCOUNTANT'
  | 'RECRUITER'
  | 'PROJECT_MANAGER'
  | 'CUSTOM';

export interface EmployeeTemplate {
  key: EmployeeTemplateKey;
  name: string;
  department: string;
  description: string;
  icon: ElementType<{ className?: string }>;
  colorClass: string;
  /** Gradient stops for the circular `EmployeeAvatar`. */
  avatarFrom: string;
  avatarTo: string;
  defaultPersona: string;
  suggestedSkillKeys: string[];
  suggestedWorkflowKeys: string[];
}

// --- Validation -------------------------------------------------------------

export interface FieldErrors {
  [field: string]: string | undefined;
}
