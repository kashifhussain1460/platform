'use client';

import { useOnboardingWizardStore } from './wizardStore';
import { CompanyDetailsStep } from './components/steps/CompanyDetailsStep';
import { ConfigureEmployeesStep } from './components/steps/ConfigureEmployeesStep';
import { ConnectionsStep } from './components/steps/ConnectionsStep';
import { GoalsStep } from './components/steps/GoalsStep';
import { KnowledgeStep } from './components/steps/KnowledgeStep';
import { PlanStep } from './components/steps/PlanStep';
import { ReviewStep } from './components/steps/ReviewStep';
import { SelectEmployeesStep } from './components/steps/SelectEmployeesStep';
import { SkillsStep } from './components/steps/SkillsStep';
import { SuccessStep } from './components/steps/SuccessStep';
import { WelcomeStep } from './components/steps/WelcomeStep';
import { WorkflowsStep } from './components/steps/WorkflowsStep';

function OnboardingFlowSwitch() {
  const step = useOnboardingWizardStore((s) => s.step);

  switch (step) {
    case 'welcome':
      return <WelcomeStep />;
    case 'company':
      return <CompanyDetailsStep />;
    case 'goals':
      return <GoalsStep />;
    case 'plan':
      return <PlanStep />;
    case 'selectEmployees':
      return <SelectEmployeesStep />;
    case 'configureEmployees':
      return <ConfigureEmployeesStep />;
    case 'skills':
      return <SkillsStep />;
    case 'connections':
      return <ConnectionsStep />;
    case 'knowledge':
      return <KnowledgeStep />;
    case 'workflows':
      return <WorkflowsStep />;
    case 'review':
      return <ReviewStep />;
    case 'success':
      return <SuccessStep />;
    default:
      return null;
  }
}

/**
 * The complete 12-screen onboarding experience. Every step is wired to the
 * real backend (Company/AiEmployee/Skill/Workflow/Billing/Readiness) via the
 * hooks each step file imports; only wizard navigation/position state
 * (`useOnboardingWizardStore`) is local.
 */
export function OnboardingFlow() {
  return <OnboardingFlowSwitch />;
}
