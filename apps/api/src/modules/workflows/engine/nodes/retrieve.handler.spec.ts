import type { WorkflowNode } from '@vaep/types';
import type { PrismaService } from '../../../../common/prisma/prisma.service';
import type { KnowledgeService } from '../../../knowledge/knowledge.service';
import { RetrieveNodeHandler } from './retrieve.handler';
import type { NodeExecContext } from './node-handler';

/**
 * Hardening plan §44 — the workflow RETRIEVE node was a knowledge leak.
 *
 * It searched the entire company knowledge base while chat retrieval for the
 * same AI Employee was role-scoped, so a Marketing workflow could read HR
 * documents by adding one node. These tests are about WHAT SCOPE reaches the
 * query — the thing that decides whether the leak is closed.
 */
describe('RetrieveNodeHandler (§44 scoping)', () => {
  const retrieve = jest.fn().mockResolvedValue([]);
  const knowledge = { retrieve } as unknown as KnowledgeService;

  const employeeFindFirst = jest.fn();
  const workflowFindFirst = jest.fn();
  const prisma = {
    aiEmployee: { findFirst: employeeFindFirst },
    workflow: { findFirst: workflowFindFirst },
  } as unknown as PrismaService;

  const handler = new RetrieveNodeHandler(knowledge, prisma);

  const ctx = (config: Record<string, unknown>): NodeExecContext => ({
    companyId: 'co_1',
    workflowId: 'wf_1',
    runId: 'run_1',
    node: { id: 'r1', type: 'RETRIEVE', config } as WorkflowNode,
    context: {},
    dryRun: false,
  });

  beforeEach(() => {
    retrieve.mockClear().mockResolvedValue([]);
    employeeFindFirst.mockReset();
    workflowFindFirst.mockReset().mockResolvedValue({ category: null });
  });

  it("scopes to the acting employee's role when the node names one", async () => {
    employeeFindFirst.mockResolvedValue({
      role: 'MARKETING',
      knowledgeAccess: 'ALL',
    });

    const result = await handler.execute(
      ctx({ query: 'brand guidelines', employeeId: 'emp_1' }),
    );

    expect(retrieve).toHaveBeenCalledWith('co_1', 'brand guidelines', 5, 'MARKETING', false);
    expect((result.output as { scope: string }).scope).toBe('MARKETING');
  });

  it('returns NOTHING for an employee whose knowledgeAccess is NONE', async () => {
    // Same answer chat gives. A workflow must not be the way around a setting
    // the customer made deliberately.
    employeeFindFirst.mockResolvedValue({
      role: 'HR',
      knowledgeAccess: 'NONE',
    });

    const result = await handler.execute(
      ctx({ query: 'salaries', employeeId: 'emp_1' }),
    );

    expect(retrieve).not.toHaveBeenCalled();
    expect(result.contextValue).toEqual([]);
    expect(result.output).toMatchObject({ count: 0, denied: true });
  });

  it('DENIES rather than widening when the employeeId resolves to nobody', async () => {
    // The sharp one: falling through to company-wide would make a typo — or a
    // cross-tenant id — the WIDEST possible scope.
    employeeFindFirst.mockResolvedValue(null);

    const result = await handler.execute(
      ctx({ query: 'anything', employeeId: 'emp_from_another_tenant' }),
    );

    expect(retrieve).not.toHaveBeenCalled();
    expect(result.output).toMatchObject({ denied: true });
  });

  it("falls back to the WORKFLOW's category, so an unattributed node is still scoped", async () => {
    // This is the loophole that mattered: omit employeeId and the old node
    // returned everything.
    workflowFindFirst.mockResolvedValue({ category: 'HR' });

    const result = await handler.execute(ctx({ query: 'leave policy' }));

    expect(retrieve).toHaveBeenCalledWith('co_1', 'leave policy', 5, 'HR', false);
    expect((result.output as { scope: string }).scope).toBe('HR');
  });

  it('maps RECRUITMENT → RECRUITER rather than casting the enum through', async () => {
    // WorkflowCategory and EmployeeRole are different enums. Passing
    // 'RECRUITMENT' into a ::"EmployeeRole" cast fails in Postgres at runtime.
    workflowFindFirst.mockResolvedValue({ category: 'RECRUITMENT' });

    await handler.execute(ctx({ query: 'open roles' }));

    expect(retrieve).toHaveBeenCalledWith('co_1', 'open roles', 5, 'RECRUITER', false);
  });

  it('scopes a category with NO role equivalent to shared documents only', async () => {
    // IT/COMPLIANCE/OPERATIONS/CUSTOM cannot tag a document, so company-wide
    // would quietly re-open the hole for exactly those workflows.
    workflowFindFirst.mockResolvedValue({ category: 'IT' });

    const result = await handler.execute(ctx({ query: 'vpn setup' }));

    expect(retrieve).toHaveBeenCalledWith('co_1', 'vpn setup', 5, undefined, true);
    expect((result.output as { scope: string }).scope).toBe('SHARED_ONLY');
  });

  it('stays company-wide for an uncategorised workflow with no employee', async () => {
    // Nothing names a scope, so there is nothing to enforce — and the output
    // says `scope: null` rather than leaving it to be assumed.
    workflowFindFirst.mockResolvedValue({ category: null });

    const result = await handler.execute(ctx({ query: 'anything' }));

    expect(retrieve).toHaveBeenCalledWith('co_1', 'anything', 5, undefined, false);
    expect((result.output as { scope: null }).scope).toBeNull();
  });
});
