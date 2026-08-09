import { BadRequestException } from '@nestjs/common';
import type {
  InstalledSkillDto,
  SkillConnectionStatus,
  SkillConnectionType,
  WorkflowDefinition,
} from '@vaep/types';
import { SkillRequirementsService } from './skill-requirements.service';

/** Minimal masked InstalledSkill DTO for a connection lookup. */
function installed(
  skillKey: string,
  connectionStatus: SkillConnectionStatus,
  opts: { enabled?: boolean; connectionType?: SkillConnectionType; credentialsSet?: boolean } = {},
): InstalledSkillDto {
  return {
    id: `inst_${skillKey}`,
    companyId: 'co_1',
    skillKey,
    employeeId: null,
    displayName: skillKey,
    config: null,
    enabled: opts.enabled ?? true,
    connectionType: opts.connectionType ?? 'oauth',
    connectionStatus,
    credentialsSet: opts.credentialsSet ?? true,
    createdAt: '2026-08-07T00:00:00.000Z',
  };
}

function toolNode(id: string, skillKey: string, tool: string, extra: Record<string, unknown> = {}) {
  return {
    id,
    type: 'TOOL_ACTION' as const,
    config: { skillKey, tool, args: {}, outputKey: 'out', ...extra },
  };
}

function def(nodes: unknown[]): WorkflowDefinition {
  return { nodes: nodes as WorkflowDefinition['nodes'], edges: [] };
}

/** Fake SkillsService.findInstalledConnection backed by a per-skillKey map. */
function makeService(
  connections: Record<string, InstalledSkillDto | null>,
  executor: 'mock' | 'auto' | 'real' = 'auto',
): SkillRequirementsService {
  const skills = {
    findInstalledConnection: async (_c: string, skillKey: string) =>
      connections[skillKey] ?? null,
  };
  const config = { get: (_k: string) => executor };
  return new SkillRequirementsService(skills as never, config as never);
}

