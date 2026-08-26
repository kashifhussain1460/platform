import { AutoSkillExecutor } from './auto-skill-executor';
import { MockSkillExecutor } from './mock-skill-executor';
import type {
  ExecutorContext,
  SkillExecutionResult,
  SkillExecutor,
} from './skill-executor';

/**
 * Phase 1 — "never silently fall back to mock success in production".
 *
 * Three separate places could fabricate a success before this phase:
 *   1. the FACTORY (`SKILL_EXECUTOR` unset/typo'd → mock),
 *   2. the AUTO dispatcher (skill not connected → mock),
 *   3. the REAL executor's `default:` branch (tool not implemented → mock).
 *
 * (1) is covered by `skills-executor-factory.spec.ts`; (2) and (3) are here.
 * Guarding only one of the three would have been cosmetic — a production
 * deployment running `SKILL_EXECUTOR=auto` (which is what `.env.example`
 * recommends) hits (2) and (3) constantly and (1) never.
 */

const ctx = (over: Partial<ExecutorContext> = {}): ExecutorContext => ({
  companyId: 'co-1',
  employeeId: 'emp-1',
  ...over,
});

/** Stand-in for RealSkillExecutor — records that it was (or wasn't) reached. */
class SpyExecutor implements SkillExecutor {
  readonly name = 'spy';
  readonly usesInstalledCredentials = true;
  calls: string[] = [];
  execute(
    skillKey: string,
    tool: string,
  ): Promise<SkillExecutionResult> {
    this.calls.push(`${skillKey}.${tool}`);
    return Promise.resolve({ ok: true, result: { real: true } });
  }
}

describe('AutoSkillExecutor fail-closed', () => {
  let real: SpyExecutor;
  let mock: MockSkillExecutor;

  beforeEach(() => {
    real = new SpyExecutor();
    mock = new MockSkillExecutor();
  });

  describe('development / test (failClosed = false) — behaviour is unchanged', () => {
    const auto = () => new AutoSkillExecutor(real, mock, false);

    it('falls back to the sandbox when the skill is not connected', async () => {
      const out = await auto().execute('slack', 'send_message', {}, ctx());
      expect(out.ok).toBe(true);
      expect(real.calls).toEqual([]);
    });

    it('still routes a connected skill to the real executor', async () => {
      const out = await auto().execute(
        'slack',
        'send_message',
        {},
        ctx({ connectionStatus: 'CONNECTED', credentials: { token: 'x' } }),
      );
      expect(out.result).toEqual({ real: true });
      expect(real.calls).toEqual(['slack.send_message']);
    });
  });

  describe('production (failClosed = true)', () => {
    const auto = () => new AutoSkillExecutor(real, mock, true);

    it('REFUSES an unconnected skill instead of returning a sandbox success', async () => {
      const out = await auto().execute('slack', 'send_message', {}, ctx());
      expect(out.ok).toBe(false);
      expect(out.error).toContain('not connected');
      expect(out.error).toContain('Refusing to return a simulated result');
      // The critical assertion: nothing pretended to send.
      expect(out.result).toBeUndefined();
      expect(real.calls).toEqual([]);
    });

    it('REFUSES a CONNECTED skill whose credentials are missing', async () => {
      // The dangerous middle state: the badge says connected, the secret is
      // gone (rotated ENCRYPTION_KEY, failed migration, manual DB edit).
      const out = await auto().execute(
        'slack',
        'send_message',
        {},
        ctx({ connectionStatus: 'CONNECTED', credentials: {} }),
      );
      expect(out.ok).toBe(false);
      expect(out.error).toContain('no stored credentials');
      expect(real.calls).toEqual([]);
    });

    it('REFUSES a DISCONNECTED skill and names the status', async () => {
      const out = await auto().execute(
        'slack',
        'send_message',
        {},
        ctx({ connectionStatus: 'DISCONNECTED', credentials: { token: 'x' } }),
      );
      expect(out.ok).toBe(false);
      expect(out.error).toContain('DISCONNECTED');
    });

    it('still runs a properly connected skill for real', async () => {
      const out = await auto().execute(
        'slack',
        'send_message',
        {},
        ctx({ connectionStatus: 'CONNECTED', credentials: { token: 'x' } }),
      );
      expect(out.ok).toBe(true);
      expect(real.calls).toEqual(['slack.send_message']);
    });

    it('still runs a connection-less skill (http) for real', async () => {
      // `connection.type === 'none'` skills need no credentials, so failing
      // them closed would break the HTTP skill for no safety gain.
      const out = await auto().execute('http', 'request', {}, ctx());
      expect(out.ok).toBe(true);
      expect(real.calls).toEqual(['http.request']);
    });
  });
});
