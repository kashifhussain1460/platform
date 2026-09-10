import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * Drift guard for the employee-readiness cache invariant — same technique as
 * `features/product-context/__tests__/invalidation.test.ts`, which exists
 * precisely because that same class of bug (a docstring claiming invalidation
 * that no mutation actually performed) shipped once already and was only
 * caught by a real Playwright run.
 *
 * `useEmployeeReadiness` has no such docstring promise to check against
 * (nothing claims it self-invalidates) — this guard exists so it never
 * quietly acquires one without the mutations to back it up. Every mutation
 * that writes one of the five inputs `employee-readiness.ts` reads (employee
 * status/archivedAt, EmployeeSkill assignment, InstalledSkill connection
 * state, KnowledgeDocument existence in the employee's scope, Workflow
 * publish/activate/deactivate) must invalidate either the specific
 * `employeeKeys.readiness(id)` (when the hook knows which employee) or the
 * whole `employeeKeys.all` branch (when it does not — e.g. a global skill
 * connect has no single employee to blame).
 */

const WEB_SRC = join(__dirname, '..', '..', '..');

/** Hooks that write an employee-readiness input, by file, and which key. */
const MUST_INVALIDATE: Readonly<
  Record<string, readonly { hook: string; key: 'all' | 'readiness' }[]>
> = {
  'features/skills/hooks.ts': [
    // No single employeeId in scope — could be a company-wide connection.
    { hook: 'useInstallSkill', key: 'all' },
    { hook: 'useUpdateInstalledSkill', key: 'all' },
    { hook: 'useUninstallSkill', key: 'all' },
    { hook: 'useConfigureSkill', key: 'all' },
    { hook: 'useConnectSkill', key: 'all' },
    { hook: 'useDisconnectSkill', key: 'all' },
    { hook: 'useCheckConnectorHealth', key: 'all' },
    { hook: 'useVerifyConnection', key: 'all' },
    // These ARE scoped to one employeeId (a parameter of the hook itself).
    { hook: 'useAssignSkill', key: 'readiness' },
    { hook: 'useUnassignSkill', key: 'readiness' },
  ],
  'features/workflows/hooks.ts': [
    // Arms/disarms a trigger; the graph isn't parsed client-side to find
    // which employee(s) it names, so invalidate broadly rather than guess.
    { hook: 'useSetActive', key: 'all' },
    { hook: 'usePublishAndActivate', key: 'all' },
  ],
};

/**
 * Source of one function, exported or not, from its declaration to the next
 * top-level `function` declaration. `useSetActive` in workflows/hooks.ts is
 * a private helper `useActivateWorkflow`/`useDeactivateWorkflow` both call —
 * this must find it too, not just `export function`.
 */
function functionBody(source: string, name: string): string {
  const re = new RegExp(`(?:export )?function ${name}\\(`);
  const match = re.exec(source);
  if (!match) return '';
  const start = match.index;
  const next = source.slice(start + 1).search(/\n(?:export )?function /);
  return next === -1 ? source.slice(start) : source.slice(start, start + 1 + next);
}

describe('employee readiness cache invalidation', () => {
  for (const [relPath, hooks] of Object.entries(MUST_INVALIDATE)) {
    describe(relPath, () => {
      const source = readFileSync(join(WEB_SRC, relPath), 'utf8');

      it('imports employeeKeys', () => {
        expect(source).toContain(
          "import { employeeKeys } from '@/features/employees/hooks'",
        );
      });

      for (const { hook, key } of hooks) {
        it(`${hook} invalidates employeeKeys.${key === 'all' ? 'all' : 'readiness(...)'}`, () => {
          const body = functionBody(source, hook);
          // Guards against the hook being renamed/removed without this list
          // being updated — an empty body would otherwise pass vacuously.
          expect(body, `${hook} not found in ${relPath}`).not.toBe('');
          expect(body).toContain(
            key === 'all' ? 'employeeKeys.all' : 'employeeKeys.readiness(',
          );
        });
      }
    });
  }

  it('useActivateWorkflow and useDeactivateWorkflow both route through the guarded helper', () => {
    // They call useSetActive(true/false) rather than invalidating themselves —
    // confirm that delegation still holds, since the guard above only checks
    // useSetActive's own body.
    const source = readFileSync(
      join(WEB_SRC, 'features', 'workflows', 'hooks.ts'),
      'utf8',
    );
    expect(functionBody(source, 'useActivateWorkflow')).toContain(
      'useSetActive(true)',
    );
    expect(functionBody(source, 'useDeactivateWorkflow')).toContain(
      'useSetActive(false)',
    );
  });
});
