'use client';

import { zodResolver } from '@hookform/resolvers/zod';
import { Search } from 'lucide-react';
import { useForm } from 'react-hook-form';
import { Button } from '@/components/ui/Button';
import { useSearchKnowledge } from '../hooks';
import { searchSchema, type SearchQueryDto } from '../schemas';

export function SearchPanel() {
  const search = useSearchKnowledge();
  const {
    register,
    handleSubmit,
    formState: { errors },
  } = useForm<SearchQueryDto>({
    resolver: zodResolver(searchSchema),
    defaultValues: { query: '' },
  });

  const onSubmit = handleSubmit((values) => {
    search.mutate({ query: values.query });
  });

  const results = search.data;

  return (
    <section className="rounded-2xl border border-app-border bg-app-surface p-5 transition-colors hover:border-app-border-strong">
      <h2 className="mb-3 text-sm font-medium text-app-ink-2">
        Search knowledge base
      </h2>
      <form onSubmit={onSubmit} className="flex gap-2" noValidate>
        <div className="relative min-w-0 flex-1">
          <Search className="pointer-events-none absolute left-3.5 top-1/2 h-4 w-4 -translate-y-1/2 text-app-ink-3" />
          <input
            type="text"
            placeholder="Ask a question…"
            className="field-modern"
            style={{ paddingLeft: '2.5rem' }}
            {...register('query')}
          />
        </div>
        <Button type="submit" variant="violet" disabled={search.isPending}>
          {search.isPending ? 'Searching…' : 'Search'}
        </Button>
      </form>
      {errors.query && (
        <p className="mt-1 text-sm text-red-600">{errors.query.message}</p>
      )}
      {search.isError && (
        <p className="mt-2 text-sm text-red-600">
          {search.error?.message ?? 'Search failed'}
        </p>
      )}

      {results && (
        <div className="mt-4 space-y-3">
          {results.length === 0 ? (
            <p className="text-sm text-app-ink-3">No matches found.</p>
          ) : (
            results.map((r) => (
              <div
                key={r.chunkId}
                className="rounded-xl border border-app-border bg-app-surface p-3"
              >
                <div className="mb-1 flex items-center justify-between">
                  <span className="text-xs font-medium text-app-ink-3">
                    doc {r.documentId.slice(0, 8)}
                  </span>
                  <span className="text-xs font-medium text-violet">
                    {(r.score * 100).toFixed(1)}%
                  </span>
                </div>
                <p className="text-sm text-app-ink-2">{r.content}</p>
              </div>
            ))
          )}
        </div>
      )}
    </section>
  );
}
