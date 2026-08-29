'use client';

import { useEffect } from 'react';
import { useParams, useRouter } from 'next/navigation';
import Link from 'next/link';
import { AppShell } from '@/components/app-shell/AppShell';
import { useAppShellProps } from '@/components/app-shell/useAppShellProps';
import { CampaignCalendar } from '@/features/marketing/components/CampaignCalendar';
import { useCampaignDetail } from '@/features/marketing/hooks';
import { useSessionStore } from '@/stores/session.store';

/**
 * One campaign: what the AI planned, how far it has got, and every post with
 * its options (§33/§58/§75).
 *
 * Partial results are shown as they arrive rather than a spinner until the end
 * (§34/§75) — a 21-post campaign takes minutes, and a blank screen for that long
 * reads as broken.
 */
export default function CampaignPage() {
  const router = useRouter();
  const params = useParams<{ id: string }>();
  const accessToken = useSessionStore((s) => s.accessToken);
  const shellProps = useAppShellProps();
  const { data, isLoading, isError, error } = useCampaignDetail(params.id);

  useEffect(() => {
    if (!accessToken) router.replace('/login');
  }, [accessToken, router]);

  if (!accessToken) return null;

  return (
    <AppShell {...shellProps}>
      <header className="mb-6 pt-2">
        <Link
          href="/marketing"
          className="text-sm text-app-ink-3 transition-colors hover:text-app-ink"
        >
          ← Marketing
        </Link>
        <h1 className="mt-1 text-2xl font-bold text-app-ink">
          {data?.name ?? 'Campaign'}
        </h1>
        {data?.objective && <p className="mt-1 text-sm text-app-ink-2">{data.objective}</p>}
      </header>

      {isLoading ? (
        <p className="text-sm text-app-ink-3">Loading…</p>
      ) : isError ? (
        <p className="text-sm text-red-600">
          {error?.message ?? 'Could not load this campaign'}
        </p>
      ) : data ? (
        <div className="space-y-6">
          {/* Progress. Named steps rather than a bare percentage, so somebody
              waiting can tell what is actually happening (§75). */}
          <section className="rounded-2xl border border-app-border bg-app-surface p-4">
            <div className="flex flex-wrap items-center justify-between gap-3">
              <p className="text-sm font-medium text-app-ink">
                {data.generation.detail}
              </p>
              {data.generation.inProgress && (
                <span className="text-xs text-app-ink-3">Updating automatically…</span>
              )}
            </div>

            {data.generation.totalItems > 0 && (
              <div className="mt-3">
                <div className="h-1.5 w-full overflow-hidden rounded-full bg-app-raised">
                  <div
                    className="h-full rounded-full bg-violet transition-all"
                    style={{
                      width: `${Math.round(
                        (data.generation.itemsWithOptions / data.generation.totalItems) * 100,
                      )}%`,
                    }}
                  />
                </div>
                <p className="mt-1.5 text-xs text-app-ink-3">
                  {data.generation.itemsWithOptions} of {data.generation.totalItems} posts written
                </p>
              </div>
            )}

            {data.generation.error && (
              <p className="mt-3 rounded-lg bg-status-failed/10 px-3 py-2 text-sm text-sl-failed">
                {data.generation.error}
              </p>
            )}
          </section>

          {/* What the AI derived from the brief, so it can be checked rather
              than taken on trust. */}
          <section className="rounded-2xl border border-app-border bg-app-surface p-4">
            <h2 className="text-sm font-semibold text-app-ink">What we understood</h2>
            <dl className="mt-3 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
              <div>
                <dt className="text-xs text-app-ink-3">Posting</dt>
                <dd className="text-sm text-app-ink">
                  {data.postsPerDayMax ? `${data.postsPerDayMax} a day` : 'Not set'}
                </dd>
              </div>
              <div>
                <dt className="text-xs text-app-ink-3">Platforms</dt>
                <dd className="text-sm capitalize text-app-ink">
                  {data.platforms.length ? data.platforms.join(', ') : 'None chosen'}
                </dd>
              </div>
              <div>
                <dt className="text-xs text-app-ink-3">Timezone</dt>
                <dd className="text-sm text-app-ink">{data.timezone}</dd>
              </div>
              <div>
                <dt className="text-xs text-app-ink-3">Approval</dt>
                <dd className="text-sm text-app-ink">
                  {data.approvalRequired ? 'Required before publishing' : 'Not required'}
                </dd>
              </div>
            </dl>
            {data.contentPillars.length > 0 && (
              <p className="mt-3 text-xs text-app-ink-3">
                Themes: {data.contentPillars.join(' · ')}
              </p>
            )}
            {data.brief && (
              <p className="mt-3 border-t border-app-border pt-3 text-xs italic text-app-ink-3">
                “{data.brief}”
              </p>
            )}
          </section>

          <CampaignCalendar campaign={data} />
        </div>
      ) : null}
    </AppShell>
  );
}
