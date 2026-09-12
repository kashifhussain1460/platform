'use client';

import { OnboardingFlowProvider, useOnboardingFlow } from './state';
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
  const { state } = useOnboardingFlow();

  switch (state.step) {
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
 * The complete 12-screen onboarding experience — UI-first phase (Part 3 of
 * the onboarding standard). All state is local (`OnboardingFlowProvider`);
 * no backend call is made anywhere in this tree. See
 * `docs/.../onboarding-flow-ui-phase-report.md` for what Phase 2 needs to
 * wire this to the real Company/AiEmployee/Skill/Workflow backend.
 */
export function OnboardingFlow() {
  return (
    <OnboardingFlowProvider>
      <OnboardingFlowSwitch />
    </OnboardingFlowProvider>
  );
}
