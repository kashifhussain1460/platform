// Re-export the shared contract so components import from the feature,
// mirroring `features/employees/schemas.ts`. Leads is read-only for now (no
// write DTOs/forms yet), so there is nothing to validate with zod here — just
// the types the API returns.
export type { LeadDetailDto, LeadDto, LeadSource, LeadStatus } from '@vaep/types';
