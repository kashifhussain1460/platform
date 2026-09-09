'use client';

import { zodResolver } from '@hookform/resolvers/zod';
import { useForm } from 'react-hook-form';
import { Button } from '@/components/ui/Button';
import Link from 'next/link';
import { useSeatAvailability } from '@/features/product-context/hooks';
import { useCreateEmployee } from '../hooks';
import { formatRole } from '../labels';
import {
  EMPLOYEE_ROLES,
  createEmployeeSchema,
  type CreateEmployeeDto,
} from '../schemas';

/**
 * Create-employee form: name, role select, and an optional persona.
 *
 * Role-based hiring (2026-09-04): the role list is greyed from the SAME seat
 * rule the server enforces (`useSeatAvailability` reads the resolver's
 * entitlements; `EmployeesService.create` applies `checkSeatFor`). A customer
 * sees "1 of 1 on your plan" beside Marketing before they type a name, instead
 * of a 403 after. The server remains the control; this is the courtesy.
 */
export function EmployeeForm() {
  const create = useCreateEmployee();
  const { seats, reasonBlocked, creditsPerEmployeePerMonth } = useSeatAvailability();
  const {
    register,
    handleSubmit,
    reset,
    watch,
    formState: { errors },
  } = useForm<CreateEmployeeDto>({
    resolver: zodResolver(createEmployeeSchema),
    defaultValues: { name: '', role: 'SUPPORT', persona: '' },
  });
  const selectedRole = watch('role');
  const blockedReason = reasonBlocked(selectedRole);
  const allSeatsTaken = seats !== null && seats.max !== null && seats.used >= seats.max;

  const onSubmit = handleSubmit((values) => {
    create.mutate(
      { ...values, persona: values.persona?.trim() || undefined },
      { onSuccess: () => reset() },
    );
  });

  return (
    <section id="hire-employee" className="rounded-2xl border border-app-border bg-app-surface p-5">
      <div className="mb-4 flex flex-wrap items-baseline justify-between gap-2">
        <h2 className="text-sm font-medium text-app-ink">Hire an AI employee</h2>
        {seats && seats.max !== null && (
          <p className="text-xs text-app-ink-3">
            {seats.used} of {seats.max} seats
            {seats.maxRoles !== null && ` · ${seats.rolesUsed} of ${seats.maxRoles} roles`}
            {creditsPerEmployeePerMonth !== null &&
              ` · ${creditsPerEmployeePerMonth.toLocaleString()} credits / employee / month`}
          </p>
        )}
      </div>
      {allSeatsTaken && (
        <p className="mb-4 rounded-xl bg-status-warning/10 px-4 py-3 text-sm text-sl-warning">
          All {seats.max} seats on your plan are taken. Retire an employee to free one, or{' '}
          <Link href="/billing#plans" className="font-semibold underline underline-offset-2">
            upgrade your plan
          </Link>
          .
        </p>
      )}
      <form onSubmit={onSubmit} className="space-y-4" noValidate>
        <div className="grid gap-4 sm:grid-cols-2">
          <div>
            <label htmlFor="name" className="mb-1.5 block text-sm font-medium text-app-ink-2">
              Name
            </label>
            <input id="name" className="field-modern" placeholder="e.g. Ada" {...register('name')} />
            {errors.name && (
              <p className="mt-1 text-sm text-red-600">{errors.name.message}</p>
            )}
          </div>

          <div>
            <label htmlFor="role" className="mb-1.5 block text-sm font-medium text-app-ink-2">
              Role
            </label>
            <select id="role" className="field-modern" {...register('role')}>
              {EMPLOYEE_ROLES.map((r) => {
                const inRole = seats?.perRole.find((p) => p.role === r);
                const blocked = reasonBlocked(r) !== null;
                const perRoleMax = seats?.maxPerRole ?? null;
                return (
                  <option key={r} value={r} disabled={blocked}>
                    {formatRole(r)}
                    {inRole && perRoleMax !== null ? ` (${inRole.used} of ${perRoleMax})` : ''}
                    {blocked ? ' — not on your plan' : ''}
                  </option>
                );
              })}
            </select>
            {errors.role && (
              <p className="mt-1 text-sm text-red-600">{errors.role.message}</p>
            )}
            {blockedReason && !allSeatsTaken && (
              <p className="mt-1 text-xs text-sl-warning">
                {blockedReason}{' '}
                <Link href="/billing#plans" className="font-semibold underline underline-offset-2">
                  Upgrade
                </Link>
              </p>
            )}
          </div>
        </div>

        <div>
          <label htmlFor="persona" className="mb-1.5 block text-sm font-medium text-app-ink-2">
            Persona <span className="text-app-ink-3">(optional)</span>
          </label>
          <textarea
            id="persona"
            rows={2}
            className="field-modern"
            placeholder="Tone, guardrails, and how this employee should behave…"
            {...register('persona')}
          />
          {errors.persona && (
            <p className="mt-1 text-sm text-red-600">{errors.persona.message}</p>
          )}
        </div>

        {create.isError && (
          <p className="text-sm text-red-600">
            {create.error?.message ?? 'Could not create employee'}
          </p>
        )}

        <Button
          variant="violet"
          type="submit"
          disabled={create.isPending || blockedReason !== null}
        >
          {create.isPending ? 'Hiring…' : 'Hire employee'}
        </Button>
      </form>
    </section>
  );
}
