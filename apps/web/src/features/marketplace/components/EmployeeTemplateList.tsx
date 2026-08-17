'use client';

import { useState } from 'react';
import Link from 'next/link';
import { Search } from 'lucide-react';
import type { AiEmployeeDto, EmployeeTemplateDto } from '@vaep/types';
import { Button } from '@/components/ui/Button';
import { useInstallEmployeeTemplate, useMarketplace } from '../hooks';
import { ROLE_STYLES, categoryBadgeClass, categoryIcon, formatRole } from '../labels';

/** One template card with an optional name field + Install (optimistic). */
function EmployeeTemplateCard({ template }: { template: EmployeeTemplateDto }) {
  const install = useInstallEmployeeTemplate();
  const [name, setName] = useState('');
  const [created, setCreated] = useState<AiEmployeeDto | null>(null);

  const onInstall = () => {
    install.mutate(
      { key: template.key, data: { name: name.trim() || undefined }, name: template.name },
      { onSuccess: (employee) => setCreated(employee) },
    );
  };

  const Icon = categoryIcon(template.category);

  return (
    <li className="rounded-2xl border border-app-border bg-app-surface p-5 transition-colors hover:border-app-border-strong">
      <div className="flex items-start gap-3">
        <span
          className={`flex h-11 w-11 shrink-0 items-center justify-center rounded-xl ${categoryBadgeClass(template.category)}`}
        >
          <Icon className="h-5 w-5" strokeWidth={2} />
        </span>
        <div className="min-w-0 flex-1">
          <p className="font-bold text-app-ink">{template.name}</p>
          <div className="mt-1 flex flex-wrap items-center gap-1.5">
            <span
              className={`inline-block rounded-full px-2 py-0.5 text-xs font-medium ${ROLE_STYLES[template.role]}`}
            >
              {formatRole(template.role)}
            </span>
            <span className="text-xs text-app-ink-3">{template.category}</span>
          </div>
        </div>
      </div>

      <p className="mt-3 text-sm text-app-ink-2">{template.description}</p>
      {template.suggestedSkills.length > 0 && (
        <p className="mt-2 text-xs text-app-ink-3">
          Suggested skills: {template.suggestedSkills.join(', ')}
        </p>
      )}

      <div className="mt-4 flex items-center gap-2">
        <input
          type="text"
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder={template.name}
          className="field-modern w-auto flex-1"
        />
        <Button variant="violet" onClick={onInstall} disabled={install.isPending}>
          {install.isPending ? 'Hiring…' : 'Install'}
        </Button>
      </div>

      {created && !created.id.startsWith('temp_') && (
        <p className="mt-3 text-xs text-green-700">
          Hired {created.name}.{' '}
          <Link
            href={`/employees/${created.id}`}
            className="font-medium text-violet underline hover:text-app-ink"
          >
            Open employee →
          </Link>
        </p>
      )}
    </li>
  );
}

/** AI Employee templates section: search + category filter + template grid. */
export function EmployeeTemplateList() {
  const { data, isLoading } = useMarketplace();
  const [query, setQuery] = useState('');
  const [category, setCategory] = useState('All');

  if (isLoading) {
    return <p className="text-sm text-app-ink-3">Loading templates…</p>;
  }

  const employees = data?.employees ?? [];
  const categories = ['All', ...Array.from(new Set(employees.map((t) => t.category)))];
  const q = query.trim().toLowerCase();
  const filtered = employees.filter((t) => {
    const matchesCategory = category === 'All' || t.category === category;
    const matchesQuery =
      q.length === 0 ||
      t.name.toLowerCase().includes(q) ||
      t.description.toLowerCase().includes(q);
    return matchesCategory && matchesQuery;
  });

  return (
    <div>
      <div className="relative">
        <Search className="pointer-events-none absolute left-3.5 top-1/2 h-4 w-4 -translate-y-1/2 text-app-ink-3" />
        <input
          type="text"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Search AI employees..."
          aria-label="Search AI employees"
          className="field-modern"
          style={{ paddingLeft: '2.5rem' }}
        />
      </div>

      <div className="mt-4 flex flex-wrap gap-2">
        {categories.map((c) => (
          <button
            key={c}
            type="button"
            onClick={() => setCategory(c)}
            className={`rounded-full px-3.5 py-1.5 text-xs font-medium transition-colors ${
              category === c
                ? 'bg-violet text-white'
                : 'border border-app-border text-app-ink-2 hover:text-app-ink'
            }`}
          >
            {c}
          </button>
        ))}
      </div>

      {filtered.length === 0 ? (
        <p className="mt-6 text-sm text-app-ink-3">
          {employees.length === 0 ? 'No templates available.' : 'No templates match your search.'}
        </p>
      ) : (
        <ul className="mt-5 grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {filtered.map((template) => (
            <EmployeeTemplateCard key={template.key} template={template} />
          ))}
        </ul>
      )}
    </div>
  );
}
