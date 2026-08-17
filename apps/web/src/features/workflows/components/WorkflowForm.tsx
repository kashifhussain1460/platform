'use client';

import { zodResolver } from '@hookform/resolvers/zod';
import { useForm } from 'react-hook-form';
import { Button } from '@/components/ui/Button';
import { useCreateWorkflow } from '../hooks';
import { createWorkflowSchema, type CreateWorkflowDto } from '../schemas';

/** Create-workflow form: name + optional description (optimistic). */
export function WorkflowForm() {
  const create = useCreateWorkflow();
  const {
    register,
    handleSubmit,
    reset,
    formState: { errors },
  } = useForm<CreateWorkflowDto>({
    resolver: zodResolver(createWorkflowSchema),
    defaultValues: { name: '', description: '' },
  });

  const onSubmit = handleSubmit((values) => {
    create.mutate(
      {
        name: values.name,
        description: values.description?.trim() || undefined,
      },
      { onSuccess: () => reset() },
    );
  });

  return (
    <section className="rounded-2xl border border-app-border bg-app-surface p-5">
      <h2 className="mb-3 text-sm font-medium text-app-ink-2">
        Create a workflow
      </h2>
      <form onSubmit={onSubmit} className="space-y-4" noValidate>
        <div>
          <label htmlFor="name" className="mb-1 block text-sm font-medium text-app-ink-2">
            Name
          </label>
          <input
            id="name"
            className="field-modern"
            placeholder="e.g. Support triage"
            {...register('name')}
          />
          {errors.name && (
            <p className="mt-1 text-sm text-red-600">{errors.name.message}</p>
          )}
        </div>

        <div>
          <label
            htmlFor="description"
            className="mb-1 block text-sm font-medium text-app-ink-2"
          >
            Description <span className="text-app-ink-3">(optional)</span>
          </label>
          <textarea
            id="description"
            rows={2}
            className="field-modern"
            placeholder="What this workflow automates…"
            {...register('description')}
          />
          {errors.description && (
            <p className="mt-1 text-sm text-red-600">
              {errors.description.message}
            </p>
          )}
        </div>

        {create.isError && (
          <p className="text-sm text-red-600">
            {create.error?.message ?? 'Could not create workflow'}
          </p>
        )}

        <Button variant="violet" type="submit" disabled={create.isPending}>
          {create.isPending ? 'Creating…' : 'Create workflow'}
        </Button>
      </form>
    </section>
  );
}
