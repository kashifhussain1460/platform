import { SkillsService } from './skills.service';
import { MetricsRegistry } from '../../common/observability/metrics.registry';

/**
 * P1-1 (doc 09 §9.D): runTool must refuse a tool for an employee that was not
 * granted the skill, WITHOUT invoking the executor, and must still allow a
 * call with no employeeId (company-wide manual path — back-compat).
 */
describe('SkillsService.runTool least-privilege gate', () => {
  const execute = jest.fn().mockResolvedValue({ ok: true, result: {} });
  const employeeSkillFindFirst = jest.fn();
  const skillExecutionCreate = jest.fn().mockResolvedValue({});

  const prisma = {
    employeeSkill: { findFirst: employeeSkillFindFirst },
    skillExecution: { create: skillExecutionCreate },
  } as never;
  const executor = { execute, usesInstalledCredentials: false } as never;
  const service = new SkillsService(
    prisma,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
    executor,
    { record: jest.fn() } as never,
    new MetricsRegistry(),
    // Nothing suppressed: these tests assert least-privilege, not consent.
    { findSuppressed: jest.fn().mockResolvedValue([]) } as never,
  );

  beforeEach(() => jest.clearAllMocks());

  it('denies an employee without a grant and never calls the executor', async () => {
    employeeSkillFindFirst.mockResolvedValue(null);
    const call = await service.runTool(
      { companyId: 'c1', employeeId: 'e1' },
      'slack',
      'send_message',
      {},
    );
    expect(call.ok).toBe(false);
    expect(execute).not.toHaveBeenCalled();
  });

  it('allows an employee that has the grant', async () => {
    employeeSkillFindFirst.mockResolvedValue({ id: 'es1' });
    const call = await service.runTool(
      { companyId: 'c1', employeeId: 'e1' },
      'slack',
      'send_message',
      {},
    );
    expect(call.ok).toBe(true);
    expect(execute).toHaveBeenCalledTimes(1);
  });

  it('allows a company-wide call with no employeeId (back-compat)', async () => {
    const call = await service.runTool(
      { companyId: 'c1' },
      'slack',
      'send_message',
      {},
    );
    expect(call.ok).toBe(true);
    expect(employeeSkillFindFirst).not.toHaveBeenCalled();
    expect(execute).toHaveBeenCalledTimes(1);
  });

  it('masks a resolved secret in the persisted args AND the returned args, but executes with the real value (D1)', async () => {
    const SECRET = 'sk-live-supersecretvalue';
    const call = await service.runTool(
      { companyId: 'c1', secretValues: [SECRET] },
      'http',
      'request',
      { url: 'https://x', token: SECRET },
    );
    // The executor received the REAL value (the call must actually work).
    expect(execute).toHaveBeenCalledWith(
      'http',
      'request',
      { url: 'https://x', token: SECRET },
      expect.anything(),
    );
    // The persisted audit row is masked.
    const persistedArgs = skillExecutionCreate.mock.calls[0][0].data.args;
    expect(persistedArgs.token).toBe('***');
    // The returned call (feeds step output / run context) is masked.
    expect((call.args as Record<string, unknown>).token).toBe('***');
  });
});

describe('SkillsService.verifyConnection — adapterAvailable', () => {
  function buildService(installed: Record<string, unknown>) {
    const prisma = {
      installedSkill: {
        findFirst: jest.fn().mockResolvedValue(installed),
        update: jest.fn().mockResolvedValue({}),
      },
    } as never;
    const tokens = { getAccessToken: jest.fn() } as never;
    return new SkillsService(
      prisma,
      {} as never,
      {} as never,
      tokens,
      {} as never,
      {} as never,
      {} as never,
      { record: jest.fn() } as never,
      new MetricsRegistry(),
      { findSuppressed: jest.fn().mockResolvedValue([]) } as never,
    );
  }

  afterEach(() => jest.restoreAllMocks());

  it('reports adapterAvailable:false for a skill with no registered adapter (stripe)', async () => {
    const service = buildService({
      id: 'is-1',
      companyId: 'c1',
      skillKey: 'stripe',
      connectionType: 'api_key',
      connectionStatus: 'NOT_CONNECTED',
      credentials: {},
      config: {},
    });
    const result = await service.verifyConnection('c1', 'is-1', {});
    expect(result.adapterAvailable).toBe(false);
    expect(result.ok).toBe(false);
  });

  it('reports adapterAvailable:true for an adapter-backed skill (gmail)', async () => {
    global.fetch = jest.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ emailAddress: 'hr@company.com' }),
    }) as unknown as typeof fetch;
    const service = buildService({
      id: 'is-2',
      companyId: 'c1',
      skillKey: 'gmail',
      connectionType: 'oauth',
      connectionStatus: 'NOT_CONNECTED',
      credentials: { accessToken: 'tok' },
      config: {},
    });
    const result = await service.verifyConnection('c1', 'is-2', {});
    expect(result.adapterAvailable).toBe(true);
    expect(result.ok).toBe(true);
  });
});