describe('SkillRequirementsService', () => {
  it('detects an unconnected required skill (capability-first) and blocks readiness', async () => {
    const svc = makeService({});
    const result = await svc.forDefinition('co_1', def([toolNode('n1', 'gmail', 'send_email')]), {
      canManageConnection: true,
    });

    expect(result.requirements).toHaveLength(1);
    const req = result.requirements[0];
    expect(req.skillKey).toBe('gmail');
    expect(req.displayName).toBe('Gmail');
    expect(req.provider).toBe('google');
    expect(req.capabilities).toEqual(['EMAIL_SEND']);
    expect(req.compatibleSkillKeys).toContain('email'); // multi-provider
    expect(req.requiresConnection).toBe(true);
    expect(req.status).toBe('NOT_CONNECTED');
    expect(req.nodeIds).toEqual(['n1']);
    expect(result.missingRequiredCount).toBe(1);
    expect(result.allRequiredReady).toBe(false);
  });

  it('reports READY when the connection is CONNECTED', async () => {
    const svc = makeService({ gmail: installed('gmail', 'CONNECTED') });
    const result = await svc.forDefinition('co_1', def([toolNode('n1', 'gmail', 'send_email')]), {
      canManageConnection: true,
    });
    expect(result.requirements[0].status).toBe('READY');
    expect(result.allRequiredReady).toBe(true);
  });

  it('projects DEGRADED and DISCONNECTED faithfully (both block)', async () => {
    const degraded = makeService({ gmail: installed('gmail', 'DEGRADED') });
    const disconnected = makeService({ gmail: installed('gmail', 'DISCONNECTED') });
    const d = def([toolNode('n1', 'gmail', 'send_email')]);
    expect((await degraded.forDefinition('co_1', d, { canManageConnection: true })).requirements[0].status).toBe('DEGRADED');
    expect((await disconnected.forDefinition('co_1', d, { canManageConnection: true })).requirements[0].status).toBe('DISCONNECTED');
    expect((await disconnected.forDefinition('co_1', d, { canManageConnection: true })).allRequiredReady).toBe(false);
  });

  it('treats a `none`-connection skill (http) as READY and non-blocking', async () => {
    const svc = makeService({});
    const result = await svc.forDefinition('co_1', def([toolNode('n1', 'http', 'request')]), {
      canManageConnection: true,
    });
    expect(result.requirements[0].requiresConnection).toBe(false);
    expect(result.requirements[0].status).toBe('READY');
    expect(result.allRequiredReady).toBe(true);
  });

  it('ignores disabled TOOL_ACTION nodes (the engine skips them)', async () => {
    const svc = makeService({});
    const result = await svc.forDefinition(
      'co_1',
      def([{ ...toolNode('n1', 'gmail', 'send_email'), disabled: true }]),
      { canManageConnection: true },
    );
    expect(result.requirements).toHaveLength(0);
    expect(result.allRequiredReady).toBe(true);
  });

  it('flags a skill outside the catalog as ERROR (blocks)', async () => {
    const svc = makeService({});
    const result = await svc.forDefinition('co_1', def([toolNode('n1', 'sap', 'post_invoice')]), {
      canManageConnection: true,
    });
    expect(result.requirements[0].status).toBe('ERROR');
    expect(result.allRequiredReady).toBe(false);
  });

  it('aggregates multiple nodes of the same skill into one requirement', async () => {
    const svc = makeService({ gmail: installed('gmail', 'CONNECTED') });
    const result = await svc.forDefinition(
      'co_1',
      def([toolNode('n1', 'gmail', 'send_email'), toolNode('n2', 'gmail', 'read_inbox')]),
      { canManageConnection: true },
    );
    expect(result.requirements).toHaveLength(1);
    expect(result.requirements[0].nodeIds).toEqual(['n1', 'n2']);
    expect(result.requirements[0].capabilities).toEqual(
      expect.arrayContaining(['EMAIL_SEND', 'EMAIL_READ']),
    );
  });

  it('passes canManageConnection through for the admin-required UI state', async () => {
    const svc = makeService({});
    const result = await svc.forDefinition('co_1', def([toolNode('n1', 'gmail', 'send_email')]), {
      canManageConnection: false,
    });
    expect(result.requirements[0].canManageConnection).toBe(false);
  });

  describe('forSkillKeys (in-chat card live refresh)', () => {
    it('resolves a bare skillKey list to statuses + capabilities', async () => {
      const svc = makeService({ gmail: installed('gmail', 'CONNECTED') });
      const result = await svc.forSkillKeys('co_1', ['gmail', 'calendar'], {
        canManageConnection: true,
      });
      const gmail = result.requirements.find((r) => r.skillKey === 'gmail')!;
      const calendar = result.requirements.find((r) => r.skillKey === 'calendar')!;
      expect(gmail.status).toBe('READY');
      expect(gmail.capabilities).toEqual(expect.arrayContaining(['EMAIL_SEND', 'EMAIL_READ']));
      expect(calendar.status).toBe('NOT_CONNECTED');
      expect(result.allRequiredReady).toBe(false);
    });

    it('de-duplicates repeated skillKeys', async () => {
      const svc = makeService({});
      const result = await svc.forSkillKeys('co_1', ['slack', 'slack'], {
        canManageConnection: true,
      });
      expect(result.requirements).toHaveLength(1);
    });
  });

  describe('assertPublishable', () => {
    const unmet = def([toolNode('n1', 'gmail', 'send_email')]);

    it('throws in a real-execution mode when a required skill is not connected', async () => {
      const svc = makeService({}, 'auto');
      await expect(svc.assertPublishable('co_1', unmet)).rejects.toBeInstanceOf(BadRequestException);
    });

    it('does not throw in mock mode (offline sandbox — connections are meaningless)', async () => {
      const svc = makeService({}, 'mock');
      await expect(svc.assertPublishable('co_1', unmet)).resolves.toBeUndefined();
    });

    it('does not throw when every required skill is READY', async () => {
      const svc = makeService({ gmail: installed('gmail', 'CONNECTED') }, 'auto');
      await expect(svc.assertPublishable('co_1', unmet)).resolves.toBeUndefined();
    });
  });
});
