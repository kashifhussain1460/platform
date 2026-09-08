import { NotFoundException } from '@nestjs/common';
import { LeadsService } from './leads.service';

/**
 * The two behaviours worth pinning hardest here are both tenant isolation:
 * every list is filtered by companyId, and a lead belonging to another
 * company must 404 rather than leak its conversation.
 */
describe('LeadsService', () => {
  const lead = {
    id: 'lead_1',
    companyId: 'c_1',
    source: 'WHATSAPP',
    phone: '+15550001111',
    name: 'Ada Lovelace',
    email: null,
    status: 'NEW',
    qualificationData: null,
    conversationId: 'conv_1',
    assignedToUserId: null,
    createdAt: new Date('2026-09-01T00:00:00Z'),
    lastContactedAt: null,
  };

  function build() {
    const prisma: any = {
      lead: {
        findMany: jest.fn().mockResolvedValue([lead]),
        findFirst: jest.fn().mockResolvedValue({
          ...lead,
          conversation: {
            id: 'conv_1',
            employeeId: 'emp_1',
            title: null,
            createdAt: new Date('2026-09-01T00:00:00Z'),
            messages: [
              {
                id: 'msg_1',
                companyId: 'c_1',
                conversationId: 'conv_1',
                role: 'USER',
                content: 'Hi, is this in stock?',
                metadata: null,
                createdAt: new Date('2026-09-01T00:01:00Z'),
              },
            ],
          },
        }),
      },
    };
    const service = new LeadsService(prisma);
    return { service, prisma };
  }

  describe('listLeads', () => {
    it('filters by companyId', async () => {
      const { service, prisma } = build();
      await service.listLeads('c_1');
      expect(prisma.lead.findMany.mock.calls[0][0].where.companyId).toBe('c_1');
    });

    it('adds status and source filters only when supplied', async () => {
      const { service, prisma } = build();
      await service.listLeads('c_1', { status: 'HOT', source: 'WHATSAPP' });
      expect(prisma.lead.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { companyId: 'c_1', status: 'HOT', source: 'WHATSAPP' },
        }),
      );
    });

    it('maps rows to DTOs with ISO date strings', async () => {
      const { service } = build();
      const [dto] = await service.listLeads('c_1');
      expect(dto).toEqual(
        expect.objectContaining({ id: 'lead_1', phone: '+15550001111', status: 'NEW' }),
      );
      expect(typeof dto.createdAt).toBe('string');
    });
  });

  describe('getLead', () => {
    it('scopes the lookup by companyId (never another company\'s lead)', async () => {
      const { service, prisma } = build();
      await service.getLead('c_1', 'lead_1');
      expect(prisma.lead.findFirst.mock.calls[0][0].where).toEqual({
        id: 'lead_1',
        companyId: 'c_1',
      });
    });

    it('404s when the lead does not belong to this company', async () => {
      const { service, prisma } = build();
      prisma.lead.findFirst.mockResolvedValueOnce(null);
      await expect(service.getLead('c_1', 'lead_other')).rejects.toThrow(NotFoundException);
    });

    it('includes the conversation and its messages', async () => {
      const { service, prisma } = build();
      const dto = await service.getLead('c_1', 'lead_1');
      expect(prisma.lead.findFirst).toHaveBeenCalledWith(
        expect.objectContaining({
          include: expect.objectContaining({
            conversation: expect.objectContaining({
              include: { messages: { orderBy: { createdAt: 'asc' } } },
            }),
          }),
        }),
      );
      expect(dto.conversation?.messages).toHaveLength(1);
      expect(dto.conversation?.messages[0]).toEqual(
        expect.objectContaining({ content: 'Hi, is this in stock?' }),
      );
    });

    it('returns conversation: null when the lead has none', async () => {
      const { service, prisma } = build();
      prisma.lead.findFirst.mockResolvedValueOnce({ ...lead, conversation: null });
      const dto = await service.getLead('c_1', 'lead_1');
      expect(dto.conversation).toBeNull();
    });
  });
});
