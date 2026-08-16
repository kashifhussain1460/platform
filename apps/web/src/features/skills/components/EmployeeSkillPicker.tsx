'use client';

import Link from 'next/link';
import type { SkillConnectionStatus } from '@vaep/types';
import { Button } from '@/components/ui/Button';
import { ConnectSkillControl } from './ConnectSkillControl';
import {
  useAssignSkill,
  useCatalog,
  useEmployeeSkills,
  useInstalledSkills,
  useInstallSkill,
  useUnassignSkill,
} from '../hooks';

const CONNECTION_LABELS: Record<SkillConnectionStatus, { text: string; className: string }> = {
  CONNECTED: { text: 'Connected', className: 'bg-green-500/15 text-green-400' },
  NOT_CONNECTED: { text: 'Not connected', className: 'bg-white/[0.06] text-zinc-400' },
  DEGRADED: { text: 'Degraded', className: 'bg-amber-500/15 text-amber-400' },
  DISCONNECTED: { text: 'Disconnected', className: 'bg-red-500/15 text-red-400' },
};

function ConnectionBadge({ status }: { status: SkillConnectionStatus }) {
  const { text, className } = CONNECTION_LABELS[status];
  return (
    <span className={`rounded-full px-2 py-0.5 text-xs font-medium ${className}`}>
      {text}
    </span>
  );
}

/**
 * Assign / unassign already-installed company skills to a specific employee
 * (optimistic), plus a section to give this employee its OWN connection of an
 * OAuth-capable skill (e.g. its own Gmail mailbox) — separate from any
 * company-wide connection managed on the global /skills page.
 */
export function EmployeeSkillPicker({
  employeeId,
  employeeName,
}: {
  employeeId: string;
  employeeName?: string;
}) {
  const who = employeeName ?? 'this employee';
  const { data: installed, isLoading } = useInstalledSkills();
  const { data: catalog } = useCatalog();
  const { data: assigned } = useEmployeeSkills(employeeId);
  const assign = useAssignSkill(employeeId);
  const unassign = useUnassignSkill(employeeId);
  const install = useInstallSkill();

  const assignedIds = new Set((assigned ?? []).map((a) => a.installedSkillId));
  const busy = assign.isPending || unassign.isPending;

  // Company-wide connections, or this employee's own -- another employee's
  // private connection (e.g. their own Gmail mailbox) must not appear here
  // as something assignable to THIS employee.
  const assignableInstalled = (installed ?? []).filter(
    (s) => s.employeeId === null || s.employeeId === employeeId,
  );

  // OAuth-capable catalog skills this employee doesn't already have a CONNECTED
  // connection for. A NOT_CONNECTED owned row (e.g. right after clicking
  // "Connect" below) must stay in this list so ConnectSkillControl can render
  // and actually complete the OAuth handshake -- excluding it entirely the
  // moment the row is created would make that control unreachable.
  const ownedByEmployee = new Map(
    (installed ?? [])
      .filter((s) => s.employeeId === employeeId)
      .map((s) => [s.skillKey, s] as const),
  );
  const connectableForEmployee = (catalog ?? []).filter(
    (def) =>
      def.connection?.type === 'oauth' &&
      ownedByEmployee.get(def.key)?.connectionStatus !== 'CONNECTED',
  );

  return (
    <div className="space-y-4">
      <section className="rounded-2xl border border-white/[0.07] bg-white/[0.02] p-5">
        <h2 className="mb-1 text-sm font-medium text-zinc-400">Skills</h2>
        {/* Without this line the screen looks broken: a skill shows as
            connected on the Skills page and still offers "Assign" here, and
            nothing says those are two different things. Connecting is done
            once for the company; assigning is per AI Employee, and an employee
            can only use what it has been given. */}
        <p className="mb-3 text-xs text-zinc-500">
          Connecting a skill is done once for the whole company. Assigning
          decides which AI Employee may use it — {who} can only use the skills
          assigned here.
        </p>

        {isLoading ? (
          <p className="text-sm text-zinc-500">Loading skills…</p>
        ) : assignableInstalled.length === 0 ? (
          <p className="text-sm text-zinc-500">
            No skills installed.{' '}
            <Link href="/skills" className="font-medium text-violet-secondary hover:text-white">
              Install skills
            </Link>{' '}
            to assign them here.
          </p>
        ) : (
          <ul className="divide-y divide-white/[0.06]">
            {assignableInstalled.map((skill) => {
              const isAssigned = assignedIds.has(skill.id);
              return (
                <li
                  key={skill.id}
                  className="flex items-center justify-between gap-4 py-2.5"
                >
                  <div className="min-w-0">
                    <div className="flex flex-wrap items-center gap-2">
                      <p className="truncate text-sm font-medium text-white">
                        {skill.displayName}
                      </p>
                      <ConnectionBadge status={skill.connectionStatus} />
                      {isAssigned ? (
                        <span className="rounded-full bg-violet/20 px-2 py-0.5 text-xs font-medium text-violet-secondary">
                          {who} can use this
                        </span>
                      ) : null}
                    </div>
                    <p className="text-xs text-zinc-500">
                      {skill.skillKey}
                      {!skill.enabled && ' · disabled'}
                    </p>
                    {/* Assigning a skill nobody has connected hands the
                        employee a tool that fails the moment it is used, and
                        the failure surfaces mid-conversation rather than
                        here. */}
                    {skill.connectionStatus !== 'CONNECTED' ? (
                      <p className="mt-1 text-xs text-status-warning">
                        Not connected yet — actions will fail until someone
                        connects it on the{' '}
                        <Link href="/skills" className="underline hover:text-white">
                          Skills page
                        </Link>
                        .
                      </p>
                    ) : null}
                  </div>
                  {isAssigned ? (
                    <button
                      type="button"
                      onClick={() => unassign.mutate({ installedSkillId: skill.id })}
                      disabled={busy}
                      className="rounded-xl border border-white/[0.12] bg-white/[0.03] px-4 py-2 text-sm font-medium text-zinc-300 transition-colors hover:border-white/25 hover:bg-white/[0.06] disabled:cursor-not-allowed disabled:opacity-50"
                    >
                      Unassign
                    </button>
                  ) : (
                    <Button
                      variant="violet"
                      onClick={() => assign.mutate({ installedSkillId: skill.id })}
                      disabled={busy}
                    >
                      Assign
                    </Button>
                  )}
                </li>
              );
            })}
          </ul>
        )}
      </section>

      {connectableForEmployee.length > 0 && (
        <section className="rounded-2xl border border-white/[0.07] bg-white/[0.02] p-5">
          <h2 className="mb-1 text-sm font-medium text-zinc-400">
            Connect a skill for this employee
          </h2>
          <p className="mb-3 text-xs text-zinc-500">
            Gives this employee its own connection (e.g. its own mailbox), separate
            from any company-wide connection on the Skills page.
          </p>
          <ul className="space-y-2">
            {connectableForEmployee.map((def) => {
              const ownRow = ownedByEmployee.get(def.key);
              return (
                <li
                  key={def.key}
                  className="flex items-center justify-between gap-4"
                >
                  <span className="text-sm text-zinc-300">{def.name}</span>
                  {ownRow ? (
                    <ConnectSkillControl installed={ownRow} def={def} />
                  ) : (
                    <Button
                      variant="violet"
                      onClick={() => install.mutate({ skillKey: def.key, employeeId })}
                      disabled={install.isPending}
                    >
                      {install.isPending ? 'Connecting…' : `Connect ${def.name}`}
                    </Button>
                  )}
                </li>
              );
            })}
          </ul>
        </section>
      )}
    </div>
  );
}
