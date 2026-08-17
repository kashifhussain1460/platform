/** A clean KPI stat tile: label + big number + optional helper/"est." hint. */
export function StatTile({
  label,
  value,
  helper,
  estimate = false,
}: {
  label: string;
  value: string;
  helper?: string;
  /** Marks the number as an illustrative estimate. */
  estimate?: boolean;
}) {
  return (
    <div className="rounded-2xl border border-app-border bg-app-surface p-5 transition-colors hover:border-app-border-strong">
      <div className="flex items-center justify-between">
        <p className="text-sm font-medium text-app-ink-2">{label}</p>
        {estimate && (
          <span
            title="Illustrative estimate"
            className="rounded-full bg-app-raised px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-app-ink-3"
          >
            est.
          </span>
        )}
      </div>
      <p className="mt-2 text-3xl font-bold text-app-ink">{value}</p>
      {helper && <p className="mt-1 text-xs text-app-ink-3">{helper}</p>}
    </div>
  );
}
