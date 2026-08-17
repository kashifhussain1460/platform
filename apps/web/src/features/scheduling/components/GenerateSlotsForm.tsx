'use client';

import { zodResolver } from '@hookform/resolvers/zod';
import { useForm } from 'react-hook-form';
import { Button } from '@/components/ui/Button';
import { useGenerateSlots } from '../hooks';
import { generateSlotsSchema, type GenerateSlotsDto } from '../schemas';

const DAYS = [
  { value: 0, label: 'Sun' },
  { value: 1, label: 'Mon' },
  { value: 2, label: 'Tue' },
  { value: 3, label: 'Wed' },
  { value: 4, label: 'Thu' },
  { value: 5, label: 'Fri' },
  { value: 6, label: 'Sat' },
];

const labelClass = 'mb-1.5 block text-sm font-medium text-app-ink-2';

/** Generate a recurring weekly OPEN-slot pattern over a date range. */
export function GenerateSlotsForm() {
  const generate = useGenerateSlots();
  const {
    register,
    handleSubmit,
    watch,
    setValue,
    reset,
    formState: { errors },
  } = useForm<GenerateSlotsDto>({
    resolver: zodResolver(generateSlotsSchema),
    defaultValues: {
      startDate: '',
      endDate: '',
      daysOfWeek: [1, 2, 3, 4, 5],
      dailyStartHour: 10,
      dailyEndHour: 17,
      slotMinutes: 30,
    },
  });

  const daysOfWeek = watch('daysOfWeek');

  const toggleDay = (day: number) => {
    const next = daysOfWeek.includes(day)
      ? daysOfWeek.filter((d) => d !== day)
      : [...daysOfWeek, day].sort();
    setValue('daysOfWeek', next, { shouldValidate: true });
  };

  const onSubmit = handleSubmit((values) => {
    generate.mutate(values, {
      onSuccess: () => reset(values),
    });
  });

  return (
    <section className="rounded-2xl border border-app-border bg-app-surface p-5">
      <h2 className="mb-3 text-sm font-medium text-app-ink-2">
        Generate a recurring pattern
      </h2>
      <form onSubmit={onSubmit} className="space-y-4" noValidate>
        <div className="grid grid-cols-2 gap-3">
          <div>
            <label htmlFor="startDate" className={labelClass}>
              Start date
            </label>
            <input
              id="startDate"
              type="date"
              className="field-modern"
              {...register('startDate')}
            />
            {errors.startDate && (
              <p className="mt-1.5 text-sm text-red-600">{errors.startDate.message}</p>
            )}
          </div>
          <div>
            <label htmlFor="endDate" className={labelClass}>
              End date
            </label>
            <input
              id="endDate"
              type="date"
              className="field-modern"
              {...register('endDate')}
            />
            {errors.endDate && (
              <p className="mt-1.5 text-sm text-red-600">{errors.endDate.message}</p>
            )}
          </div>
        </div>

        <div>
          <p className={labelClass}>Days of week</p>
          <div className="flex gap-1.5">
            {DAYS.map((d) => (
              <button
                key={d.value}
                type="button"
                onClick={() => toggleDay(d.value)}
                className={`rounded-lg px-2.5 py-1.5 text-xs font-medium transition-colors ${
                  daysOfWeek.includes(d.value)
                    ? 'bg-violet text-white'
                    : 'bg-app-raised text-app-ink-2 hover:bg-app-raised hover:text-app-ink'
                }`}
              >
                {d.label}
              </button>
            ))}
          </div>
          {errors.daysOfWeek && (
            <p className="mt-1.5 text-sm text-red-600">{errors.daysOfWeek.message}</p>
          )}
        </div>

        <div className="grid grid-cols-3 gap-3">
          <div>
            <label htmlFor="dailyStartHour" className={labelClass}>
              Start hour
            </label>
            <input
              id="dailyStartHour"
              type="number"
              min={0}
              max={23}
              className="field-modern"
              {...register('dailyStartHour', { valueAsNumber: true })}
            />
          </div>
          <div>
            <label htmlFor="dailyEndHour" className={labelClass}>
              End hour
            </label>
            <input
              id="dailyEndHour"
              type="number"
              min={0}
              max={23}
              className="field-modern"
              {...register('dailyEndHour', { valueAsNumber: true })}
            />
          </div>
          <div>
            <label htmlFor="slotMinutes" className={labelClass}>
              Slot length (min)
            </label>
            <input
              id="slotMinutes"
              type="number"
              min={5}
              max={480}
              className="field-modern"
              {...register('slotMinutes', { valueAsNumber: true })}
            />
          </div>
        </div>
        {(errors.dailyStartHour || errors.dailyEndHour || errors.slotMinutes) && (
          <p className="text-sm text-red-600">Check the hour/length values.</p>
        )}

        {generate.isError && (
          <p className="text-sm text-red-600">
            {generate.error?.message ?? 'Could not generate slots'}
          </p>
        )}
        {generate.isSuccess && (
          <p className="text-sm text-green-700">
            Created {generate.data.created} open slot(s).
          </p>
        )}

        <Button type="submit" variant="violet" disabled={generate.isPending}>
          {generate.isPending ? 'Generating…' : 'Generate slots'}
        </Button>
      </form>
    </section>
  );
}
