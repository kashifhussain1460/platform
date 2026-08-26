import { apiClient } from '@/lib/apiClient';
import type {
  AiEmployeeDto,
  InstallEmployeeDto,
  MarketplaceCatalogDto,
} from '@vaep/types';

/** The marketplace catalog: hireable AI Employee templates + the skills catalog. */
export async function getMarketplace(): Promise<MarketplaceCatalogDto> {
  const { data } = await apiClient.get<MarketplaceCatalogDto>('/marketplace');
  return data;
}

/** Hire an AI employee from a template (optional name override). */
export async function installEmployeeTemplate(vars: {
  key: string;
  data: InstallEmployeeDto;
}): Promise<AiEmployeeDto> {
  const { data } = await apiClient.post<AiEmployeeDto>(
    `/marketplace/employees/${vars.key}/install`,
    vars.data,
  );
  return data;
}

/** Install a workflow template as a new workflow. */
