import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { SkillCatalog } from '../catalog';
import {
  REAL_EXECUTION_TOOLS,
  executionSupportFor,
  hasAnyRealExecution,
  isRealExecutionSupported,
  skillsWithNoRealExecution,
} from './real-execution-support';

/**
 * Phase 1 — drift guard for "is this integration real?".
 *
 * Same shape as `capabilities.spec.ts`: a hand-maintained registry is only
 * trustworthy if a test compares it against the thing it claims to describe.
 * Here that thing is the `switch` inside `RealSkillExecutor.execute()`, read
 * from source — because the alternative (trusting a comment) is precisely how
 * hubspot and jira ended up with green CONNECTED badges and no executor.
 */
describe('real execution support', () => {
  const executorSource = readFileSync(
    join(__dirname, 'real-skill-executor.ts'),
    'utf8',
  );

  /** Every `case 'skill.tool':` label in the real executor. */
  const casesInSource = [
    ...executorSource.matchAll(/case '([a-z_]+\.[a-z_]+)':/g),
  ].map((m) => m[1]);

  describe('registry matches the executor', () => {
    it('lists every case the executor actually implements', () => {
      const missing = casesInSource.filter(
        (ref) => !REAL_EXECUTION_TOOLS.includes(ref),
      );
      expect(missing).toEqual([]);
    });

    it('claims nothing the executor does not implement', () => {
      const overclaimed = REAL_EXECUTION_TOOLS.filter(
        (ref) => !casesInSource.includes(ref),
      );
      expect(overclaimed).toEqual([]);
    });

    it('references only (skill, tool) pairs that exist in the catalog', () => {
      for (const ref of REAL_EXECUTION_TOOLS) {
        const [skillKey, tool] = ref.split('.');
        expect(SkillCatalog.getTool(skillKey, tool)).toBeDefined();
      }
    });
  });

  describe('the four skills the audit found', () => {
    const allKeys = SkillCatalog.list().map((s) => s.key);

    it.each(['hubspot', 'jira', 'github', 'stripe'])(
      '%s is still SIMULATED — remove it from this list only when a real executor lands',
      (skillKey) => {
        expect(hasAnyRealExecution(skillKey)).toBe(false);
        const def = SkillCatalog.get(skillKey);
        expect(def?.executionSupport).toBe('SIMULATED');
      },
    );

    it('reports exactly the simulated skills and no others', () => {
      expect(skillsWithNoRealExecution(allKeys).sort()).toEqual(
        ['github', 'hubspot', 'jira', 'stripe'].sort(),
      );
    });

    it('marks EVERY tool of a simulated skill as simulated in the DTO', () => {
      const stripe = SkillCatalog.get('stripe');
      expect(stripe?.tools.length).toBeGreaterThan(0);
      for (const tool of stripe?.tools ?? []) {
        expect(tool.simulated).toBe(true);
      }
    });

    it("does not mark a real skill's real tools as simulated", () => {
      const slack = SkillCatalog.get('slack');
      const send = slack?.tools.find((t) => t.name === 'send_message');
      expect(send?.simulated).toBeUndefined();
    });
  });

  describe('classification', () => {
    it('classifies a skill whose tools are all real as REAL', () => {
      expect(executionSupportFor('slack', ['send_message'])).toBe('REAL');
    });

    it('classifies a mixed skill as PARTIAL, not REAL', () => {
      // gmail.send_email is real; gmail.read_inbox is not. Calling the skill
      // "REAL" would be the same over-claim this file exists to prevent.
      expect(executionSupportFor('gmail', ['send_email', 'read_inbox'])).toBe(
        'PARTIAL',
      );
      expect(SkillCatalog.get('gmail')?.executionSupport).toBe('PARTIAL');
    });

    it('classifies a skill with no real tools as SIMULATED', () => {
      expect(executionSupportFor('hubspot', ['create_contact'])).toBe('SIMULATED');
    });

    it('treats a toolless skill as SIMULATED rather than vacuously REAL', () => {
      expect(executionSupportFor('anything', [])).toBe('SIMULATED');
    });
  });

  describe('per-tool lookup', () => {
    it('is exact — a real skill does not make all its tools real', () => {
      expect(isRealExecutionSupported('gmail', 'send_email')).toBe(true);
      expect(isRealExecutionSupported('gmail', 'read_inbox')).toBe(false);
    });
  });
});
