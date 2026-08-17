'use client';

import { useEmployees } from '../hooks';
import { EmployeeCard } from './EmployeeCard';

/** The roster of AI employees for the tenant. */
export function EmployeeList() {
  const { data: employees, isLoading } = useEmployees();

  if (isLoading) {
    return <p className="text-sm text-app-ink-3">Loading employees…</p>;
  }

  if (!employees || employees.length === 0) {
    return (
      <p className="text-sm text-app-ink-3">
        No employees yet. Hire one above to get started.
      </p>
    );
  }

  return (
    <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-3">
      {employees.map((employee) => (
        <EmployeeCard key={employee.id} employee={employee} />
      ))}
    </div>
  );
}
