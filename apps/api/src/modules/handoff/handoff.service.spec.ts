import { ForbiddenException, NotFoundException } from '@nestjs/common';
import { HandoffService } from './handoff.service';

describe('HandoffService', () => {
  const conversation = { id: 'conv_1', companyId: 'c_1', status: 'OPEN' };

  function build() {
    const prisma: any = {
      supportConversation: {
        findFirst: jest.fn().mockResolvedValue(conversation),
        update: jest.fn().mockResolvedValue({}),
      },
      handoffRequest: {
        findFirst: jest.fn().mockResolvedValue(null),
        create: jest.fn().mockImplementation(({ data }: { data: Record<string, unknown> }) => ({
          id: 'ho_1',
          status: 'PENDING',
          assigneeUserId: null,
          approverRuleType: null,
          approverRuleValue: null,
          ...data,
        })),
        update: jest
          .fn()
          .mockImplementation(({ data }: { data: Record<string, unknown> }) => ({ id: 'ho_1', ...data })),
      },
      user: { findFirst: jest.fn() },
    };
    // Runs the callback against the SAME mocked delegates so assertions on
    // prisma.handoffRequest.create/update etc. still see the calls made
    // inside the transaction.
    prisma.$transaction = jest
      .fn()
      .mockImplementation((fn: (tx: unknown) => unknown) =>
        fn({ handoffRequest: prisma.handoffRequest, supportConversation: prisma.supportConversation }),
      );
    const routing = {
      resolveStep: jest.fn().mockResolvedValue({ approverRuleType: 'EMPLOYEE_MANAGER', assigneeUserId: 'mgr_1' }),
      canDecide: jest.fn().mockReturnValue(true),
    };
    const notifications = { handoffRequested: jest.fn().mockResolvedValue(undefined) };
    const service = new HandoffService(prisma, routing as any, notifications as any);
    return { service, prisma, routing, notifications };
  }

  it('escalates a conversation: creates a PENDING HandoffRequest and sets ESCALATED', async () => {
    const { service, prisma, routing, notifications } = build();
    const result = await service.escalate({
      companyId: 'c_1',
      conversationId: 'conv_1',
      employeeId: 'emp_1',
      reason: 'refund demand',
    });
    expect(result.status).toBe('PENDING');
    expect(routing.resolveStep).toHaveBeenCalledWith(
      'c_1',
      { rule: 'EMPLOYEE_MANAGER' },
      { employeeId: 'emp_1' },
    );
    expect(prisma.supportConversation.update).toHaveBeenCalledWith({
      where: { id: 'conv_1' },
      data: { status: 'ESCALATED' },
    });
    expect(notifications.handoffRequested).toHaveBeenCalledWith('c_1', {
      assigneeUserId: 'mgr_1',
      summary: expect.stringContaining('refund demand'),
    });
  });

  it('is idempotent: a conversation already PENDING keeps its existing handoff', async () => {
    const { service, prisma, routing } = build();
    prisma.handoffRequest.findFirst.mockResolvedValueOnce({ id: 'ho_existing', status: 'PENDING' });
    const result = await service.escalate({
      companyId: 'c_1',
      conversationId: 'conv_1',
      employeeId: 'emp_1',
      reason: 'again',
    });
    expect(result.id).toBe('ho_existing');
    expect(prisma.handoffRequest.create).not.toHaveBeenCalled();
    expect(routing.resolveStep).not.toHaveBeenCalled();
  });

  it('throws NotFoundException escalating a conversation that does not belong to this company', async () => {
    const { service, prisma } = build();
    prisma.supportConversation.findFirst.mockResolvedValueOnce(null);
    await expect(
      service.escalate({ companyId: 'c_1', conversationId: 'nope', employeeId: 'emp_1', reason: 'x' }),
    ).rejects.toBeInstanceOf(NotFoundException);
  });

  it('resolve(resume=true) sets the conversation back to OPEN', async () => {
    const { service, prisma, routing } = build();
    prisma.handoffRequest.findFirst.mockResolvedValueOnce({
      id: 'ho_1',
      companyId: 'c_1',
      conversationId: 'conv_1',
      status: 'PENDING',
      approverRuleType: 'EMPLOYEE_MANAGER',
      approverRuleValue: null,
      assigneeUserId: 'mgr_1',
    });
    prisma.user.findFirst.mockResolvedValueOnce({ id: 'mgr_1', role: 'MEMBER', departmentId: null, teamId: null });
    await service.resolve('c_1', 'ho_1', 'mgr_1', true, 'handled it');
    expect(routing.canDecide).toHaveBeenCalled();
    expect(prisma.supportConversation.update).toHaveBeenCalledWith({
      where: { id: 'conv_1' },
      data: { status: 'OPEN' },
    });
    expect(prisma.handoffRequest.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: 'ho_1' },
        data: expect.objectContaining({ status: 'RESOLVED', resolvedById: 'mgr_1', note: 'handled it' }),
      }),
    );
  });

  it('resolve(resume=false) closes the conversation as RESOLVED', async () => {
    const { service, prisma } = build();
    prisma.handoffRequest.findFirst.mockResolvedValueOnce({
      id: 'ho_1',
      companyId: 'c_1',
      conversationId: 'conv_1',
      status: 'PENDING',
      approverRuleType: null,
      approverRuleValue: null,
      assigneeUserId: null,
    });
    prisma.user.findFirst.mockResolvedValueOnce({ id: 'admin_1', role: 'ADMIN', departmentId: null, teamId: null });
    await service.resolve('c_1', 'ho_1', 'admin_1', false);
    expect(prisma.supportConversation.update).toHaveBeenCalledWith({
      where: { id: 'conv_1' },
      data: { status: 'RESOLVED' },
    });
  });

  it('rejects resolve() from a user routing does not authorize', async () => {
    const { service, prisma, routing } = build();
    routing.canDecide.mockReturnValueOnce(false);
    prisma.handoffRequest.findFirst.mockResolvedValueOnce({
      id: 'ho_1',
      companyId: 'c_1',
      conversationId: 'conv_1',
      status: 'PENDING',
      approverRuleType: 'USER',
      approverRuleValue: 'someone_else',
      assigneeUserId: 'someone_else',
    });
    prisma.user.findFirst.mockResolvedValueOnce({ id: 'not_them', role: 'MEMBER', departmentId: null, teamId: null });
    await expect(service.resolve('c_1', 'ho_1', 'not_them', true)).rejects.toBeInstanceOf(
      ForbiddenException,
    );
  });

  it('resolve() on an already-RESOLVED handoff is a no-op (returns it unchanged)', async () => {
    const { service, prisma } = build();
    const already = {
      id: 'ho_1',
      companyId: 'c_1',
      conversationId: 'conv_1',
      status: 'RESOLVED',
    };
    prisma.handoffRequest.findFirst.mockResolvedValueOnce(already);
    const result = await service.resolve('c_1', 'ho_1', 'admin_1', true);
    expect(result).toBe(already);
    expect(prisma.handoffRequest.update).not.toHaveBeenCalled();
  });
});
