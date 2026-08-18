import type { ConfigService } from '@nestjs/config';
import type { InstalledSkill } from '@prisma/client';
import { ConnectorHealthService } from './connector-health.service';
import type { AccessTokenResolver } from './credentials.util';
// Import side effect: registers the real provider adapters (gmail, email, ...)
// into the shared registry this service reads via getHealthProbe/getProviderAdapter.
import '../providers';

function buildConnector(overrides: Partial<InstalledSkill>): InstalledSkill {
  return {
    id: 'conn-1',
    companyId: 'company-1',
    skillKey: 'gmail',
    employeeId: null,
    displayName: 'Gmail',
    connectionType: 'oauth',
    connectionStatus: 'CONNECTED',
    consecutiveErrors: 0,
    credentials: {},
    config: {},
    enabled: true,
    createdAt: new Date(),
    lastHealthCheckAt: null,
    lastHealthError: null,
    tokenExpiresAt: null,
    disabledReason: null,
    inboundCursor: null,
    ...overrides,
  } as unknown as InstalledSkill;
}

describe('ConnectorHealthService — token freshness', () => {
  afterEach(() => jest.restoreAllMocks());

  it('refreshes a near-expired OAuth token before probing an adapter-backed connector', async () => {
    const connector = buildConnector({
      credentials: { accessToken: 'stale', refreshToken: 'rt-1' },
    });
    const prisma = {
      installedSkill: {
        findFirst: jest.fn().mockResolvedValue(connector),
        update: jest.fn().mockResolvedValue(connector),
      },
    } as never;
    const config = { get: () => 'real' } as unknown as ConfigService;
    const getAccessToken = jest.fn().mockResolvedValue('fresh-token');
    const tokens: AccessTokenResolver = { getAccessToken };

    global.fetch = jest.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ emailAddress: 'hr@company.com' }),
    }) as unknown as typeof fetch;

    const service = new ConnectorHealthService(prisma, {} as never, config, tokens as never);
    await service.runHealthCheck('company-1', 'conn-1');

    expect(getAccessToken).toHaveBeenCalledWith('conn-1');
    const [, init] = (global.fetch as jest.Mock).mock.calls[0];
    expect((init as { headers: Record<string, string> }).headers.authorization).toBe(
      'Bearer fresh-token',
    );
  });

  it('does not call getAccessToken for a non-oauth connector', async () => {
    const connector = buildConnector({
      skillKey: 'stripe', // no registered adapter → genericProbe, no network call
      connectionType: 'api_key',
      credentials: { apiKey: 'sk-123' },
    });
    const prisma = {
      installedSkill: {
        findFirst: jest.fn().mockResolvedValue(connector),
        update: jest.fn().mockResolvedValue(connector),
      },
    } as never;
    const config = { get: () => 'real' } as unknown as ConfigService;
    const getAccessToken = jest.fn();
    const tokens: AccessTokenResolver = { getAccessToken };

    const service = new ConnectorHealthService(prisma, {} as never, config, tokens as never);
    await service.runHealthCheck('company-1', 'conn-1');

    expect(getAccessToken).not.toHaveBeenCalled();
  });

  it('does nothing (no fetch, no refresh) when SKILL_EXECUTOR is mock', async () => {
    const connector = buildConnector({ credentials: { accessToken: 'stale', refreshToken: 'rt-1' } });
    const prisma = {
      installedSkill: {
        findFirst: jest.fn().mockResolvedValue(connector),
        update: jest.fn().mockResolvedValue(connector),
      },
    } as never;
    const config = { get: () => 'mock' } as unknown as ConfigService;
    const getAccessToken = jest.fn();
    const service = new ConnectorHealthService(prisma, {} as never, config, { getAccessToken } as never);

    const result = await service.runHealthCheck('company-1', 'conn-1');

    expect(getAccessToken).not.toHaveBeenCalled();
    expect(result.status).toBe('CONNECTED');
  });
});
