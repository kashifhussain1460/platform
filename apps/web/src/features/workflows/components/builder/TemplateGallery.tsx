'use client';

import { useMemo, useState } from 'react';
import { useRouter } from 'next/navigation';
import type { WorkflowTemplateSummaryDto } from '@vaep/types';
import { useWorkflowTemplates } from '../../hooks';
import { EmptyState } from './EmptyState';
import { TemplateInstallForm } from './TemplateInstallForm';

/**
 * TemplateGallery — browse the installable workflow templates and set one up
 * (doc 29 §3.A). Grouped by category; picking a template opens its install form
 * (parameters + prerequisites). On install the new DRAFT workflow opens in the
 * builder. Dark-surface tokens throughout.
 */
export function TemplateGallery() {
  const { data, isLoading, isError, error } = useWorkflowTemplates();
  const [selected, setSelected] = useState<WorkflowTemplateSummaryDto | null>(null);
  const router = useRouter();

  const grouped = useMemo(() => {
    const by = new Map<string, WorkflowTemplateSummaryDto[]>();
    for (const t of data ?? []) {
      const list = by.get(t.category) ?? [];
      list.push(t);
      by.set(t.category, list);
    }
    return [...by.entries()].sort((a, b) => a[0].localeCompare(b[0]));
  }, [data]);

  if (isLoading) {
    return (
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3" aria-busy="true">
        {Array.from({ length: 6 }).map((_, i) => (
          <div key={i} className="h-28 animate-pulse rounded-xl border border-app-border bg-app-surface" />
        ))}
      </div>
    );
  }

  if (isError) {
    return (
      <EmptyState
        title="Couldn't load templates"
        body={error.message}
        size="page"
      />
    );
  }

  if (!data || data.length === 0) {
    return (
      <EmptyState
        title="No templates yet"
        body="Templates are pre-built workflows for your AI Employees. Once some are published they'll appear here to install in one step."
        size="page"
      />
    );
  }

  return (
    <div className="grid gap-6 lg:grid-cols-[1fr_380px]">
      <div className="flex flex-col gap-6">
        {grouped.map(([category, templates]) => (
          <section key={category}>
            <h2 className="mb-2 font-display text-xs font-semibold uppercase tracking-wider text-app-ink-3">
              {category}
            </h2>
            <div className="grid gap-3 sm:grid-cols-2">
              {templates.map((t) => (
                <TemplateCard
                  key={t.id}
                  template={t}
                  selected={selected?.id === t.id}
                  onSelect={() => setSelected(t)}
                />
              ))}
            </div>
          </section>
        ))}
      </div>

      <aside className="lg:sticky lg:top-4 lg:h-fit">
        <div className="rounded-xl border border-app-border bg-app-raised p-5">
          {selected ? (
            <TemplateInstallForm
              key={selected.id}
              template={selected}
              onInstalled={(id) => router.push(`/workflows/${id}`)}
              onCancel={() => setSelected(null)}
            />
          ) : (
            <EmptyState
              title="Pick a template"
              body="Choose one on the left to see what it does and set it up."
            />
          )}
        </div>
      </aside>
    </div>
  );
}

function TemplateCard({
  template,
  selected,
  onSelect,
}: {
  template: WorkflowTemplateSummaryDto;
  selected: boolean;
  onSelect: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onSelect}
      aria-pressed={selected}
      className={[
        'flex flex-col gap-1.5 rounded-xl border p-4 text-left transition-colors',
        selected
          ? 'border-violet-secondary bg-violet/10'
          : 'border-app-border bg-app-surface hover:border-app-border-strong hover:bg-app-raised',
      ].join(' ')}
    >
      <span className="font-display text-sm font-semibold text-app-ink">{template.name}</span>
      {template.description ? (
        <span className="line-clamp-2 text-xs text-app-ink-2">{template.description}</span>
      ) : null}
      <span className="mt-1 flex flex-wrap gap-1.5">
        {template.requires.employeeRoles.map((r) => (
          <Chip key={r} tone="cat-employee">
            {r}
          </Chip>
        ))}
        {template.requires.skills.map((s) => (
          <Chip key={s} tone="cat-tool">
            {s}
          </Chip>
        ))}
        {template.requires.minPlan ? (
          <Chip tone="cat-approval">{template.requires.minPlan}</Chip>
        ) : null}
      </span>
    </button>
  );
}

// Static, literal class strings so Tailwind's JIT actually generates them
// (runtime-built `border-${tone}` names get purged and render colourless).
const CHIP_TONES: Record<string, string> = {
  'cat-employee': 'border-cat-employee/40 bg-cat-employee/10 text-violet',
  'cat-tool': 'border-cat-tool/40 bg-cat-tool/10 text-teal-700',
  'cat-approval': 'border-cat-approval/40 bg-cat-approval/10 text-sl-waiting',
};

function Chip({
  children,
  tone,
}: {
  children: React.ReactNode;
  tone: keyof typeof CHIP_TONES;
}) {
  return (
    <span
      className={`rounded-full border px-2 py-0.5 text-[10px] font-medium uppercase tracking-wide ${CHIP_TONES[tone]}`}
    >
      {children}
    </span>
  );
}
