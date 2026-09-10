import Link from 'next/link';
import type { EmployeeReadinessDto } from '@vaep/types';
import { ReadinessBadge } from './ReadinessBadge';

const CHECK_LABEL: Record<string, string> = {
  STATUS: 'Status',
  SKILLS: 'Skills',
  CONNECTIONS: 'Connections',
  KNOWLEDGE: 'Knowledge',
  WORKFLOWS: 'Workflows',
};

/**
 * The setup checklist for the employee detail Overview tab — the surface that
 * answers "what does this AI Employee actually do, and is it actually ready?"
 * instead of just showing a green/amber/grey status pill.
 *
 * All-PASS renders nothing beyond the badge: an employee with no gaps doesn't
 * need a checklist explaining that it has none.
 */
export function ReadinessPanel({
  readiness,
  onOpenTab,
}: {
  readiness: EmployeeReadinessDto;
  /**
   * The detail page's tab is local `useState`, not URL-driven, so a fix
   * pointing at "the Tools tab" or "the Knowledge tab" has to switch it
   * in-place rather than navigate — a `Link` with `?tab=` would silently do
   * nothing, which is worse than no link at all.
   */
  onOpenTab: (tab: 'tools' | 'knowledge') => void;
}) {
  if (readiness.setupState === 'READY') {
    return (
      <div className="rounded-2xl border border-app-border bg-app-surface p-5">
        <div className="flex items-center justify-between">
          <h2 className="text-sm font-medium text-app-ink">Setup</h2>
          <ReadinessBadge setupState={readiness.setupState} />
        </div>
        <p className="mt-2 text-sm text-app-ink-2">
          Everything this employee needs is in place.
        </p>
      </div>
    );
  }

  return (
    <div className="rounded-2xl border border-app-border bg-app-surface p-5">
      <div className="flex items-center justify-between">
        <h2 className="text-sm font-medium text-app-ink">Setup</h2>
        <ReadinessBadge setupState={readiness.setupState} />
      </div>

      <ul className="mt-4 space-y-1.5 text-xs text-app-ink-3">
        {readiness.checks.map((check) => (
          <li key={check.key} className="flex items-center gap-2">
            <span
              className={
                check.status === 'PASS'
                  ? 'text-sl-active'
                  : check.status === 'FAIL'
                    ? 'text-sl-failed'
                    : 'text-sl-warning'
              }
            >
              {check.status === 'PASS' ? '✓' : check.status === 'FAIL' ? '✗' : '!'}
            </span>
            {CHECK_LABEL[check.key] ?? check.key}
          </li>
        ))}
      </ul>

      {readiness.issues.length > 0 && (
        <ul className="mt-4 space-y-2 border-t border-app-border pt-4">
          {readiness.issues.map((issue) => (
            <li
              key={issue.code}
              className={`text-sm ${issue.severity === 'BLOCKER' ? 'text-sl-failed' : 'text-sl-warning'}`}
            >
              <span>{issue.message}</span>{' '}
              {issue.code === 'SKILL_NOT_CONNECTED' && (
                <Link
                  href="/skills"
                  className="font-medium underline hover:no-underline"
                >
                  Connect it
                </Link>
              )}
              {issue.code === 'NO_SKILLS_ASSIGNED' && (
                <button
                  type="button"
                  onClick={() => onOpenTab('tools')}
                  className="font-medium underline hover:no-underline"
                >
                  Add a skill
                </button>
              )}
              {issue.code === 'NO_KNOWLEDGE' && (
                <button
                  type="button"
                  onClick={() => onOpenTab('knowledge')}
                  className="font-medium underline hover:no-underline"
                >
                  Upload a document
                </button>
              )}
              {(issue.code === 'NO_WORKFLOWS' ||
                issue.code === 'NO_ACTIVE_WORKFLOWS') && (
                <Link
                  href="/workflows"
                  className="font-medium underline hover:no-underline"
                >
                  Go to workflows
                </Link>
              )}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
