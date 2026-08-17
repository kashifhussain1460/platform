'use client';

import { zodResolver } from '@hookform/resolvers/zod';
import { useForm } from 'react-hook-form';
import { Button } from '@/components/ui/Button';
import { useCreateUser, useCurrentRole } from '../hooks';
import { ROLE_LABEL } from '../labels';
import { createUserSchema, type CreateUserDto, type Role } from '../schemas';

// An ADMIN may only create MEMBER/ADMIN; only an OWNER may create an OWNER.
const ADMIN_ASSIGNABLE: Role[] = ['MEMBER', 'ADMIN'];
const OWNER_ASSIGNABLE: Role[] = ['MEMBER', 'ADMIN', 'OWNER'];

const labelClass = 'mb-1.5 block text-sm font-medium text-app-ink-2';

/** Invite/add-user form: email, name, role select, and a temporary password. */
export function UserForm() {
  const create = useCreateUser();
  const callerRole = useCurrentRole();
  const roleOptions = callerRole === 'OWNER' ? OWNER_ASSIGNABLE : ADMIN_ASSIGNABLE;

  const {
    register,
    handleSubmit,
    reset,
    formState: { errors },
  } = useForm<CreateUserDto>({
    resolver: zodResolver(createUserSchema),
    defaultValues: { name: '', email: '', role: 'MEMBER', password: '' },
  });

  const onSubmit = handleSubmit((values) => {
    create.mutate(values, { onSuccess: () => reset() });
  });

  return (
    <section className="rounded-2xl border border-app-border bg-app-surface p-5">
      <h2 className="mb-3 text-sm font-medium text-app-ink-2">Invite a team member</h2>
      <form onSubmit={onSubmit} className="space-y-4" noValidate>
        <div className="grid gap-4 sm:grid-cols-2">
          <div>
            <label htmlFor="name" className={labelClass}>
              Name
            </label>
            <input
              id="name"
              className="field-modern"
              placeholder="e.g. Grace Hopper"
              {...register('name')}
            />
            {errors.name && (
              <p className="mt-1.5 text-sm text-red-600">{errors.name.message}</p>
            )}
          </div>

          <div>
            <label htmlFor="email" className={labelClass}>
              Email
            </label>
            <input
              id="email"
              type="email"
              className="field-modern"
              placeholder="teammate@company.com"
              {...register('email')}
            />
            {errors.email && (
              <p className="mt-1.5 text-sm text-red-600">{errors.email.message}</p>
            )}
          </div>

          <div>
            <label htmlFor="role" className={labelClass}>
              Role
            </label>
            <select id="role" className="field-modern" {...register('role')}>
              {roleOptions.map((r) => (
                <option key={r} value={r}>
                  {ROLE_LABEL[r]}
                </option>
              ))}
            </select>
            {errors.role && (
              <p className="mt-1.5 text-sm text-red-600">{errors.role.message}</p>
            )}
          </div>

          <div>
            <label htmlFor="password" className={labelClass}>
              Temporary password
            </label>
            <input
              id="password"
              type="password"
              className="field-modern"
              placeholder="At least 8 characters"
              {...register('password')}
            />
            {errors.password && (
              <p className="mt-1.5 text-sm text-red-600">{errors.password.message}</p>
            )}
          </div>
        </div>

        {create.isError && (
          <p className="text-sm text-red-600">
            {create.error?.message ?? 'Could not add user'}
          </p>
        )}

        <Button type="submit" variant="violet" disabled={create.isPending}>
          {create.isPending ? 'Inviting…' : '+ Invite Member'}
        </Button>
      </form>
    </section>
  );
}
