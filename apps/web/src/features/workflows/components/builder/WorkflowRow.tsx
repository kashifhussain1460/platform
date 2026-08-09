'use client';

import { useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import {
  Archive,
  CircleDot,
  Copy,
  type LucideIcon,
  MoreHorizontal,
  PauseCircle,
  Pencil,
  Play,
  Power,
  Trash2,
  UserRound,
  Zap,
} from 'lucide-react';
import type { WorkflowDto, WorkflowStatus } from '@vaep/types';
import { TRIGGER_TYPE_LABELS } from '../../labels';
import type { DerivedEmployee } from '../../deriveEmployees';
import { formatRelativeTime } from '@/lib/time';

/** Shared grid template so the header and every row stay column-aligned (desktop). */
export const ROW_GRID =
  'lg:grid lg:grid-cols-[minmax(0,1fr)_128px_128px_120px_44px] lg:items-center lg:gap-4';

// --- Status pill -----------------------------------------------------------

interface StatusMeta {
  label: string;
  icon: LucideIcon;
  /** Literal class string (Tailwind JIT can't see runtime-built names). */
  cls: string;
}

const STATUS_META: Record<WorkflowStatus, StatusMeta> = {
  DRAFT: {
    label: 'Draft',
    icon: Pencil,
    cls: 'border-wf-hairline bg-white/[0.04] text-wf-ink-2',
  },
  ACTIVE: {
    label: 'Active',
    icon: CircleDot,
    cls: 'border-status-succeeded/30 bg-status-succeeded/10 text-status-succeeded',
  },
  PAUSED: {
    label: 'Paused',
    icon: PauseCircle,
    cls: 'border-status-waiting/30 bg-status-waiting/10 text-status-waiting',
  },
  ARCHIVED: {
    label: 'Archived',
    icon: Archive,
    cls: 'border-white/[0.06] bg-white/[0.03] text-wf-ink-3',
  },
};

function StatusPill({ status }: { status: WorkflowStatus }) {
  const meta = STATUS_META[status];
  const Icon = meta.icon;
  return (
    <span
      className={`inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-xs font-medium ${meta.cls}`}
    >
      <Icon className="h-3.5 w-3.5" aria-hidden />
      {meta.label}
    </span>
  );
}

// --- Employee stack (the signature AI-Employee-OS reading) -----------------

function initials(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return '?';
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
  return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
}

const MAX_AVATARS = 3;

function EmployeeStack({
  employees,
  needsEmployee,
}: {
  employees: DerivedEmployee[];
  needsEmployee: boolean;
}) {
  if (employees.length === 0) {
    return (
      <span className="inline-flex items-center gap-1.5 text-xs text-wf-ink-3">
        <UserRound className="h-3.5 w-3.5" aria-hidden />
        {needsEmployee ? 'Needs an employee' : 'Automated'}
      </span>
    );
  }

  const shown = employees.slice(0, MAX_AVATARS);
  const overflow = employees.length - shown.length;
  const summary =
    employees.length === 1
      ? `${employees[0].name}${employees[0].role ? `, ${employees[0].role}` : ''}`
      : `${employees[0].name} and ${employees.length - 1} other${employees.length - 1 === 1 ? '' : 's'}`;

  return (
    <span
      className="flex items-center"
      role="img"
      aria-label={`Runs ${summary}`}
    >
      {shown.map((e, i) => (
        <span
          key={e.employeeId}
          title={e.unresolved ? 'Employee no longer available' : `${e.name}${e.role ? `, ${e.role} employee` : ''}`}
          className={[
            'flex h-7 w-7 items-center justify-center rounded-full border-2 border-void-section text-[10px] font-semibold',
            i > 0 ? '-ml-2' : '',
            e.unresolved
              ? 'bg-white/[0.05] text-wf-ink-3'
              : 'bg-cat-employee/20 text-cat-employee',
          ].join(' ')}
        >
          {e.unresolved ? '?' : initials(e.name)}
        </span>
      ))}
      {overflow > 0 && (
        <span className="-ml-2 flex h-7 w-7 items-center justify-center rounded-full border-2 border-void-section bg-white/[0.06] text-[10px] font-semibold text-wf-ink-2">
          +{overflow}
        </span>
      )}
    </span>
  );
}

// --- Row action menu -------------------------------------------------------

interface MenuItem {
  key: string;
  label: string;
  icon: LucideIcon;
  onSelect: () => void;
  disabled?: boolean;
  reason?: string;
  danger?: boolean;
}

function RowMenu({ label, items }: { label: string; items: MenuItem[] }) {
  const [open, setOpen] = useState(false);
  // useRef for focus return + click-outside detection only (per house rule).
  const buttonRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onDocMouseDown = (event: MouseEvent) => {
      const target = event.target as Node;
      if (
        !menuRef.current?.contains(target) &&
        !buttonRef.current?.contains(target)
      ) {
        setOpen(false);
      }
    };
    document.addEventListener('mousedown', onDocMouseDown);
    return () => document.removeEventListener('mousedown', onDocMouseDown);
  }, [open]);

  const close = () => {
    setOpen(false);
    buttonRef.current?.focus();
  };

  return (
    <div className="relative flex justify-end" data-no-row-open>
      <button
        ref={buttonRef}
        type="button"
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label={label}
        onClick={() => setOpen((o) => !o)}
        className="rounded-lg p-1.5 text-wf-ink-3 transition-colors hover:bg-white/[0.06] hover:text-wf-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-wf-focus"
      >
        <MoreHorizontal className="h-4 w-4" />
      </button>

      {open && (
        <div
          ref={menuRef}
          role="menu"
          aria-label={label}
          onKeyDown={(event) => {
            if (event.key === 'Escape') {
              event.stopPropagation();
              close();
            }
          }}
          className="absolute right-0 top-9 z-20 w-52 overflow-hidden rounded-xl border border-wf-hairline bg-void-card p-1 shadow-xl shadow-black/40"
        >
          {items.map((item) => {
            const Icon = item.icon;
            return (
              <button
                key={item.key}
                type="button"
                role="menuitem"
                disabled={item.disabled}
                aria-disabled={item.disabled || undefined}
                title={item.disabled ? item.reason : undefined}
                onClick={() => {
                  if (item.disabled) return;
                  item.onSelect();
                  close();
                }}
                className={[
                  'flex w-full items-center gap-2.5 rounded-lg px-2.5 py-2 text-left text-sm transition-colors',
                  'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-wf-focus',
                  item.disabled
                    ? 'cursor-not-allowed text-wf-ink-3 opacity-60'
                    : item.danger
                      ? 'text-status-failed hover:bg-status-failed/10'
                      : 'text-wf-ink hover:bg-white/[0.06]',
                ].join(' ')}
              >
                <Icon className="h-4 w-4 shrink-0" aria-hidden />
                {item.label}
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}

// --- The row ---------------------------------------------------------------

export interface WorkflowRowProps {
  workflow: WorkflowDto;
  employees: DerivedEmployee[];
  needsEmployee: boolean;
  /** Owner-only actions (hard delete). */
  isOwner: boolean;
  isBusy: boolean;
  onOpen: (id: string) => void;
  onRun: (id: string) => void;
  onActivate: (id: string) => void;
  onDeactivate: (id: string) => void;
  onDuplicate: (id: string) => void;
  onDelete: (id: string, hard: boolean) => void;
}

export function WorkflowRow({
  workflow,
  employees,
  needsEmployee,
  isOwner,
  isBusy,
  onOpen,
  onRun,
  onActivate,
  onDeactivate,
  onDuplicate,
  onDelete,
}: WorkflowRowProps) {
  const isTemp = workflow.id.startsWith('temp_');
  const isArchived = workflow.status === 'ARCHIVED';
  const nodes = workflow.definition?.nodes ?? [];
  const canActivate = nodes.some((n) => n.type !== 'TRIGGER');

  const triggerLabel = TRIGGER_TYPE_LABELS[workflow.triggerType];
  const rosterSentence =
    employees.length === 0
      ? 'Automated'
      : `Runs ${employees.map((e) => (e.role ? `${e.name}, ${e.role}` : e.name)).join('; ')}`;
  const rowAriaLabel = `${workflow.name}. ${STATUS_META[workflow.status].label}. ${rosterSentence}. Trigger ${triggerLabel}.`;

  // Menu items — every disabled path carries a plain-language reason.
  const items: MenuItem[] = [
    { key: 'open', label: 'Open', icon: Pencil, onSelect: () => onOpen(workflow.id) },
    {
      key: 'run',
      label: 'Run now',
      icon: Play,
      onSelect: () => onRun(workflow.id),
      disabled: isTemp || isArchived,
      reason: isArchived ? 'This workflow is archived.' : 'Give it a moment to finish saving.',
    },
  ];
  if (workflow.status === 'ACTIVE') {
    items.push({
      key: 'deactivate',
      label: 'Pause',
      icon: PauseCircle,
      onSelect: () => onDeactivate(workflow.id),
      disabled: isTemp,
      reason: 'Give it a moment to finish saving.',
    });
  } else if (!isArchived) {
    items.push({
      key: 'activate',
      label: 'Activate',
      icon: Power,
      onSelect: () => onActivate(workflow.id),
      disabled: isTemp || !canActivate,
      reason: !canActivate ? 'Add at least one step first.' : 'Give it a moment to finish saving.',
    });
  }
  items.push({
    key: 'duplicate',
    label: 'Duplicate',
    icon: Copy,
    onSelect: () => onDuplicate(workflow.id),
    disabled: isTemp,
    reason: 'Give it a moment to finish saving.',
  });
  if (!isArchived) {
    items.push({
      key: 'archive',
      label: 'Archive…',
      icon: Archive,
      onSelect: () => onDelete(workflow.id, false),
      disabled: isTemp,
      reason: 'Give it a moment to finish saving.',
    });
  }
  items.push({
    key: 'hard-delete',
    label: 'Delete for good…',
    icon: Trash2,
    onSelect: () => onDelete(workflow.id, true),
    disabled: isTemp || !isOwner,
    reason: !isOwner ? 'Only an owner can delete for good.' : 'Give it a moment to finish saving.',
    danger: true,
  });

  return (
    <div
      role="row"
      aria-label={rowAriaLabel}
      aria-busy={isBusy || undefined}
      onClick={(event) => {
        if (isTemp) return;
        if (!(event.target as HTMLElement).closest('[data-no-row-open]')) {
          onOpen(workflow.id);
        }
      }}
      className={[
        ROW_GRID,
        'relative flex flex-col gap-3 rounded-2xl border border-wf-hairline bg-void-card p-4 transition-colors',
        isTemp ? 'opacity-60' : 'cursor-pointer hover:border-wf-hairline-hover hover:bg-void-card-hover',
        isBusy ? 'opacity-70' : '',
      ].join(' ')}
    >
      {/* Cell 1 — the workflow: who runs it + name */}
      <div role="cell" className="flex min-w-0 items-center gap-3">
        <EmployeeStack employees={employees} needsEmployee={needsEmployee} />
        <span className="min-w-0">
          <Link
            href={`/workflows/${workflow.id}`}
            onClick={(e) => e.stopPropagation()}
            aria-disabled={isTemp}
            className="block truncate font-display font-semibold text-wf-ink hover:text-white focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-wf-focus"
          >
            {workflow.name}
          </Link>
          {workflow.description ? (
            <span className="block truncate text-xs text-wf-ink-2">{workflow.description}</span>
          ) : null}
          {/* Below lg the status/trigger/updated columns fold into this subtitle */}
          <span className="mt-0.5 block text-xs text-wf-ink-3 lg:hidden">
            {triggerLabel} · updated {formatRelativeTime(workflow.updatedAt)}
          </span>
        </span>
      </div>

      {/* Cell 2 — status */}
      <div role="cell" className="flex items-center lg:justify-start">
        <StatusPill status={workflow.status} />
      </div>

      {/* Cell 3 — trigger (desktop column) */}
      <div role="cell" className="hidden items-center gap-1.5 text-sm text-wf-ink-2 lg:flex">
        <Zap className="h-3.5 w-3.5 text-cat-trigger" aria-hidden />
        {triggerLabel}
      </div>

      {/* Cell 4 — updated (desktop column) */}
      <div role="cell" className="hidden text-sm text-wf-ink-3 lg:block">
        {formatRelativeTime(workflow.updatedAt)}
      </div>

      {/* Cell 5 — actions */}
      <div role="cell" className="absolute right-4 top-4 lg:static">
        <RowMenu label={`Actions for ${workflow.name}`} items={items} />
      </div>
    </div>
  );
}
