'use client';

import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import Link from 'next/link';
import { AppShell } from '@/components/app-shell/AppShell';
import { useAppShellProps } from '@/components/app-shell/useAppShellProps';
import { LeaveQueue } from '@/features/hr/components/LeaveQueue';
import { OnboardingTasks } from '@/features/hr/components/OnboardingTasks';
import { StaffRoster } from '@/features/hr/components/StaffRoster';
import { useCanManageHr, useLeave, useOnboardingTasks, useStaff } from '@/features/hr/hooks';
import { useSessionStore } from '@/stores/session.store';

type HrTab = 'people' | 'leave' | 'onboarding';

/**
 * The HR domain's front door.
 *
 * ## Why this page is new
 *
 * `modules/hr` shipped in Wave P3-01: six models, special-category PII
 * encrypted at rest, a daily retention sweep, 20 routes, e2e coverage. The
 * 2026-09-02 audit found `apps/web/src/features/` had no `hr` folder at all —
 * the largest fully-built, completely unreachable domain in the product. The
 * dashboard counted its rows and had nowhere to send anyone.
 *
 * ## Scope, stated plainly
 *
 * People, time off and onboarding tasks — the three the dashboard's HR widget
 * counts, so every number on it now leads somewhere. Documents, performance
 * reviews and attendance have working endpoints and are deliberately NOT here:
 * a half-built tab is worse than an honest absence, and they are listed in the
 * audit's remaining work.
 *
 * ## Access
 *
 * OWNER/ADMIN only, reads included — stricter than every other page, because
 * staff records carry special-category personal data. The server enforces it
 * (a MEMBER gets 403 from the API directly, which the browser security journey
 * asserts); this page refuses to render the tabs rather than showing a MEMBER
 * three panels that will only fail.
 */
export default function HrPage() {
  const router = useRouter();
  const accessToken = useSessionStore((s) => s.accessToken);
  const canManage = useCanManageHr();
  const shellProps = useAppShellProps();
  const [tab, setTab] = useState<HrTab>('people');
  /** Set from the roster to narrow leave + tasks to one person. */
  const [staffId, setStaffId] = useState<string | null>(null);

  const { data: staff } = useStaff();
  const { data: leave } = useLeave();
  const { data: tasks } = useOnboardingTasks();

  useEffect(() => {
    if (!accessToken) router.replace('/login');
  }, [accessToken, router]);

  if (!accessToken) return null;

  if (!canManage) {
    return (
      <AppShell {...shellProps}>
        <div className="mb-8 pt-2">
          <h1 className="text-2xl font-bold text-app-ink">People</h1>
        </div>
        <div className="rounded-2xl border border-app-border bg-app-surface p-6">
          <p className="text-sm text-app-ink-2">
            Staff records are only visible to owners and admins.
          </p>
          <p className="mt-1 text-xs text-app-ink-3">
            They contain personal information — home contact details, time-off
            reasons — so access is deliberately narrower than the rest of Orlixa.
            Ask an owner if you need it.
          </p>
        </div>
      </AppShell>
    );
  }

  const pendingLeave = (leave ?? []).filter((l) => l.status === 'PENDING').length;
  const openTasks = (tasks ?? []).filter((t) => !t.completedAt).length;

  const TABS: { key: HrTab; label: string }[] = [
    { key: 'people', label: `People (${staff?.length ?? 0})` },
    { key: 'leave', label: pendingLeave > 0 ? `Time off (${pendingLeave})` : 'Time off' },
    {
      key: 'onboarding',
      label: openTasks > 0 ? `Onboarding (${openTasks})` : 'Onboarding',
    },
  ];

  const selectedName = staff?.find((s) => s.id === staffId)?.fullName;

  return (
    <AppShell {...shellProps}>
      <div className="mb-6 pt-2">
        <p className="text-sm text-app-ink-3">HR</p>
        <h1 className="text-2xl font-bold text-app-ink">People</h1>
        <p className="mt-1 text-sm text-app-ink-2">
          Your staff records, their time off, and what still has to happen for new
          starters. Your HR AI Employee works from the same data.
        </p>
      </div>

      <div className="mb-6 flex flex-wrap items-center gap-2">
        {TABS.map((t) => (
          <button
            key={t.key}
            onClick={() => setTab(t.key)}
            className={`rounded-xl px-4 py-2 text-sm font-medium transition-colors ${
              tab === t.key
                ? 'bg-violet text-white'
                : 'border border-app-border text-app-ink-2 hover:text-app-ink'
            }`}
          >
            {t.label}
          </button>
        ))}
        <Link
          href="/scheduling"
          className="ml-auto text-sm font-medium text-app-ink-2 transition-colors hover:text-app-ink"
        >
          Interview scheduling →
        </Link>
      </div>

      {/* The roster's "view their items" sets this filter; say so, and give a
          way out, or a filtered empty list reads as missing data. */}
      {staffId && tab !== 'people' && (
        <div className="mb-4 flex items-center justify-between gap-3 rounded-xl border border-app-border bg-app-surface px-4 py-2">
          <p className="text-sm text-app-ink-2">
            Showing only {selectedName ?? 'one person'}.
          </p>
          <button
            type="button"
            onClick={() => setStaffId(null)}
            className="text-sm font-medium text-violet hover:text-app-ink"
          >
            Show everyone
          </button>
        </div>
      )}

      {tab === 'people' && (
        <StaffRoster
          selectedId={staffId}
          onSelect={(id) => {
            setStaffId(id);
            // Selecting a person is only useful if it takes you to their items.
            if (id) setTab('leave');
          }}
        />
      )}
      {tab === 'leave' && <LeaveQueue staffId={staffId} />}
      {tab === 'onboarding' && <OnboardingTasks staffId={staffId} />}
    </AppShell>
  );
}
