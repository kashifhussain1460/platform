import { apiClient } from '@/lib/apiClient';
import type { DashboardCompositionDto, ProductContextDto } from '@vaep/types';

/**
 * The single resolved answer to "what is relevant and available for this
 * company, department, user and hired AI Employees?".
 *
 * One request replaces business logic that was previously re-derived on each
 * page — three separate copies of the plan rule, four static navigation arrays,
 * and no consideration of industry, goals or departments anywhere at all.
 */
export async function getProductContext(): Promise<ProductContextDto> {
  const { data } = await apiClient.get<ProductContextDto>('/product-context');
  return data;
}

/**
 * The dashboard, composed from the same resolved capabilities as the
 * navigation. Separate request because it runs domain aggregates the shell
 * does not need on every page.
 */
export async function getDashboardComposition(): Promise<DashboardCompositionDto> {
  const { data } = await apiClient.get<DashboardCompositionDto>(
    '/product-context/dashboard',
  );
  return data;
}
