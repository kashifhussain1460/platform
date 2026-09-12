'use client';

import type { ChangeEvent } from 'react';
import { Building2, Globe, LayoutGrid, Users } from 'lucide-react';
import { IconField } from '@/components/onboarding/fields';
import { COMPANY_SIZES, INDUSTRIES } from '../../mockData';
import { useOnboardingFlow } from '../../state';
import { FlowShell } from '../FlowShell';
import { StepFooter } from '../StepFooter';

export function CompanyDetailsStep() {
  const { state, dispatch, nextStep, prevStep, setErrors } = useOnboardingFlow();
  const { company, errors } = state;

  const setField = (field: keyof typeof company) => (
    e: ChangeEvent<HTMLInputElement | HTMLSelectElement>,
  ) => {
    dispatch({ type: 'SET_COMPANY_FIELD', field, value: e.target.value });
    dispatch({ type: 'CLEAR_ERROR', field });
  };

  const onContinue = () => {
    const next: Record<string, string> = {};
    if (!company.name.trim()) next.name = 'Company name is required.';
    if (!company.industry) next.industry = 'Choose an industry.';
    if (!company.size) next.size = 'Choose a company size.';
    if (company.website.trim() && !/^https?:\/\/.+\..+/.test(company.website.trim())) {
      next.website = 'Enter a full URL, e.g. https://acme.com';
    }
    if (Object.keys(next).length > 0) {
      setErrors(next);
      return;
    }
    nextStep();
  };

  return (
    <FlowShell heading="Tell us about your company" subtitle="This helps us personalise your AI Employees.">
      <div className="space-y-5">
        <div>
          <IconField id="co-name" label="Company name" icon={<Building2 className="h-[18px] w-[18px]" />}>
            <input
              id="co-name"
              className="field-modern field-with-icon"
              autoFocus
              value={company.name}
              onChange={setField('name')}
              placeholder="Acme Private Limited"
              aria-invalid={Boolean(errors.name)}
            />
          </IconField>
          {errors.name && <p className="mt-1.5 text-[13px] text-red-400">{errors.name}</p>}
        </div>

        <div>
          <IconField id="co-industry" label="Industry" icon={<LayoutGrid className="h-[18px] w-[18px]" />}>
            <select
              id="co-industry"
              className="field-modern field-with-icon"
              value={company.industry}
              onChange={setField('industry')}
              aria-invalid={Boolean(errors.industry)}
            >
              <option value="" disabled>Select an industry</option>
              {INDUSTRIES.map((i) => (
                <option key={i} value={i}>{i}</option>
              ))}
            </select>
          </IconField>
          {errors.industry && <p className="mt-1.5 text-[13px] text-red-400">{errors.industry}</p>}
        </div>

        <div>
          <IconField id="co-size" label="Company size" icon={<Users className="h-[18px] w-[18px]" />}>
            <select
              id="co-size"
              className="field-modern field-with-icon"
              value={company.size}
              onChange={setField('size')}
              aria-invalid={Boolean(errors.size)}
            >
              <option value="" disabled>Select a size</option>
              {COMPANY_SIZES.map((s) => (
                <option key={s} value={s}>{s} employees</option>
              ))}
            </select>
          </IconField>
          {errors.size && <p className="mt-1.5 text-[13px] text-red-400">{errors.size}</p>}
        </div>

        <div>
          <IconField id="co-website" label="Website" optional icon={<Globe className="h-[18px] w-[18px]" />}>
            <input
              id="co-website"
              className="field-modern field-with-icon"
              value={company.website}
              onChange={setField('website')}
              placeholder="https://acme.com"
              aria-invalid={Boolean(errors.website)}
            />
          </IconField>
          {errors.website && <p className="mt-1.5 text-[13px] text-red-400">{errors.website}</p>}
        </div>
      </div>

      <StepFooter onBack={prevStep} onContinue={onContinue} />
    </FlowShell>
  );
}
