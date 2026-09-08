import { NotFoundException } from '@nestjs/common';
import { WhatsappAccountsService } from './whatsapp-accounts.service';

/**
 * This is the route that actually bridges `InstalledSkill` (Task 9's catalog
 * entry) to `WhatsAppAccount` (Task 1's model) — the two tables have no FK
 * between them, so the generic Skill Config `api_key` connect flow cannot
 * populate `WhatsAppAccount` at all. The behaviours worth pinning: the auth
 * token is ENCRYPTED before it ever reaches Prisma (never stored raw), the
 * upsert is keyed on the real `@@unique([companyId, whatsappSenderNumber])`
 * constraint, and an `employeeId` from another company is rejected rather
 * than silently attached.
 */
describe('WhatsappAccountsService', () => {
  const row = {
    id: 'wa_1',
    companyId: 'c_1',
    employeeId: null,
    twilioAccountSid: 'ACxxx',
    whatsappSenderNumber: '+15550001111',
    status: 'CONNECTED',
    createdAt: new Date('2026-09-01T00:00:00Z'),
  };

  function build() {
    const prisma: any = {
      whatsAppAccount: {
        upsert: jest.fn().mockResolvedValue(row),
        findFirst: jest.fn().mockResolvedValue(row),
      },
      aiEmployee: {
        findFirst: jest.fn().mockResolvedValue({ id: 'emp_1' }),
      },
    };
    const crypto: any = {
      encrypt: jest.fn((s: string) => `enc:${s}`),
    };
    const service = new WhatsappAccountsService(prisma, crypto);
    return { service, prisma, crypto };
  }

  describe('connect', () => {
    const dto = {
      twilioAccountSid: 'ACxxx',
      twilioAuthToken: 'secret-token',
      whatsappSenderNumber: '+15550001111',
    };

    it('encrypts the auth token before writing it — never stores it raw', async () => {
      const { service, prisma, crypto } = build();
      await service.connect('c_1', dto);
      expect(crypto.encrypt).toHaveBeenCalledWith('secret-token');
      const call = prisma.whatsAppAccount.upsert.mock.calls[0][0];
      expect(call.create.twilioAuthToken).toBe('enc:secret-token');
      expect(call.update.twilioAuthToken).toBe('enc:secret-token');
      expect(call.create.twilioAuthToken).not.toBe('secret-token');
    });

    it('upserts on the companyId + whatsappSenderNumber unique constraint', async () => {
      const { service, prisma } = build();
      await service.connect('c_1', dto);
      expect(prisma.whatsAppAccount.upsert).toHaveBeenCalledWith(
        expect.objectContaining({
          where: {
            companyId_whatsappSenderNumber: {
              companyId: 'c_1',
              whatsappSenderNumber: '+15550001111',
            },
          },
        }),
      );
    });

    it('scopes the created row to companyId and marks it CONNECTED', async () => {
      const { service, prisma } = build();
      await service.connect('c_1', dto);
      const call = prisma.whatsAppAccount.upsert.mock.calls[0][0];
      expect(call.create).toEqual(
        expect.objectContaining({ companyId: 'c_1', status: 'CONNECTED' }),
      );
    });

    it('validates employeeId belongs to the same company before attaching it', async () => {
      const { service, prisma } = build();
      await service.connect('c_1', { ...dto, employeeId: 'emp_1' });
      expect(prisma.aiEmployee.findFirst).toHaveBeenCalledWith(
        expect.objectContaining({ where: { id: 'emp_1', companyId: 'c_1' } }),
      );
    });

    it('404s when employeeId does not belong to this company', async () => {
      const { service, prisma } = build();
      prisma.aiEmployee.findFirst.mockResolvedValueOnce(null);
      await expect(
        service.connect('c_1', { ...dto, employeeId: 'emp_other' }),
      ).rejects.toThrow(NotFoundException);
      expect(prisma.whatsAppAccount.upsert).not.toHaveBeenCalled();
    });

    it('never returns twilioAuthToken in the response DTO', async () => {
      const { service } = build();
      const result = await service.connect('c_1', dto);
      expect(result).not.toHaveProperty('twilioAuthToken');
    });
  });

  describe('getAccount', () => {
    it('scopes the lookup by companyId', async () => {
      const { service, prisma } = build();
      await service.getAccount('c_1');
      expect(prisma.whatsAppAccount.findFirst.mock.calls[0][0].where).toEqual({
        companyId: 'c_1',
      });
    });

    it('returns null when no account exists for this company', async () => {
      const { service, prisma } = build();
      prisma.whatsAppAccount.findFirst.mockResolvedValueOnce(null);
      const result = await service.getAccount('c_1');
      expect(result).toBeNull();
    });
  });
});
