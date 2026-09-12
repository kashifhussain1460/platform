import type { ElementType } from 'react';
import type { EmployeeRole } from '@vaep/types';

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

// --- Skills ------------------------------------------------------------------

export type SkillCategory =
  | 'Communication'
  | 'CRM & Sales'
  | 'Productivity'
  | 'Marketing'
  | 'Data & Analytics'
  | 'Finance'
  | 'Custom / Other';

export interface SkillDef {
  key: string;
  name: string;
  category: SkillCategory;
  description: string;
  icon: ElementType<{ className?: string }>;
  /** Does using this skill for real need a connected account? Almost all do. */
  requiresConnection: boolean;
}

export type ConnectionState = 'connected' | 'not_connected' | 'connecting' | 'error';

// --- Knowledge -----------------------------------------------------------------

export interface KnowledgeDoc {
  id: string;
  name: string;
  sizeLabel: string;
  /** `null` = shared company-wide; otherwise every employee of this ROLE
   * sees it (not one specific hire) — matches the real backend's
   * `KnowledgeDocument.category` semantics exactly. */
  scope: EmployeeRole | null;
  source: 'upload' | 'suggested' | 'text';
}

// --- Workflows -------------------------------------------------------------

export interface WorkflowTemplateDef {
  key: string;
  name: string;
  description: string;
}

// --- Plans -------------------------------------------------------------------

/** Backend plan keys, kept identical to the real `Plan` enum for Phase 2. */
export type PlanKey = 'STARTER' | 'PRO' | 'BUSINESS' | 'ENTERPRISE';

export interface PlanDef {
  key: PlanKey;
  displayName: string;
  priceMonthly: number | null;
  priceYearly: number | null;
  maxRoles: number | null;
  maxPerRole: number | null;
  blurb: string;
  features: string[];
  popular?: boolean;
  custom?: boolean;
}

// --- Draft employee (the per-employee configuration the wizard builds) -----

export interface DraftEmployee {
  id: string;
  templateKey: EmployeeTemplateKey;
  name: string;
  role: string;
  persona: string;
  language: string;
  skillKeys: string[];
  connections: Record<string, ConnectionState>;
  workflowKeys: string[];
  /** Set once this employee's turn through Configure→Skills→Connections→
   * Knowledge→Workflows is done and the Hub has moved on to the next one. */
  setupComplete: boolean;
}

export type ReadinessSeverity = 'BLOCKER' | 'WARNING';

export interface ReadinessIssue {
  code: string;
  severity: ReadinessSeverity;
  message: string;
}

export interface ReadinessCheck {
  key: 'BASIC' | 'SKILLS' | 'CONNECTIONS' | 'KNOWLEDGE' | 'WORKFLOWS';
  label: string;
  status: 'PASS' | 'FAIL' | 'WARN';
}

export interface EmployeeReadiness {
  ready: boolean;
  checks: ReadinessCheck[];
  issues: ReadinessIssue[];
}

// --- Validation -------------------------------------------------------------

export interface FieldErrors {
  [field: string]: string | undefined;
}

// --- Root state --------------------------------------------------------------

export interface CompanyDraft {
  name: string;
  industry: string;
  size: string;
  website: string;
}

export interface OnboardingFlowState {
  step: FlowStep;
  company: CompanyDraft;
  goals: string[];
  billingCycle: 'monthly' | 'yearly';
  planKey: PlanKey;
  selectedTemplateKeys: EmployeeTemplateKey[];
  employees: DraftEmployee[];
  activeEmployeeId: string | null;
  knowledgeDocs: KnowledgeDoc[];
  activatedEmployeeIds: string[];
  errors: FieldErrors;
}
