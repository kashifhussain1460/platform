import { z } from 'zod';

/** The Configure Hub's mini-form — name/persona/language only. The richer
 * `employeeConfigSchema` in `@vaep/types` (department, working hours, budget,
 * permissions, etc.) belongs to the full employee-settings panel, not this
 * onboarding step. */
export const employeeConfigSchema = z.object({
  name: z.string().min(1, 'Give this employee a name.').max(120),
  persona: z.string().max(2000).optional(),
  language: z.string().min(1),
});
export type EmployeeConfigFormValues = z.infer<typeof employeeConfigSchema>;
