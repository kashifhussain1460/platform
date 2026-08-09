import type { Department } from '@vaep/types';

// Department words short enough to be an acronym read wrong under plain
// Title Case — "HR" became "Hr" (caught by browser-testing the onboarding
// wizard). Kept upper on purpose; every other department word Title-Cases fine.
const ACRONYMS = new Set(['HR']);

/** SALES → "Sales", CUSTOMER_SUPPORT → "Customer Support", HR → "HR". */
export function formatDepartment(dept: Department | string): string {
  return dept
    .split('_')
    .map((w) => (ACRONYMS.has(w) ? w : w.charAt(0) + w.slice(1).toLowerCase()))
    .join(' ');
}

/** Company size options for the register + business-profile forms. */
export const COMPANY_SIZES: readonly string[] = [
  '1-10',
  '11-50',
  '51-200',
  '201-500',
  '501-1000',
  '1001-5000',
  '5000+',
] as const;

/** Canonical industry list for onboarding step 1 (single source, no per-page copies). */
export const INDUSTRIES: readonly string[] = [
  'Technology',
  'Healthcare',
  'Finance',
  'Retail / Ecommerce',
  'Education',
  'Professional Services',
  'Real Estate',
  'Manufacturing',
  'Hospitality',
  'Other',
] as const;
