'use client';

import { useMemo, useState } from 'react';
import Link from 'next/link';
import { ArrowRight, Search } from 'lucide-react';
import { cn } from '@/lib/utils';
import { FadeIn } from './FadeIn';
import type { IntegrationDefinition } from '@/features/marketing/integrations';

export function IntegrationsBrowser({ integrations }: { integrations: IntegrationDefinition[] }) {
  const categories = useMemo(() => Array.from(new Set(integrations.map((i) => i.category))), [integrations]);
  const [query, setQuery] = useState('');
  const [category, setCategory] = useState<string | null>(null);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    return integrations.filter((i) => {
      const matchesCategory = category == null || i.category === category;
      const matchesQuery = q === '' || i.name.toLowerCase().includes(q) || i.description.toLowerCase().includes(q);
      return matchesCategory && matchesQuery;
    });
  }, [integrations, query, category]);

  return (
    <div>
      <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
        <div className="relative w-full sm:max-w-xs">
          <Search className="pointer-events-none absolute left-3.5 top-1/2 h-4 w-4 -translate-y-1/2 text-fg-muted" aria-hidden />
          <input
            type="search"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search integrations…"
            aria-label="Search integrations"
            className="field-modern field-with-icon"
          />
        </div>

        <div className="flex flex-wrap gap-2" role="group" aria-label="Filter by category">
          <button
            type="button"
            onClick={() => setCategory(null)}
            aria-pressed={category == null}
            className={cn(
              'rounded-full border px-3.5 py-1.5 text-sm font-medium transition-colors',
              category == null
                ? 'border-violet/60 bg-violet/15 text-white'
                : 'border-white/[0.1] text-zinc-400 hover:text-white',
            )}
          >
            All
          </button>
          {categories.map((c) => (
            <button
              key={c}
              type="button"
              onClick={() => setCategory(c)}
              aria-pressed={category === c}
              className={cn(
                'rounded-full border px-3.5 py-1.5 text-sm font-medium transition-colors',
                category === c
                  ? 'border-violet/60 bg-violet/15 text-white'
                  : 'border-white/[0.1] text-zinc-400 hover:text-white',
              )}
            >
              {c}
            </button>
          ))}
        </div>
      </div>

      {filtered.length === 0 ? (
        <p className="mt-12 text-center text-sm text-fg-muted">
          No integrations match &ldquo;{query}&rdquo;. Try a different search or category.
        </p>
      ) : (
        <div className="mt-10 grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
          {filtered.map((integration, i) => (
            <FadeIn key={integration.slug} delay={(i % 8) * 0.05}>
              <Link
                href={`/integrations/${integration.slug}`}
                className="group flex h-full flex-col rounded-xl border border-white/[0.08] bg-void-card p-5 transition-colors hover:border-violet/40"
              >
                <span className="text-xs font-semibold uppercase tracking-[0.1em] text-violet-secondary">
                  {integration.category}
                </span>
                <p className="mt-2 text-[15px] font-semibold text-white">{integration.name}</p>
                <p className="mt-1.5 text-sm text-fg-muted">{integration.description}</p>
                <span className="mt-4 inline-flex items-center gap-1.5 text-sm font-medium text-violet-secondary group-hover:text-white">
                  View details <ArrowRight className="h-3.5 w-3.5" aria-hidden />
                </span>
              </Link>
            </FadeIn>
          ))}
        </div>
      )}
    </div>
  );
}
