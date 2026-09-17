import { create } from 'zustand';
import { persist, createJSONStorage } from 'zustand/middleware';
import { FLOW_STEPS, type EmployeeTemplateKey, type FieldErrors, type FlowStep } from './types';

interface OnboardingWizardState {
  step: FlowStep;
  /** A MULTISET, not a unique-role list: a role can appear more than once
   * (e.g. `['SALES', 'SALES', 'SUPPORT']` means "hire 2 Sales + 1 Support")
   * so a plan with `maxPerRole > 1` can actually be exercised in one pass —
   * a role previously could only ever be picked once, which made a plan's
   * own advertised "2 per role" capacity unreachable through this screen. */
  selectedTemplateKeys: EmployeeTemplateKey[];
  employeeOrder: string[];
  activeEmployeeId: string | null;
  visitedEmployeeIds: string[];
  errors: FieldErrors;
  goToStep: (step: FlowStep) => void;
  nextStep: () => void;
  prevStep: () => void;
  /** `null` clears the active employee — used by ConfigureEmployeesStep to
   * re-trigger its create-on-demand effect for the next not-yet-created role. */
  setActiveEmployee: (id: string | null) => void;
  /** Adds one more of this role to the selection (a plan's `maxPerRole` /
   * `maxRoles` caps are enforced by the caller before invoking this). */
  incrementRole: (key: EmployeeTemplateKey) => void;
  /** Removes one occurrence of this role from the selection (no-op if none selected). */
  decrementRole: (key: EmployeeTemplateKey) => void;
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
      incrementRole: (key) => set((s) => ({ selectedTemplateKeys: [...s.selectedTemplateKeys, key] })),
      decrementRole: (key) =>
        set((s) => {
          const idx = s.selectedTemplateKeys.indexOf(key);
          if (idx === -1) return s;
          const next = [...s.selectedTemplateKeys];
          next.splice(idx, 1);
          return { selectedTemplateKeys: next };
        }),
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
