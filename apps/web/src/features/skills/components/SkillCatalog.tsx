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
import type { SkillStatus } from '@vaep/types';
import { GitHubIcon } from '@/components/marketing-dark/brand-icons';
import { useProductContext } from '@/features/product-context/hooks';
import { useCatalog, useInstallSkill, useInstalledSkills } from '../hooks';
import { CATEGORY_STYLES, formatCategory } from '../labels';
import type { SkillCategory, SkillDefinitionDto } from '../schemas';

/**
 * The five states a skill can be in for a company, in the order a person
 * should deal with them: fix what is broken, then act on what is suggested,
 * then browse the rest. Mirrors the server's own ordering.
 */
const STATUS_ORDER: SkillStatus[] = [
  'NEEDS_CONFIGURATION',
  'RECOMMENDED',
  'CONNECTED',
  'AVAILABLE',
  'SIMULATED_ONLY',
];

const STATUS_LABEL: Record<SkillStatus, string> = {
  NEEDS_CONFIGURATION: 'Needs setup',
  RECOMMENDED: 'Recommended',
  CONNECTED: 'Connected',
  AVAILABLE: 'Available',
  SIMULATED_ONLY: 'Demo only',
};

const STATUS_STYLE: Record<SkillStatus, string> = {
  NEEDS_CONFIGURATION: 'bg-status-warning/15 text-sl-warning',
  RECOMMENDED: 'bg-violet/15 text-violet',
  CONNECTED: 'bg-green-500/15 text-green-700',
  AVAILABLE: 'bg-app-raised text-app-ink-3',
  SIMULATED_ONLY: 'bg-app-raised text-app-ink-3',
};

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
  status,
  because,
  onInstall,
}: {
  skill: SkillDefinitionDto;
  /** Server-resolved category for this company. */
  status: SkillStatus;
  /** Why it is recommended, when it is. */
  because: string | null;
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
        <div className="flex shrink-0 flex-col items-end gap-1">
          <span
            className={`rounded-full px-2 py-0.5 text-[11px] font-medium ${STATUS_STYLE[status]}`}
          >
            {STATUS_LABEL[status]}
          </span>
          <span
            className={`rounded-full px-2 py-0.5 text-[11px] font-medium ${CATEGORY_STYLES[skill.category]}`}
          >
            {formatCategory(skill.category)}
          </span>
        </div>
      </div>

      <p className="font-bold text-app-ink">{skill.name}</p>
      <p className="mt-1 line-clamp-2 text-xs text-app-ink-2">{skill.description}</p>
      <p className="mt-2 truncate text-xs text-app-ink-3">
        Tools: {skill.tools.map((t) => t.name).join(', ')}
      </p>

      {/* The reason, in the customer's own configuration's words. */}
      {because && <p className="mt-2 text-xs text-violet">{because}</p>}

      {/*
        Say it BEFORE the Install button, not after a customer has wired it into
        a workflow. `SIMULATED` means no tool here reaches a real provider — the
        state HubSpot, Jira, GitHub and Stripe are in today. `PARTIAL` means some
        tools do and some do not (Gmail: sending is real, reading the inbox is
        not), which is worth saying too rather than rounding up to "works".
      */}
      {skill.executionSupport !== 'REAL' && (
        <p
          className={`mt-2 rounded-lg px-2 py-1 text-[11px] ${
            skill.executionSupport === 'SIMULATED'
              ? 'bg-status-warning/10 text-sl-warning'
              : 'bg-app-raised text-app-ink-3'
          }`}
        >
          {skill.executionSupport === 'SIMULATED'
            ? 'Demo only — actions are simulated and never reach ' + skill.name + '.'
            : 'Partly simulated: ' +
              skill.tools
                .filter((t) => t.simulated)
                .map((t) => t.name)
                .join(', ') +
              ' produce sample results, not real ones.'}
        </p>
      )}

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
  const [statusFilter, setStatusFilter] = useState<SkillStatus | 'all'>('all');

  // Resolved SERVER-side: which skills this company's configuration makes
  // worth suggesting, and which installed ones are actually usable. The page
  // holds no rule about that — it renders the categorisation it is handed.
  const { data: productContext } = useProductContext();
  const statusByKey = new Map(
    (productContext?.skillStatuses ?? []).map((s) => [s.skillKey, s.status]),
  );
  const becauseByKey = new Map(
    (productContext?.skillStatuses ?? []).map((s) => [s.skillKey, s.because]),
  );

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
    const matchesStatus =
      statusFilter === 'all' || (statusByKey.get(skill.key) ?? 'AVAILABLE') === statusFilter;
    return matchesCategory && matchesSearch && matchesStatus;
  });

  /*
    Sort by the server's status bands, then alphabetically.
    NOTE what this does NOT do: it never removes a skill. A skill that is
    merely not recommended is still listed, still installable, still
    searchable — relevance orders the catalog, it does not shorten it.
  */
  const sorted = [...filtered].sort((a, b) => {
    const rank = (k: string) => STATUS_ORDER.indexOf(statusByKey.get(k) ?? 'AVAILABLE');
    return rank(a.key) - rank(b.key) || a.name.localeCompare(b.name);
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

      {/*
        Status filter. Only offers bands this company actually has, so an
        account with nothing broken is not shown an empty "Needs setup" filter.
      */}
      <div className="mt-2 flex flex-wrap gap-2">
        <button
          type="button"
          onClick={() => setStatusFilter('all')}
          className={`rounded-full px-3.5 py-1.5 text-xs font-medium transition-colors ${
            statusFilter === 'all'
              ? 'bg-app-ink text-app-surface'
              : 'border border-app-border text-app-ink-2 hover:text-app-ink'
          }`}
        >
          Any status
        </button>
        {STATUS_ORDER.filter((st) =>
          (catalog ?? []).some((sk) => (statusByKey.get(sk.key) ?? 'AVAILABLE') === st),
        ).map((st) => (
          <button
            key={st}
            type="button"
            onClick={() => setStatusFilter(st)}
            className={`rounded-full px-3.5 py-1.5 text-xs font-medium transition-colors ${
              statusFilter === st
                ? 'bg-app-ink text-app-surface'
                : 'border border-app-border text-app-ink-2 hover:text-app-ink'
            }`}
          >
            {STATUS_LABEL[st]}
          </button>
        ))}
      </div>

      {sorted.length === 0 ? (
        <p className="mt-6 text-sm text-app-ink-3">No skills match your search.</p>
      ) : (
        <div className="mt-5 grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
          {sorted.map((skill) => (
            <SkillCard
              key={skill.key}
              skill={skill}
              installed={installedKeys.has(skill.key)}
              connected={connectedKeys.has(skill.key)}
              installing={install.isPending}
              status={statusByKey.get(skill.key) ?? 'AVAILABLE'}
              because={becauseByKey.get(skill.key) ?? null}
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
