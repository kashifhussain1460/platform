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
        findMany: jest.fn().mockResolvedValue([]),
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

  it('falls back to ANY_ADMIN when the employee has no manager', async () => {
    // `resolveStep('EMPLOYEE_MANAGER')` returns an EMPTY assignee when the AI
    // Employee has no manager, and `canDecide('EMPLOYEE_MANAGER')` requires a
    // concrete one — storing that pair produced a handoff nobody in the
    // company could ever resolve, while the conversation stayed ESCALATED and
    // the AI was blocked from replying. Unlike approvals there is no SLA sweep
    // to rescue it, so the dead end was permanent.
    const { service, prisma, routing, notifications } = build();
    routing.resolveStep.mockResolvedValueOnce({
      approverRuleType: 'EMPLOYEE_MANAGER',
      assigneeUserId: undefined,
    });

    await service.escalate({
      companyId: 'c_1',
      conversationId: 'conv_1',
      employeeId: 'emp_1',
      reason: 'no manager set',
    });

    expect(prisma.handoffRequest.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        approverRuleType: 'ANY_ADMIN',
        approverRuleValue: null,
        assigneeUserId: null,
      }),
    });
    // Admins are reached by the null-assignee branch of approvalRecipients.
    expect(notifications.handoffRequested).toHaveBeenCalledWith('c_1', {
      assigneeUserId: null,
      summary: expect.stringContaining('no manager set'),
    });
  });

  it('keeps a real manager assignment rather than widening it to admins', async () => {
    const { service, prisma } = build();
    await service.escalate({
      companyId: 'c_1',
      conversationId: 'conv_1',
      employeeId: 'emp_1',
      reason: 'manager set',
    });
    expect(prisma.handoffRequest.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        approverRuleType: 'EMPLOYEE_MANAGER',
        assigneeUserId: 'mgr_1',
      }),
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

/**
 * The inbox. `escalate` and `resolve` both shipped without a way to LIST what
 * was waiting, so an AI could step back from a customer conversation and the
 * human it was handed to had no screen showing it.
 */
describe('HandoffService.list', () => {
  const row = (over: Record<string, unknown> = {}) => ({
    id: 'ho_1',
    companyId: 'c_1',
    conversationId: 'conv_1',
    employeeId: 'emp_1',
    reason: 'Customer asked for a refund',
    status: 'PENDING',
    approverRuleType: 'EMPLOYEE_MANAGER',
    approverRuleValue: null,
    assigneeUserId: 'mgr_1',
    resolvedById: null,
    resolvedAt: null,
    note: null,
    createdAt: new Date('2026-08-22T10:00:00Z'),
    conversation: {
      id: 'conv_1',
      contactEmail: 'buyer@example.com',
      status: 'ESCALATED',
      lastMessageAt: new Date('2026-08-22T09:59:00Z'),
      messages: [
        { id: 'm2', direction: 'OUTBOUND', content: 'second', createdAt: new Date('2026-08-22T09:59:00Z') },
        { id: 'm1', direction: 'INBOUND', content: 'first', createdAt: new Date('2026-08-22T09:58:00Z') },
      ],
    },
    ...over,
  });

  function build() {
    const prisma: any = {
      handoffRequest: { findMany: jest.fn().mockResolvedValue([row()]) },
      user: {
        findFirst: jest
          .fn()
          .mockResolvedValue({ id: 'u_1', role: 'ADMIN', departmentId: null, teamId: null }),
      },
    };
    const routing = { resolveStep: jest.fn(), canDecide: jest.fn().mockReturnValue(true) };
    const notifications = { handoffRequested: jest.fn() };
    const service = new HandoffService(prisma, routing as any, notifications as any);
    return { service, prisma, routing };
  }

  it('is scoped to the calling company', async () => {
    const { service, prisma } = build();
    await service.list('c_1', 'u_1');
    expect(prisma.handoffRequest.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: expect.objectContaining({ companyId: 'c_1' }) }),
    );
  });

  it('returns conversation context so the inbox needs no second fetch', async () => {
    const { service } = build();
    const [item] = await service.list('c_1', 'u_1');
    expect(item.conversation?.contactEmail).toBe('buyer@example.com');
    expect(item.reason).toBe('Customer asked for a refund');
  });

  it('shows recent messages OLDEST-first, the way a conversation reads', async () => {
    // Fetched newest-first to honour `take: 5`; reversed for display.
    const { service } = build();
    const [item] = await service.list('c_1', 'u_1');
    expect(item.conversation?.recentMessages.map((m) => m.id)).toEqual(['m1', 'm2']);
  });

  it('bounds the message context rather than dumping a transcript', async () => {
    const { service, prisma } = build();
    await service.list('c_1', 'u_1');
    const include = prisma.handoffRequest.findMany.mock.calls[0][0].include;
    expect(include.conversation.select.messages.take).toBe(5);
  });

  it('marks canResolve from the SAME routing rules approvals use', async () => {
    const { service, routing } = build();
    const [item] = await service.list('c_1', 'u_1');
    expect(item.canResolve).toBe(true);
    expect(routing.canDecide).toHaveBeenCalled();
  });

  it('returns the WHOLE queue by default, with canResolve false for others', async () => {
    // A support queue that hides work from a colleague is a queue that stalls.
    const { service, routing } = build();
    routing.canDecide.mockReturnValue(false);
    const items = await service.list('c_1', 'u_1');
    expect(items).toHaveLength(1);
    expect(items[0].canResolve).toBe(false);
  });

  it('assignedToMe narrows it to what this user may action', async () => {
    const { service, routing } = build();
    routing.canDecide.mockReturnValue(false);
    expect(await service.list('c_1', 'u_1', { assignedToMe: true })).toEqual([]);
  });

  it('passes a status filter through', async () => {
    const { service, prisma } = build();
    await service.list('c_1', 'u_1', { status: 'PENDING' });
    expect(prisma.handoffRequest.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: expect.objectContaining({ status: 'PENDING' }) }),
    );
  });

  it('treats an unknown user as able to resolve nothing', async () => {
    const { service, prisma } = build();
    prisma.user.findFirst.mockResolvedValue(null);
    const [item] = await service.list('c_1', 'u_ghost');
    expect(item.canResolve).toBe(false);
  });

  it('survives a handoff whose conversation row is missing', async () => {
    const { service, prisma } = build();
    prisma.handoffRequest.findMany.mockResolvedValue([row({ conversation: null })]);
    const [item] = await service.list('c_1', 'u_1');
    expect(item.conversation).toBeNull();
  });
});
