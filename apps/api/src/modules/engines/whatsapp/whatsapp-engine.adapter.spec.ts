import { WhatsappEngineAdapter } from './whatsapp-engine.adapter';
import { ENGINE_ADAPTER_METHODS, EngineCapabilityUnsupportedError } from '../engine-adapter';

describe('WhatsappEngineAdapter', () => {
  const prisma = {
    whatsAppAccount: {
      findFirst: jest.fn(),
      deleteMany: jest.fn(),
    },
  };
  const crypto = { decrypt: jest.fn((v: string) => v) } as any;
  const client = {} as any;
  const adapter = new WhatsappEngineAdapter(client, prisma as any, crypto);

  it('implements every method the contract requires', () => {
    for (const method of ENGINE_ADAPTER_METHODS) {
      expect(typeof (adapter as any)[method]).toBe('function');
    }
  });

  it('declares its real capabilities and tools', () => {
    expect(adapter.engineKey).toBe('whatsapp');
    expect(adapter.tools()).toEqual([
      'whatsapp.send_message',
      'whatsapp.send_template',
      'whatsapp.get_conversation',
      'whatsapp.update_lead_status',
    ]);
    expect(adapter.capabilities()).toContain('disconnect');
    expect(adapter.capabilities()).toContain('healthCheck');
    expect(adapter.capabilities()).not.toContain('handleWebhook');
  });

  it('handleWebhook rejects with EngineCapabilityUnsupportedError (verification happens in the controller)', async () => {
    await expect(
      adapter.handleWebhook({ rawBody: Buffer.from(''), headers: {} }),
    ).rejects.toBeInstanceOf(EngineCapabilityUnsupportedError);
  });

  it('healthCheck reports ok when an account is registered for the company', async () => {
    prisma.whatsAppAccount.findFirst.mockResolvedValue({ id: 'wa_1' });
    const result = await adapter.healthCheck('c_1');
    expect(result).toEqual({ ok: true });
  });

  it('healthCheck reports not-ok when no account is registered', async () => {
    prisma.whatsAppAccount.findFirst.mockResolvedValue(null);
    const result = await adapter.healthCheck('c_1');
    expect(result.ok).toBe(false);
  });

  it('disconnect removes the company\'s WhatsAppAccount row', async () => {
    await adapter.disconnect('c_1');
    expect(prisma.whatsAppAccount.deleteMany).toHaveBeenCalledWith({ where: { companyId: 'c_1' } });
  });
});
