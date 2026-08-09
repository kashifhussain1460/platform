'use client';

import { useMemo, useState } from 'react';
import { Search } from 'lucide-react';
import type { NodeCategory, NodeDefinitionDto, NodeType } from '@vaep/types';
import { NODE_ICONS } from '../../../labels';
import { NODE_CATEGORY_META, NODE_CATEGORY_ORDER } from '../../../nodeMeta';

// NOTIFY + NOOP are intentionally not offered in the palette (doc 29 §3 note).
const HIDDEN_TYPES = new Set<NodeType>(['NOTIFY', 'NOOP']);

export interface NodeLibraryProps {
  defs: NodeDefinitionDto[];
  onAdd: (type: NodeType) => void;
  disabled?: boolean;
}

/**
 * NodeLibrary — the add-a-step palette (doc 29 §3.C). Registry-driven: lists the
 * node types from `GET /workflows/node-definitions`, grouped by category in the
 * canonical order (AI Employees + human gates lead; machinery trails). Clicking
 * one drops a pre-configured node onto the canvas.
 */
export function NodeLibrary({ defs, onAdd, disabled }: NodeLibraryProps) {
  const [query, setQuery] = useState('');

  const grouped = useMemo(() => {
    const q = query.trim().toLowerCase();
    const byCategory = new Map<NodeCategory, NodeDefinitionDto[]>();
    for (const def of defs) {
      if (HIDDEN_TYPES.has(def.type)) continue;
      // Match on the human label, the description, and the raw type so a search
      // for "condition", "branch" or "CONDITION" all land.
      if (
        q &&
        !def.label.toLowerCase().includes(q) &&
        !def.type.toLowerCase().includes(q) &&
        !(def.description ?? '').toLowerCase().includes(q)
      ) {
        continue;
      }
      const list = byCategory.get(def.category) ?? [];
      list.push(def);
      byCategory.set(def.category, list);
    }
    return NODE_CATEGORY_ORDER.filter((c) => byCategory.has(c)).map((category) => ({
      category,
      items: byCategory.get(category)!.sort((a, b) => a.label.localeCompare(b.label)),
    }));
  }, [defs, query]);

  return (
    <div className="flex max-h-[72vh] w-52 shrink-0 flex-col overflow-y-auto rounded-2xl border border-wf-hairline bg-void-card p-3">
      <p className="mb-2 font-display text-xs font-semibold uppercase tracking-wider text-wf-ink-3">
        Add a step
      </p>
      <div className="relative mb-3">
        <Search
          className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-wf-ink-3"
          aria-hidden
        />
        <input
          type="search"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          disabled={disabled}
          placeholder="Search nodes…"
          aria-label="Search nodes"
          className="w-full rounded-lg border border-wf-hairline bg-void px-2 py-1.5 pl-8 text-sm text-wf-ink placeholder:text-wf-ink-3 focus:border-wf-focus focus:outline-none disabled:cursor-not-allowed disabled:opacity-50"
        />
      </div>
      {grouped.length === 0 ? (
        <p className="px-1 py-2 text-xs text-wf-ink-3">No steps match “{query.trim()}”.</p>
      ) : null}
      <div className="flex flex-col gap-3">
        {grouped.map(({ category, items }) => (
          <section key={category}>
            <p className="mb-1 text-[10px] font-medium uppercase tracking-wide text-wf-ink-3">
              {NODE_CATEGORY_META[category].label}
            </p>
            <div className="flex flex-col gap-0.5">
              {items.map((def) => {
                const Icon = NODE_ICONS[def.type];
                return (
                  <button
                    key={def.type}
                    type="button"
                    disabled={disabled}
                    onClick={() => onAdd(def.type)}
                    title={def.description}
                    className="flex items-center gap-2 rounded-lg px-2 py-1.5 text-left text-sm text-wf-ink-2 transition-colors hover:bg-white/[0.06] hover:text-wf-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-wf-focus disabled:cursor-not-allowed disabled:opacity-50"
                  >
                    <Icon className="h-4 w-4 shrink-0 text-wf-ink-3" aria-hidden />
                    <span className="truncate">{def.label}</span>
                  </button>
                );
              })}
            </div>
          </section>
        ))}
      </div>
    </div>
  );
}
