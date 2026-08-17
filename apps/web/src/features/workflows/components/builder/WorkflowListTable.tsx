'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { Search } from 'lucide-react';
import type { AiEmployeeDto, WorkflowStatus } from '@vaep/types';
import type { NormalizedApiError } from '@/lib/apiClient';
import { useSessionStore } from '@/stores/session.store';
import {
  useActivateWorkflow,
  useDeactivateWorkflow,
  useDeleteWorkflow,
  useDuplicateWorkflow,
  useRunFromList,
  useWorkflows,
} from '../../hooks';
import { useEmployees } from '@/features/employees/hooks';
import { deriveEmployees, hasUnassignedEmployeeStep } from '../../deriveEmployees';
import { EmptyState } from './EmptyState';
import { ROW_GRID, WorkflowRow } from './WorkflowRow';

type StatusFilter = 'ALL' | WorkflowStatus;
type SortKey = 'updated' | 'name' | 'status';

const STATUS_SEGMENTS: { value: StatusFilter; label: string }[] = [
  { value: 'ALL', label: 'All' },
  { value: 'DRAFT', label: 'Draft' },
  { value: 'ACTIVE', label: 'Active' },
  { value: 'PAUSED', label: 'Paused' },
];

// Sort order for the "Status" sort — most operationally live first.
const STATUS_RANK: Record<WorkflowStatus, number> = {
  ACTIVE: 0,
  PAUSED: 1,
  DRAFT: 2,
  ARCHIVED: 3,
};

type MutationKind = 'activate' | 'deactivate' | 'run' | 'duplicate' | 'delete';

/** Map an API failure to one plain-language line (doc 29 §1 error copy). */
function errorMessage(err: NormalizedApiError, kind: MutationKind): string {
  if (err.status === 429) return 'Give it a moment — too many requests just now.';
  if (kind === 'activate' && err.status === 400)
    return 'Add at least one step before you activate this.';
  if (kind === 'delete' && err.status === 409)
    return 'This is still running — you can archive it once the run finishes.';
  if (kind === 'run' && err.status === 403)
    return "You're not set up to run this workflow.";
  return err.message || 'Something went wrong. Try again.';
}

