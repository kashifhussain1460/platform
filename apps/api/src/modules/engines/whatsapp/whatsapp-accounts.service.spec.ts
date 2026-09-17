import { BadRequestException, NotFoundException } from '@nestjs/common';
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
      installedSkill: {
        updateMany: jest.fn().mockResolvedValue({ count: 1 }),
      },
    };
    const crypto: any = {
      encrypt: jest.fn((s: string) => `enc:${s}`),
    };
    const twilioClient: any = {
      verifyCredentials: jest.fn().mockResolvedValue({ accountSid: 'ACxxx', status: 'active' }),
    };
    const audit: any = { record: jest.fn().mockResolvedValue('audit_1') };
    const service = new WhatsappAccountsService(prisma, crypto, twilioClient, audit);
    return { service, prisma, crypto, twilioClient, audit };
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

    /**
     * The Skills catalog list and the employee skill picker both read
     * InstalledSkill.connectionStatus, not WhatsAppAccount.status — without
     * this sync, a real successful connect here would still show as "Not
     * connected" everywhere outside this dedicated form.
     *
     * The where-clause includes employeeId (null here, since `dto` has none)
     * so this only ever flips the InstalledSkill row scoped to the SAME
     * employee (or company-wide) whose credentials were just verified — see
     * the next test for the per-employee case. InstalledSkill has a real
     * `@@unique([companyId, skillKey, employeeId])` dimension, so omitting
     * employeeId here would flip every whatsapp row in the company, including
     * ones never actually verified.
     */
    it('syncs InstalledSkill.connectionStatus to CONNECTED on a successful connect (company-wide)', async () => {
      const { service, prisma } = build();
      await service.connect('c_1', dto);
      expect(prisma.installedSkill.updateMany).toHaveBeenCalledWith({
        where: { companyId: 'c_1', skillKey: 'whatsapp', employeeId: null },
        data: { connectionStatus: 'CONNECTED' },
      });
    });

    it('syncs only the InstalledSkill row scoped to the SAME employee when connect() is scoped to one', async () => {
      const { service, prisma } = build();
      await service.connect('c_1', { ...dto, employeeId: 'emp_1' });
      expect(prisma.installedSkill.updateMany).toHaveBeenCalledWith({
        where: { companyId: 'c_1', skillKey: 'whatsapp', employeeId: 'emp_1' },
        data: { connectionStatus: 'CONNECTED' },
      });
    });

    /**
     * I3 — this route used to write CONNECTED without ever exercising the
     * credentials, so a typo'd SID produced a green badge over a sender that
     * could never send or receive anything.
     */
    describe('verify-before-CONNECTED', () => {
      it('makes one real Twilio call with the SUPPLIED credentials before writing anything', async () => {
        const { service, twilioClient, prisma } = build();
        await service.connect('c_1', dto);
        expect(twilioClient.verifyCredentials).toHaveBeenCalledWith({
          companyId: 'c_1',
          accountSid: 'ACxxx',
          authToken: 'secret-token',
        });
        const verifyOrder = twilioClient.verifyCredentials.mock.invocationCallOrder[0];
        const upsertOrder = prisma.whatsAppAccount.upsert.mock.invocationCallOrder[0];
        expect(verifyOrder).toBeLessThan(upsertOrder);
      });

      it('refuses to mark the account CONNECTED when Twilio rejects the credentials', async () => {
        const { service, prisma, twilioClient, audit } = build();
        twilioClient.verifyCredentials.mockRejectedValueOnce(
          Object.assign(new Error('Authenticate (401)'), { status: 401 }),
        );
        await expect(service.connect('c_1', dto)).rejects.toThrow(BadRequestException);
        expect(prisma.whatsAppAccount.upsert).not.toHaveBeenCalled();
        expect(audit.record).toHaveBeenCalledWith(
          expect.objectContaining({ action: 'connector.verify_failed', companyId: 'c_1' }),
        );
      });

      it('audits a successful connect as connector.verified', async () => {
        const { service, audit } = build();
        await service.connect('c_1', dto);
        expect(audit.record).toHaveBeenCalledWith(
          expect.objectContaining({
            action: 'connector.verified',
            companyId: 'c_1',
            entityType: 'WhatsAppAccount',
            entityId: 'wa_1',
          }),
        );
      });

      it('never puts the auth token in an audit record', async () => {
        const { service, audit } = build();
        await service.connect('c_1', dto);
        expect(JSON.stringify(audit.record.mock.calls)).not.toContain('secret-token');
      });
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
