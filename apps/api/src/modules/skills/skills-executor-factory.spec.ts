import type { ConfigService } from '@nestjs/config';
import { skillExecutorFactory } from './skills.module';

/**
 * Phase 1 — the SKILL_EXECUTOR configuration path.
 *
 * `requireRealProviderInProduction` already guarded LLM_PROVIDER,
 * BILLING_PROVIDER and MAIL_ENABLED. SKILL_EXECUTOR was the one provider
 * factory without it, so a production deploy that simply forgot the variable
 * booted cleanly and answered every integration call out of the offline
 * sandbox — the "silent success" defect class, in the single place with the
 * widest blast radius.
 *
 * The `default:` branch was the second half of the same problem: any
 * unrecognised value (`REAL`, `production`, a trailing space in a dashboard
 * env var) also resolved to mock, in EVERY environment, with nothing logged.
 */
describe('skillExecutorFactory', () => {
  const originalNodeEnv = process.env.NODE_ENV;

  /** Minimal ConfigService stand-in; the factory only reads SKILL_EXECUTOR. */
  const configWith = (value: string | undefined): ConfigService =>
    ({ get: (key: string) => (key === 'SKILL_EXECUTOR' ? value : undefined) }) as ConfigService;

  /**
   * The factory's other nine dependencies are only ever stored on
   * RealSkillExecutor's fields — never called during construction — so empty
   * stubs are sufficient to exercise the selection logic.
   */
  const build = (value: string | undefined) =>
    skillExecutorFactory(
      configWith(value),
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
    );

  afterEach(() => {
    process.env.NODE_ENV = originalNodeEnv;
  });

  describe('production', () => {
    beforeEach(() => {
      process.env.NODE_ENV = 'production';
    });

    it('REFUSES TO BOOT when SKILL_EXECUTOR is missing', () => {
      expect(() => build(undefined)).toThrow(/SKILL_EXECUTOR is unset/);
    });

    it('REFUSES TO BOOT when SKILL_EXECUTOR is explicitly mock', () => {
      // Explicit is not an excuse in production: the mock cannot perform a
      // single real action, so booting with it means every integration lies.
      expect(() => build('mock')).toThrow(/refusing to start in production/i);
    });

    it('accepts a real executor', () => {
      expect(build('real').name).toBe('real');
    });

    it('accepts the auto dispatcher', () => {
      expect(build('auto').name).toBe('auto');
    });
  });

  describe('non-production', () => {
    beforeEach(() => {
      process.env.NODE_ENV = 'test';
    });

    it('defaults to the offline mock, so the e2e suite stays unchanged', () => {
      expect(build(undefined).name).toBe('mock');
    });

    it('accepts an explicit mock — the intended backend for tests and local dev', () => {
      expect(build('mock').name).toBe('mock');
    });

    it('accepts real and auto', () => {
      expect(build('real').name).toBe('real');
      expect(build('auto').name).toBe('auto');
    });

    it('tolerates surrounding whitespace and casing', () => {
      expect(build('  Auto  ').name).toBe('auto');
    });
  });

  describe('unrecognised values fail closed in EVERY environment', () => {
    it.each(['REAL_', 'production', 'true', 'sandbox', 'Mock ock'])(
      'refuses to boot on SKILL_EXECUTOR=%s',
      (value) => {
        process.env.NODE_ENV = 'test';
        expect(() => build(value)).toThrow(/is not a recognized skill executor/);
      },
    );

    it('names the accepted values so the error is actionable', () => {
      process.env.NODE_ENV = 'test';
      expect(() => build('nope')).toThrow(/mock, real, auto/);
    });
  });
});
