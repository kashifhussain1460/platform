'use client';

import { zodResolver } from '@hookform/resolvers/zod';
import { useForm } from 'react-hook-form';
import { Building2, Globe, LayoutGrid, Users } from 'lucide-react';
import { IconField } from '@/components/onboarding/fields';
import { useCurrentCompany, useUpdateCompany } from '@/features/tenant/hooks';
import { COMPANY_SIZES, INDUSTRIES } from '../../mockData';
import { useOnboardingWizardStore } from '../../wizardStore';
import { companySchema, type CompanyFormValues } from '../../companySchema';
import { FlowShell } from '../FlowShell';
import { StepFooter } from '../StepFooter';

export function CompanyDetailsStep() {
  const nextStep = useOnboardingWizardStore((s) => s.nextStep);
  const prevStep = useOnboardingWizardStore((s) => s.prevStep);
  const { data: company, isLoading } = useCurrentCompany();
  const updateCompany = useUpdateCompany();

  const {
    register,
    handleSubmit,
    formState: { errors },
  } = useForm<CompanyFormValues>({
    resolver: zodResolver(companySchema),
    values: company
      ? {
          name: company.name,
          industry: company.industry ?? '',
          size: company.size ?? '',
          website: company.website ?? '',
        }
      : undefined,
  });

  const onSubmit = handleSubmit((values) => {
    updateCompany.mutate(values, { onSuccess: () => nextStep() });
  });

  if (isLoading) {
    return (
      <FlowShell heading="Tell us about your company">
        <p className="text-sm text-fg-muted">Loading…</p>
      </FlowShell>
    );
  }

  return (
    <FlowShell heading="Tell us about your company" subtitle="This helps us personalise your AI Employees.">
      <form onSubmit={onSubmit} className="space-y-5">
        <div>
          <IconField id="co-name" label="Company name" icon={<Building2 className="h-[18px] w-[18px]" />}>
            <input
              id="co-name"
              className="field-modern field-with-icon"
              autoFocus
              {...register('name')}
              placeholder="Acme Private Limited"
              aria-invalid={Boolean(errors.name)}
            />
          </IconField>
          {errors.name && <p className="mt-1.5 text-[13px] text-red-400">{errors.name.message}</p>}
        </div>

        <div>
          <IconField id="co-industry" label="Industry" icon={<LayoutGrid className="h-[18px] w-[18px]" />}>
            <select
              id="co-industry"
              className="field-modern field-with-icon"
              {...register('industry')}
              aria-invalid={Boolean(errors.industry)}
            >
              <option value="" disabled>Select an industry</option>
              {INDUSTRIES.map((i) => (
                <option key={i} value={i}>{i}</option>
              ))}
            </select>
          </IconField>
          {errors.industry && <p className="mt-1.5 text-[13px] text-red-400">{errors.industry.message}</p>}
        </div>

        <div>
          <IconField id="co-size" label="Company size" icon={<Users className="h-[18px] w-[18px]" />}>
            <select
              id="co-size"
              className="field-modern field-with-icon"
              {...register('size')}
              aria-invalid={Boolean(errors.size)}
            >
              <option value="" disabled>Select a size</option>
              {COMPANY_SIZES.map((s) => (
                <option key={s} value={s}>{s} employees</option>
              ))}
            </select>
          </IconField>
          {errors.size && <p className="mt-1.5 text-[13px] text-red-400">{errors.size.message}</p>}
        </div>

        <div>
          <IconField id="co-website" label="Website" optional icon={<Globe className="h-[18px] w-[18px]" />}>
            <input
              id="co-website"
              className="field-modern field-with-icon"
              {...register('website')}
              placeholder="https://acme.com"
              aria-invalid={Boolean(errors.website)}
            />
          </IconField>
          {errors.website && <p className="mt-1.5 text-[13px] text-red-400">{errors.website.message}</p>}
        </div>

        <StepFooter onBack={prevStep} onContinue={onSubmit} continueDisabled={updateCompany.isPending} />
      </form>
    </FlowShell>
  );
}