/** The tenant's workflows, read as a roster (doc 29 §1). */
export function WorkflowListTable() {
  const router = useRouter();
  const role = useSessionStore((s) => s.user?.role);
  const isOwner = role === 'OWNER';

  const { data: workflows, isLoading, isError, error, refetch } = useWorkflows();
  const { data: employees } = useEmployees();

  const activate = useActivateWorkflow();
  const deactivate = useDeactivateWorkflow();
  const del = useDeleteWorkflow();
  const duplicate = useDuplicateWorkflow();
  const run = useRunFromList();

  // All list/control state is local (never the Zustand store) — house rule.
  const [query, setQuery] = useState('');
  const [debouncedQuery, setDebouncedQuery] = useState('');
  const [sort, setSort] = useState<SortKey>('updated');
  const [statusFilter, setStatusFilter] = useState<StatusFilter>('ALL');
  const [showArchived, setShowArchived] = useState(false);
  const [notice, setNotice] = useState(''); // polite: success lines
  const [alert, setAlert] = useState(''); // assertive: failures
  const searchRef = useRef<HTMLInputElement>(null); // focus target for "/"

  const say = (message: string) => {
    setNotice(message);
    setAlert('');
  };
  const warn = (message: string) => {
    setAlert(message);
    setNotice('');
  };

  // Debounce the search 200ms so typing doesn't re-filter on every keystroke.
  useEffect(() => {
    const t = setTimeout(() => setDebouncedQuery(query.trim().toLowerCase()), 200);
    return () => clearTimeout(t);
  }, [query]);

  // "/" focuses search; Esc while focused clears then blurs.
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== '/') return;
      const el = document.activeElement;
      const typing =
        el instanceof HTMLInputElement ||
        el instanceof HTMLTextAreaElement ||
        (el instanceof HTMLElement && el.isContentEditable);
      if (typing) return;
      event.preventDefault();
      searchRef.current?.focus();
    };
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, []);

  const employeesById = useMemo(() => {
    const map = new Map<string, AiEmployeeDto>();
    for (const e of employees ?? []) map.set(e.id, e);
    return map;
  }, [employees]);

  // One derived-roster pass, reused by search and each row.
  const enriched = useMemo(
    () =>
      (workflows ?? []).map((w) => ({
        workflow: w,
        roster: deriveEmployees(w.definition, employeesById),
        needsEmployee: hasUnassignedEmployeeStep(w.definition),
      })),
    [workflows, employeesById],
  );

  const visible = useMemo(() => {
    const filtered = enriched.filter(({ workflow, roster }) => {
      if (workflow.status === 'ARCHIVED' && !showArchived) return false;
      if (statusFilter !== 'ALL' && workflow.status !== statusFilter) return false;
      if (!debouncedQuery) return true;
      const haystack = [
        workflow.name,
        workflow.description ?? '',
        ...roster.map((r) => r.name),
      ]
        .join(' ')
        .toLowerCase();
      return haystack.includes(debouncedQuery);
    });

    const sorted = [...filtered];
    sorted.sort((a, b) => {
      if (sort === 'name') return a.workflow.name.localeCompare(b.workflow.name);
      if (sort === 'status') {
        const diff = STATUS_RANK[a.workflow.status] - STATUS_RANK[b.workflow.status];
        return diff !== 0 ? diff : a.workflow.name.localeCompare(b.workflow.name);
      }
      // updated (default): newest first
      return b.workflow.updatedAt.localeCompare(a.workflow.updatedAt);
    });
    return sorted;
  }, [enriched, debouncedQuery, statusFilter, showArchived, sort]);

  // Which row (if any) has a mutation in flight — drives per-row aria-busy.
  const busyId =
    (activate.isPending ? activate.variables : undefined) ??
    (deactivate.isPending ? deactivate.variables : undefined) ??
    (del.isPending ? del.variables?.id : undefined) ??
    (duplicate.isPending ? duplicate.variables?.id : undefined) ??
    (run.isPending ? run.variables?.id : undefined);

  const nameOf = (id: string) =>
    workflows?.find((w) => w.id === id)?.name ?? 'workflow';

  // --- Handlers (mirror WorkflowRowProps) ---------------------------------

  const onOpen = (id: string) => router.push(`/workflows/${id}`);

  const onRun = (id: string) => {
    const name = nameOf(id);
    run.mutate(
      { id },
      {
        onSuccess: (created) => {
          say(`Started a run of ${name}.`);
          router.push(`/workflows/${id}?run=${created.id}`);
        },
        onError: (e) => warn(errorMessage(e, 'run')),
      },
    );
  };

  const onActivate = (id: string) => {
    const name = nameOf(id);
    activate.mutate(id, {
      onSuccess: () => say(`${name} is now active.`),
      onError: (e) => warn(errorMessage(e, 'activate')),
    });
  };

  const onDeactivate = (id: string) => {
    const name = nameOf(id);
    deactivate.mutate(id, {
      onSuccess: () => say(`${name} is paused.`),
      onError: (e) => warn(errorMessage(e, 'deactivate')),
    });
  };

  const onDuplicate = (id: string) => {
    const name = nameOf(id);
    duplicate.mutate(
      { id, name: `${name} (copy)` },
      {
        onSuccess: () => say(`Duplicated ${name}.`),
        onError: (e) => warn(errorMessage(e, 'duplicate')),
      },
    );
  };

  const onDelete = (id: string, hard: boolean) => {
    const name = nameOf(id);
    const ok = window.confirm(
      hard
        ? `Delete "${name}" for good? This erases it and its run history. This can't be undone.`
        : `Archive "${name}"? Its run history is kept, and you can't run it after.`,
    );
    if (!ok) return;
    del.mutate(
      { id, hard },
      {
        onSuccess: () => say(hard ? `Deleted ${name}.` : `Archived ${name}.`),
        onError: (e) => warn(errorMessage(e, 'delete')),
      },
    );
  };

  // --- States --------------------------------------------------------------

  if (isLoading) {
    return (
      <div className="space-y-3" aria-busy="true">
        {Array.from({ length: 6 }).map((_, i) => (
          <div
            key={i}
            className="h-[76px] animate-pulse rounded-2xl border border-app-border bg-app-surface"
          />
        ))}
      </div>
    );
  }

  if (isError) {
    return (
      <EmptyState
        title="We couldn't load your workflows"
        body={error.message}
        size="page"
        action={
          <button
            type="button"
            onClick={() => void refetch()}
            className="rounded-lg border border-app-border bg-app-surface px-4 py-2 text-sm font-medium text-app-ink transition-colors hover:border-app-border-strong"
          >
            Try again
          </button>
        }
      />
    );
  }

  if (!workflows || workflows.length === 0) {
    return (
      <EmptyState
        title="No workflows yet"
        body="A workflow is a job you hand to your AI Employees — start one from scratch, from a template, or describe it and let AI draft it."
        size="page"
      />
    );
  }

  const archivedExist = enriched.some((e) => e.workflow.status === 'ARCHIVED');

  return (
    <div className="space-y-4">
      {/* Controls */}
      <div className="flex flex-wrap items-center gap-3">
        <div className="relative min-w-[200px] flex-1">
          <Search
            className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-app-ink-3"
            aria-hidden
          />
          <input
            ref={searchRef}
            type="search"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Escape') {
                setQuery('');
                e.currentTarget.blur();
              }
            }}
            placeholder="Search workflows or people…  ( / )"
            aria-label="Search workflows"
            className="w-full rounded-lg border border-app-border bg-app-surface py-2 pl-9 pr-3 text-sm text-app-ink outline-none placeholder:text-app-ink-3 focus-visible:ring-2 focus-visible:ring-wf-focus"
          />
        </div>

        <div className="flex rounded-lg border border-app-border p-0.5" role="group" aria-label="Filter by status">
          {STATUS_SEGMENTS.map((seg) => (
            <button
              key={seg.value}
              type="button"
              aria-pressed={statusFilter === seg.value}
              onClick={() => setStatusFilter(seg.value)}
              className={`rounded-md px-3 py-1.5 text-sm font-medium transition-colors ${
                statusFilter === seg.value
                  ? 'bg-violet text-white'
                  : 'text-app-ink-2 hover:text-app-ink'
              }`}
            >
              {seg.label}
            </button>
          ))}
        </div>

        <label className="flex items-center gap-2 text-sm text-app-ink-2">
          <span className="sr-only">Sort by</span>
          <select
            value={sort}
            onChange={(e) => setSort(e.target.value as SortKey)}
            className="rounded-lg border border-app-border bg-app-surface px-3 py-2 text-sm text-app-ink outline-none focus-visible:ring-2 focus-visible:ring-wf-focus"
            aria-label="Sort workflows"
          >
            <option value="updated">Recently updated</option>
            <option value="name">Name A–Z</option>
            <option value="status">Status</option>
          </select>
        </label>

        {archivedExist && (
          <button
            type="button"
            aria-pressed={showArchived}
            onClick={() => {
              setShowArchived((v) => {
                const next = !v;
                if (!next && statusFilter === 'ARCHIVED') setStatusFilter('ALL');
                return next;
              });
            }}
            className={`rounded-lg border px-3 py-2 text-sm font-medium transition-colors ${
              showArchived
                ? 'border-violet-secondary bg-violet/10 text-app-ink'
                : 'border-app-border text-app-ink-3 hover:text-app-ink-2'
            }`}
          >
            {showArchived ? 'Hide archived' : 'Show archived'}
          </button>
        )}
      </div>

      {/* Column headers (desktop) */}
      <div
        className={`${ROW_GRID} hidden px-4 lg:grid`}
        role="row"
        aria-hidden
      >
        <span role="columnheader" className="text-xs font-medium uppercase tracking-wider text-app-ink-3">
          Workflow
        </span>
        <span role="columnheader" className="text-xs font-medium uppercase tracking-wider text-app-ink-3">
          Status
        </span>
        <span role="columnheader" className="text-xs font-medium uppercase tracking-wider text-app-ink-3">
          Trigger
        </span>
        <span role="columnheader" className="text-xs font-medium uppercase tracking-wider text-app-ink-3">
          Updated
        </span>
        <span role="columnheader" className="sr-only">
          Actions
        </span>
      </div>

      {/* Rows */}
      {visible.length === 0 ? (
        <div className="rounded-2xl border border-app-border bg-app-surface p-8 text-center">
          <p className="text-sm text-app-ink-2">
            No workflows match “{debouncedQuery || 'this filter'}”.
          </p>
          <button
            type="button"
            onClick={() => {
              setQuery('');
              setStatusFilter('ALL');
            }}
            className="mt-3 text-sm font-medium text-violet hover:text-violet"
          >
            Clear search &amp; filters to see all {workflows.length}
          </button>
        </div>
      ) : (
        <div role="table" aria-label="Workflows" className="space-y-3">
          {visible.map(({ workflow, roster, needsEmployee }) => (
            <WorkflowRow
              key={workflow.id}
              workflow={workflow}
              employees={roster}
              needsEmployee={needsEmployee}
              isOwner={isOwner}
              isBusy={workflow.id === busyId}
              onOpen={onOpen}
              onRun={onRun}
              onActivate={onActivate}
              onDeactivate={onDeactivate}
              onDuplicate={onDuplicate}
              onDelete={onDelete}
            />
          ))}
        </div>
      )}

      {/* Screen-reader announcements */}
      <span className="sr-only" role="status" aria-live="polite">
        {notice}
      </span>
      <span className="sr-only" role="alert" aria-live="assertive">
        {alert}
      </span>
    </div>
  );
}
