import type { WorkflowNode } from '@vaep/types';
import type { NotificationsService } from '../../../notifications/notifications.service';
import { NotifyNodeHandler } from './notify.handler';
import type { NodeExecContext } from './node-handler';

/**
 * Hardening plan §30 — the NOTIFY contract.
 *
 * The bug these cover is not "email formatting is wrong". It is that the node
 * used to return `notified: true` having sent nothing: a run record that
 * answered "was anyone told?" with a confident, wrong yes. So every test here is
 * about whether the OUTPUT tells the truth.
 */
describe('NotifyNodeHandler', () => {
  const workflowNotify = jest.fn();
  const notifications = { workflowNotify } as unknown as NotificationsService;
  const handler = new NotifyNodeHandler(notifications);

  const ctx = (
    config: Record<string, unknown>,
    extra: Partial<NodeExecContext> = {},
  ): NodeExecContext => ({
    companyId: 'company_1',
    workflowId: 'wf_1',
    runId: 'run_1',
    node: { id: 'n1', type: 'NOTIFY', config } as WorkflowNode,
    context: {},
    dryRun: false,
    ...extra,
  });

  beforeEach(() => workflowNotify.mockReset());

  it('reports delivered:false — with a reason — when no recipient is configured', async () => {
    // Every NOTIFY node that exists today looks exactly like this. It must keep
    // working, keep sending nothing, and SAY so.
    workflowNotify.mockResolvedValue({
      delivered: false,
      recipientCount: 0,
      reason: 'no recipients configured',
    });

    const result = await handler.execute(ctx({ message: 'Build finished' }));

    expect(result.output).toMatchObject({
      message: 'Build finished',
      delivered: false,
      recipientCount: 0,
    });
    expect((result.output as { reason: string }).reason).toMatch(/no recipients/);
    // Crucially: the old `notified: true` claim is gone for good.
    expect(result.output).not.toHaveProperty('notified');
  });

  it('delivers to a role and reports the real recipient count', async () => {
    workflowNotify.mockResolvedValue({ delivered: true, recipientCount: 2 });

    const result = await handler.execute(
      ctx({ message: 'Deploy done', notifyRoles: 'OWNER, ADMIN' }),
    );

    expect(workflowNotify).toHaveBeenCalledWith('company_1', {
      message: 'Deploy done',
      roles: ['OWNER', 'ADMIN'],
    });
    expect(result.output).toMatchObject({ delivered: true, recipientCount: 2 });
  });

  it('ignores a role that is not a real role rather than passing it through', async () => {
    // A typo'd or attacker-supplied scope must not reach the query. Dropping it
    // narrows the audience; forwarding it is how an unexpected filter widens one.
    workflowNotify.mockResolvedValue({
      delivered: false,
      recipientCount: 0,
      reason: 'no recipients configured',
    });

    await handler.execute(ctx({ message: 'x', notifyRoles: 'SUPERUSER' }));

    expect(workflowNotify).toHaveBeenCalledWith('company_1', { message: 'x' });
  });

  it('resolves recipients from the run context, so a workflow can route dynamically', async () => {
    workflowNotify.mockResolvedValue({ delivered: true, recipientCount: 1 });

    await handler.execute(
      ctx(
        { message: 'Hi', notifyUserIds: '{{trigger.managerId}}' },
        { context: { trigger: { managerId: 'user_42' } } },
      ),
    );

    expect(workflowNotify).toHaveBeenCalledWith('company_1', {
      message: 'Hi',
      userIds: ['user_42'],
    });
  });

  it('sends NOTHING on a dry run', async () => {
    // A dry run has to be provably side-effect free, and mail is the one side
    // effect that cannot be taken back.
    const result = await handler.execute(
      ctx({ message: 'Careful', notifyRoles: 'ADMIN' }, { dryRun: true }),
    );

    expect(workflowNotify).not.toHaveBeenCalled();
    expect(result.output).toMatchObject({ delivered: false, dryRun: true });
  });

  it('does not claim delivery when every send failed', async () => {
    workflowNotify.mockResolvedValue({
      delivered: false,
      recipientCount: 0,
      reason: 'every send failed',
    });

    const result = await handler.execute(
      ctx({ message: 'Alert', notifyRoles: 'ADMIN' }),
    );

    expect(result.output).toMatchObject({ delivered: false });
  });
});
