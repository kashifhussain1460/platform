import { apiClient } from '@/lib/apiClient';
import type { ConnectWhatsAppAccountDto, WhatsAppAccountDto } from '@vaep/types';

/**
 * The dedicated `WhatsAppAccount` connect endpoints (Task 13). NOT the generic
 * `/skills/installed/:id/connect` route — `WhatsAppAccount` is its own
 * top-level table with no FK to `InstalledSkill`, so that generic flow has no
 * path to populate it. See `apps/api/src/modules/engines/whatsapp/whatsapp-accounts.controller.ts`.
 */
export async function getWhatsAppAccount(): Promise<WhatsAppAccountDto | null> {
  const { data } = await apiClient.get<WhatsAppAccountDto | null>(
    '/engines/whatsapp/accounts',
  );
  return data;
}

export async function connectWhatsAppAccount(
  dto: ConnectWhatsAppAccountDto,
): Promise<WhatsAppAccountDto> {
  const { data } = await apiClient.post<WhatsAppAccountDto>(
    '/engines/whatsapp/accounts',
    dto,
  );
  return data;
}
