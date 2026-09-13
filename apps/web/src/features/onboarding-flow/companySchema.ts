import { z } from 'zod';

export const companySchema = z.object({
  name: z.string().min(2, 'Company name is required.').max(120),
  industry: z.string().min(1, 'Choose an industry.').max(120),
  size: z.string().min(1, 'Choose a company size.').max(40),
  website: z
    .string()
    .max(200)
    .refine((v) => v === '' || /^https?:\/\/.+\..+/.test(v), 'Enter a full URL, e.g. https://acme.com')
    .optional(),
});
export type CompanyFormValues = z.infer<typeof companySchema>;
