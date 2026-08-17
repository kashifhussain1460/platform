'use client';

import { useState, type ElementType } from 'react';
import {
  Calendar,
  CalendarClock,
  CreditCard,
  Globe,
  HardDrive,
  Kanban,
  Mail,
  MessageSquare,
  Search,
  Sparkles,
  Users,
} from 'lucide-react';
import { GitHubIcon } from '@/components/marketing-dark/brand-icons';
import { useCatalog, useInstallSkill, useInstalledSkills } from '../hooks';
import { CATEGORY_STYLES, formatCategory } from '../labels';
import type { SkillCategory, SkillDefinitionDto } from '../schemas';

/** Per-skill glyph for the catalog grid — a generic capability icon, not a brand mark. */
const SKILL_ICON: Record<string, ElementType<{ className?: string }>> = {
  slack: MessageSquare,
  email: Mail,
  gmail: Mail,
  stripe: CreditCard,
  github: GitHubIcon,
  http: Globe,
  hubspot: Users,
  jira: Kanban,
  calendar: Calendar,
  gdrive: HardDrive,
  scheduling: CalendarClock,
};

function SkillCard({
  skill,
  installed,
  connected,
  installing,
  onInstall,
}: {
  skill: SkillDefinitionDto;
  installed: boolean;
  /**
   * Installed AND usable. Kept separate from `installed` on purpose: a bare
   * "Installed" badge read as "done", so people connected nothing, went back to
   * AI Assist, and were told the skill was still not connected. Both screens
   * were right; only this card was ambiguous.
   */
  connected: boolean;
  installing: boolean;
  onInstall: () => void;
}) {
  const Icon = SKILL_ICON[skill.key] ?? Sparkles;
  const needsConnecting = installed && !connected;

  return (
    <div className="flex flex-col rounded-2xl border border-app-border bg-app-surface p-4 transition-colors hover:border-app-border-strong">
      <div className="mb-3 flex items-start justify-between gap-2">
        <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-violet/15 text-violet">
          <Icon className="h-5 w-5" />
        </span>
        <span
          className={`shrink-0 rounded-full px-2 py-0.5 text-[11px] font-medium ${CATEGORY_STYLES[skill.category]}`}
        >
          {formatCategory(skill.category)}
        </span>
      </div>

      <p className="font-bold text-app-ink">{skill.name}</p>
      <p className="mt-1 line-clamp-2 text-xs text-app-ink-2">{skill.description}</p>
      <p className="mt-2 truncate text-xs text-app-ink-3">
        Tools: {skill.tools.map((t) => t.name).join(', ')}
      </p>

      {needsConnecting ? (
        <a
          href={`#installed-${skill.key}`}
          className="mt-4 w-full rounded-xl border border-status-warning/40 bg-status-warning/10 px-4 py-2 text-center text-sm font-medium text-sl-warning transition-colors hover:bg-status-warning/20"
        >
          Installed — connect it
        </a>
      ) : (
        <button
          type="button"
          onClick={onInstall}
          disabled={installed || installing}
          className={`mt-4 w-full rounded-xl border px-4 py-2 text-sm font-medium transition-colors disabled:cursor-not-allowed ${
            installed
              ? 'border-app-border bg-app-surface text-app-ink-3'
              : 'border-app-border-strong bg-app-surface text-app-ink-2 hover:border-app-border-strong hover:bg-app-raised'
          }`}
        >
          {installed ? 'Installed' : installing ? 'Installing…' : 'Install'}
        </button>
      )}
    </div>
  );
}

/** The built-in catalog: client-side search/category filters + optimistic install. */
export function SkillCatalog() {
  const { data: catalog, isLoading } = useCatalog();
  const { data: installed } = useInstalledSkills();
  const install = useInstallSkill();
  const [search, setSearch] = useState('');
  const [category, setCategory] = useState<SkillCategory | 'all'>('all');

  if (isLoading) {
    return <p className="text-sm text-app-ink-3">Loading catalog…</p>;
  }

  const installedKeys = new Set((installed ?? []).map((s) => s.skillKey));
  // A skill that needs no credentials (connectionType `none`) is usable the
  // moment it is installed, so it must not be nagged about.
  const connectedKeys = new Set(
    (installed ?? [])
      .filter((s) => s.connectionStatus === 'CONNECTED' || s.connectionType === 'none')
      .map((s) => s.skillKey),
  );
  const categories = Array.from(new Set((catalog ?? []).map((s) => s.category)));

  const q = search.trim().toLowerCase();
  const filtered = (catalog ?? []).filter((skill) => {
    const matchesCategory = category === 'all' || skill.category === category;
    const matchesSearch =
      !q ||
      skill.name.toLowerCase().includes(q) ||
      skill.description.toLowerCase().includes(q);
    return matchesCategory && matchesSearch;
  });

  return (
    <section>
      <div className="relative max-w-sm">
        <Search className="pointer-events-none absolute left-3.5 top-1/2 h-4 w-4 -translate-y-1/2 text-app-ink-3" />
        <input
          type="text"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="Search skills…"
          aria-label="Search skills"
          className="field-modern"
          style={{ paddingLeft: '2.5rem' }}
        />
      </div>

      <div className="mt-4 flex flex-wrap gap-2">
        <button
          type="button"
          onClick={() => setCategory('all')}
          className={`rounded-full px-3.5 py-1.5 text-xs font-medium transition-colors ${
            category === 'all'
              ? 'bg-violet text-white'
              : 'border border-app-border text-app-ink-2 hover:text-app-ink'
          }`}
        >
          All
        </button>
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
            {formatCategory(c)}
          </button>
        ))}
      </div>

      {filtered.length === 0 ? (
        <p className="mt-6 text-sm text-app-ink-3">No skills match your search.</p>
      ) : (
        <div className="mt-5 grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
          {filtered.map((skill) => (
            <SkillCard
              key={skill.key}
              skill={skill}
              installed={installedKeys.has(skill.key)}
              connected={connectedKeys.has(skill.key)}
              installing={install.isPending}
              onInstall={() =>
                install.mutate({ skillKey: skill.key, displayName: skill.name })
              }
            />
          ))}
        </div>
      )}
    </section>
  );
}
