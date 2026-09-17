import type { AiEmployeeDto } from '@vaep/types';
import { useEmployees } from '@/features/employees/hooks';
import { useOnboardingWizardStore } from './wizardStore';

/**
 * Shared resolver for "the AI Employee currently being configured" — the same
 * `employeeOrder` + `useEmployees()` + `activeEmployeeId` join Task 9 built
 * inline in `ConfigureEmployeesStep`, extracted so the per-employee sub-steps
 * (Skills, Connections, Knowledge, Workflows) don't each reimplement it.
 *
 * Filters through `employeeOrder` (not a raw `employees.find`) deliberately:
 * `employees` can include rows this onboarding session never touched (e.g. a
 * pre-existing tenant employee for a role that isn't even selected in this
 * pass), and only ids this flow has pushed should ever be addressable as
 * "active" here. `ConfigureEmployeesStep`'s reconciliation effect is what
 * pushes a pre-existing employee's id in when its role IS currently
 * selected — this hook itself stays a dumb `employeeOrder` join.
 */
export function useActiveEmployee() {
  const employeeOrder = useOnboardingWizardStore((s) => s.employeeOrder);
  const activeEmployeeId = useOnboardingWizardStore((s) => s.activeEmployeeId);
  const employeesQuery = useEmployees();
  const employees = employeesQuery.data ?? [];

  const roster = employeeOrder
    .map((id) => employees.find((e) => e.id === id))
    .filter((e): e is AiEmployeeDto => Boolean(e));
  const employee = roster.find((e) => e.id === activeEmployeeId) ?? null;

  return {
    employee,
    /** True until the employees list has loaded at least once (cold cache). */
    isLoading: !employeesQuery.isSuccess && !employeesQuery.isError,
    isError: employeesQuery.isError,
    error: employeesQuery.error,
    refetch: employeesQuery.refetch,
  };
}
