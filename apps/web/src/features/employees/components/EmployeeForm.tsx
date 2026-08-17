'use client';

import { zodResolver } from '@hookform/resolvers/zod';
import { useForm } from 'react-hook-form';
import { Button } from '@/components/ui/Button';
import { useCreateEmployee } from '../hooks';
import { formatRole } from '../labels';
import {
  EMPLOYEE_ROLES,
  createEmployeeSchema,
  type CreateEmployeeDto,
} from '../schemas';

/** Create-employee form: name, role select, and an optional persona. */
export function EmployeeForm() {
  const create = useCreateEmployee();
  const {
    register,
    handleSubmit,
    reset,
    formState: { errors },
  } = useForm<CreateEmployeeDto>({
    resolver: zodResolver(createEmployeeSchema),
    defaultValues: { name: '', role: 'SUPPORT', persona: '' },
  });

  const onSubmit = handleSubmit((values) => {
    create.mutate(
      { ...values, persona: values.persona?.trim() || undefined },
      { onSuccess: () => reset() },
    );
  });

  return (
    <section id="hire-employee" className="rounded-2xl border border-app-border bg-app-surface p-5">
      <h2 className="mb-4 text-sm font-medium text-app-ink">Hire an AI employee</h2>
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
              {EMPLOYEE_ROLES.map((r) => (
                <option key={r} value={r}>
                  {formatRole(r)}
                </option>
              ))}
            </select>
            {errors.role && (
              <p className="mt-1 text-sm text-red-600">{errors.role.message}</p>
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

        <Button variant="violet" type="submit" disabled={create.isPending}>
          {create.isPending ? 'Hiring…' : 'Hire employee'}
        </Button>
      </form>
    </section>
  );
}
