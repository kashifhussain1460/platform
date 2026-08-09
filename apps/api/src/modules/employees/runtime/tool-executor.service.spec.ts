import { ToolExecutorService } from './tool-executor.service';

/**
 * HR production verification: an AI_EMPLOYEE_STEP passes forceApproval=true, so
 * EVERY tool the agent loop proposes must route to a human (PENDING) and never
 * execute — even a non-highRisk person-facing send, and even with no
 * approvalRules configured (doc 27 §0.3 structural T2 boundary).
 */
describe('ToolExecutorService.call — forceApproval (doc 27 §0.3)', () => {
  const runTool = jest.fn().mockResolvedValue({ ok: true });
  const requiresApproval = jest.fn().mockReturnValue(false); // not highRisk, no rules
  const createRequest = jest.fn().mockResolvedValue({ id: 'req-1' });
  const svc = new ToolExecutorService(
    { runTool } as never,
    { requiresApproval, createRequest } as never,
  );
  const ctx = { companyId: 'c1', employeeId: 'e1' } as never;
  const employee = { id: 'e1', companyId: 'c1' } as never;

  beforeEach(() => jest.clearAllMocks());

  it('routes an ungated tool to approval when forceApproval=true, never executing', async () => {
    const call = await svc.call(ctx, employee, 'gmail', 'send_email', { to: 'x' }, true);
    expect(call.pendingApproval).toBe(true);
    expect(call.approvalId).toBe('req-1');
    expect(runTool).not.toHaveBeenCalled();
    expect(createRequest).toHaveBeenCalledTimes(1);
  });

  it('executes an ungated tool normally when forceApproval=false (chat path unchanged)', async () => {
    const call = await svc.call(ctx, employee, 'gmail', 'send_email', { to: 'x' }, false);
    expect(call.ok).toBe(true);
    expect(runTool).toHaveBeenCalledTimes(1);
    expect(createRequest).not.toHaveBeenCalled();
  });

  // Chat path: forceApprovalForExternalActions gates SEND/egress tools but not reads.
  it('routes an external-action tool to approval when forceApprovalForExternalActions=true', async () => {
    const call = await svc.call(ctx, employee, 'gmail', 'send_email', { to: 'x' }, false, true);
    expect(call.pendingApproval).toBe(true);
    expect(runTool).not.toHaveBeenCalled();
    expect(createRequest).toHaveBeenCalledTimes(1);
  });

  it('still runs a read-only tool autonomously under forceApprovalForExternalActions', async () => {
    const call = await svc.call(ctx, employee, 'gmail', 'read_inbox', {}, false, true);
    expect(call.ok).toBe(true);
    expect(runTool).toHaveBeenCalledTimes(1);
    expect(createRequest).not.toHaveBeenCalled();
  });
});
