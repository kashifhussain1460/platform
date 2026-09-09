import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * Drift guard for the product-context cache invariant.
 *
 * The bug this pins: `productContextKeys.all` had ZERO `invalidateQueries`
 * callers anywhere in the app, while `useProductContext`'s own docstring claimed
 * every relevant mutation invalidated it. Hiring your last seat therefore left
 * the seat counter reading the old value for up to 60s (`staleTime: 60_000`,
 * `refetchOnWindowFocus: false`, and TanStack prefix matching does NOT propagate
 * from the child `['product-context','dashboard']` key to the parent). A
 * Playwright run of `06-plan-seats-journey` failed on exactly that.
 *
 * A behavioural test per hook would need the whole api surface of six features
 * mocked; this reads the source instead — the same technique
 * `real-execution-support.spec.ts` uses to stop the skill catalog drifting from
 * its executor. It answers the one question that matters: does every mutation
 * that writes a product-context input still invalidate it?
 *
 * If you add a mutation that writes one of the six inputs
 * (`product-context.service.ts` resolves from: Company industry/size/
 * businessGoals · Subscription.plan · Department incl. scopes · AiEmployee
 * role/status/archivedAt · InstalledSkill skillKey/connectionStatus/enabled ·
 * WorkflowTemplate), add it here and to the hook.
 */

const WEB_SRC = join(__dirname, '..', '..', '..');

/** Hooks that write a product-context input, by file. */
const MUST_INVALIDATE: Readonly<Record<string, readonly string[]>> = {
  'features/employees/hooks.ts': [
    'useCreateEmployee', // AiEmployee row appears -> seats, area unlocks
    'useUpdateEmployee', // status: DISABLED frees a seat, PAUSED keeps it
    'useDeleteEmployee', // archivedAt -> row leaves the resolver's filter
  ],
  'features/marketplace/hooks.ts': [
    'useInstallEmployeeTemplate', // hires a real AiEmployee
  ],
  'features/billing/hooks.ts': [
    'useChangePlan', // Subscription.plan -> seats, lockedAreas, ASSIST gate
  ],
  'features/skills/hooks.ts': [
    'useInstallSkill',
    'useUpdateInstalledSkill', // `enabled` — the resolver filters enabled: true
    'useUninstallSkill',
    'useConnectSkill',
    'useDisconnectSkill',
    'useVerifyConnection', // a pass/fail changes connectionStatus server-side
    'useCheckConnectorHealth', // can transition DEGRADED <-> CONNECTED
  ],
  'features/onboarding/hooks.ts': [
    'useSaveOnboardingCompany', // industry, size
    'useSaveOnboardingGoals', // businessGoals
    'useSaveOnboardingDepartments', // real Department rows
    'useCompleteOnboarding', // hires + onboardedAt + departments in one call
  ],
  'features/organization/hooks.ts': [
    'useCreateDepartment',
    'useUpdateDepartment', // name AND scopes (DepartmentScopeEditor writes here)
    'useDeleteDepartment',
  ],
  'features/tenant/hooks.ts': [
    'useUpdateCompany', // industry, size, businessGoals
  ],
  'features/users/hooks.ts': [
    'useUpdateUser', // role/departmentId/teamId resolve the authz actor
    'useDeleteUser',
  ],
};

/** Source of one exported hook: from its `export function` to the next one. */
function hookBody(source: string, hookName: string): string {
  const start = source.indexOf(`export function ${hookName}(`);
  if (start === -1) return '';
  const next = source.indexOf('\nexport function ', start + 1);
  return source.slice(start, next === -1 ? undefined : next);
}

describe('product-context cache invalidation', () => {
  for (const [relPath, hooks] of Object.entries(MUST_INVALIDATE)) {
    describe(relPath, () => {
      const source = readFileSync(join(WEB_SRC, relPath), 'utf8');

      it('imports the product-context key factory', () => {
        expect(source).toContain(
          "import { productContextKeys } from '@/features/product-context/hooks'",
        );
      });

      for (const hook of hooks) {
        it(`${hook} invalidates productContextKeys.all`, () => {
          const body = hookBody(source, hook);
          // Guards against the hook being renamed or removed without this list
          // being updated — an empty body would otherwise pass vacuously.
          expect(body, `${hook} not found in ${relPath}`).not.toBe('');
          expect(body).toContain('productContextKeys.all');
        });
      }
    });
  }

  it('the OAuth return path invalidates it too', () => {
    // Not a hook: the callback already wrote connectionStatus: CONNECTED
    // server-side, so the page effect that handles ?connected= must refresh it.
    const source = readFileSync(
      join(WEB_SRC, 'app', '(app)', 'skills', 'page.tsx'),
      'utf8',
    );
    expect(source).toContain('productContextKeys.all');
  });

  it('useProductContext still sets a staleTime, so this matters', () => {
    // If someone drops staleTime to 0 the invalidation stops being load-bearing
    // and this whole guard can be reconsidered. Until then it is required.
    const source = readFileSync(
      join(WEB_SRC, 'features', 'product-context', 'hooks.ts'),
      'utf8',
    );
    expect(source).toMatch(/staleTime:\s*60_000/);
  });
});
