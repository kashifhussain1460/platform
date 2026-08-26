'use client';

import Link from 'next/link';
import type { DashboardWidgetDto, WidgetMetricDto } from '@vaep/types';
import { useDashboardComposition } from './hooks';

/**
 * The capability-driven dashboard.
 *
 * Which widgets exist is decided entirely server-side, by the SAME resolver the
 * navigation uses. This component renders whatever it is given — it holds no
 * rule about which company sees what, which is the point: before Phase 4 the
 * dashboard was six fixed tiles that looked identical for a recruitment agency
 * and a marketing team.
 *
 * Adding a widget is a new `kind` plus one aggregate query on the server. It
 * requires no change here.
 */
function Metric({ metric }: { metric: WidgetMetricDto }) {
  const body = (
    <>
      <span
        className={`block text-2xl font-semibold ${
          metric.attention && metric.value > 0 ? 'text-sl-warning' : 'text-app-ink'
        }`}
      >
        {metric.value}
      </span>
      <span className="mt-0.5 block text-xs text-app-ink-3">{metric.label}</span>
    </>
  );

  // A metric that links to the screen it came from is a metric someone can act
  // on. One that does not is a number on a wall.
  return metric.href ? (
    <Link
      href={metric.href}
      className="rounded-xl border border-app-border bg-app-surface p-4 transition-colors hover:border-app-border-strong hover:bg-app-raised"
    >
      {body}
    </Link>
  ) : (
    <div className="rounded-xl border border-app-border bg-app-surface p-4">{body}</div>
  );
}

function Widget({ widget }: { widget: DashboardWidgetDto }) {
  return (
    <section className="space-y-3">
      <h2 className="text-sm font-medium text-app-ink-2">{widget.title}</h2>

      {/*
        The empty state (§5). A relevant area with no data yet gets the NEXT
        STEP, not a row of zeroes — "your Marketing AI Employee is ready,
        connect a social account" tells someone what to do; "0 0 0 0" tells them
        the product is broken.
      */}
      {widget.setupHint ? (
        <div className="rounded-xl border border-violet/30 bg-violet/[0.06] p-4">
          <p className="text-sm text-app-ink">{widget.setupHint.message}</p>
          <Link
            href={widget.setupHint.ctaHref}
            className="mt-3 inline-flex rounded-lg bg-[linear-gradient(135deg,#6a30ec_0%,#5216dd_100%)] px-4 py-2 text-sm font-semibold text-white transition-all hover:-translate-y-0.5"
          >
            {widget.setupHint.ctaLabel}
          </Link>
        </div>
      ) : (
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
          {widget.metrics.map((m) => (
            <Metric key={m.label} metric={m} />
          ))}
        </div>
      )}
    </section>
  );
}

export function DashboardWidgets() {
  const { data, isLoading, isError, error } = useDashboardComposition();

  if (isLoading) {
    return <p className="text-sm text-app-ink-3">Loading your dashboard…</p>;
  }
  if (isError) {
    return (
      <p className="text-sm text-red-600">
        {error?.message ?? 'Could not load your dashboard'}
      </p>
    );
  }

  return (
    <div className="space-y-8">
      {(data?.widgets ?? []).map((w) => (
        <Widget key={w.kind} widget={w} />
      ))}
    </div>
  );
}
