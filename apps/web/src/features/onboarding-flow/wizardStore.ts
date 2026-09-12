import { create } from 'zustand';
import { persist, createJSONStorage } from 'zustand/middleware';
import { FLOW_STEPS, type EmployeeTemplateKey, type FieldErrors, type FlowStep } from './types';

interface OnboardingWizardState {
  step: FlowStep;
  selectedTemplateKeys: EmployeeTemplateKey[];
  employeeOrder: string[];
  activeEmployeeId: string | null;
  visitedEmployeeIds: string[];
  errors: FieldErrors;
  goToStep: (step: FlowStep) => void;
  nextStep: () => void;
  prevStep: () => void;
  setActiveEmployee: (id: string) => void;
  toggleTemplateKey: (key: EmployeeTemplateKey) => void;
  pushEmployeeId: (id: string) => void;
  markVisited: (id: string) => void;
  setErrors: (errors: FieldErrors) => void;
  clearError: (field: string) => void;
  reset: () => void;
}

const initial = {
  step: 'welcome' as FlowStep,
  selectedTemplateKeys: [] as EmployeeTemplateKey[],
  employeeOrder: [] as string[],
  activeEmployeeId: null as string | null,
  visitedEmployeeIds: [] as string[],
  errors: {} as FieldErrors,
};

export const useOnboardingWizardStore = create<OnboardingWizardState>()(
  persist(
    (set, get) => ({
      ...initial,
      goToStep: (step) => set({ step, errors: {} }),
      nextStep: () => {
        const idx = FLOW_STEPS.indexOf(get().step);
        set({ step: FLOW_STEPS[Math.min(idx + 1, FLOW_STEPS.length - 1)], errors: {} });
      },
      prevStep: () => {
        const idx = FLOW_STEPS.indexOf(get().step);
        set({ step: FLOW_STEPS[Math.max(idx - 1, 0)], errors: {} });
      },
      setActiveEmployee: (id) => set({ activeEmployeeId: id }),
      toggleTemplateKey: (key) =>
        set((s) => ({
          selectedTemplateKeys: s.selectedTemplateKeys.includes(key)
            ? s.selectedTemplateKeys.filter((k) => k !== key)
            : [...s.selectedTemplateKeys, key],
        })),
      pushEmployeeId: (id) =>
        set((s) => (s.employeeOrder.includes(id) ? s : { employeeOrder: [...s.employeeOrder, id] })),
      markVisited: (id) =>
        set((s) => (s.visitedEmployeeIds.includes(id) ? s : { visitedEmployeeIds: [...s.visitedEmployeeIds, id] })),
      setErrors: (errors) => set({ errors }),
      clearError: (field) =>
        set((s) => {
          if (!(field in s.errors)) return s;
          const errors = { ...s.errors };
          delete errors[field];
          return { errors };
        }),
      reset: () => set(initial),
    }),
    { name: 'onboarding-wizard', storage: createJSONStorage(() => sessionStorage) },
  ),
);
