'use client';

import {
  Banknote,
  Building2,
  ChevronDown,
  Crown,
  Handshake,
  Headphones,
  Megaphone,
  ShieldCheck,
  UserRound,
  Users,
  Wrench,
  type LucideIcon,
} from 'lucide-react';
import { useCurrentCompany } from '@/features/tenant/hooks';
import { useUsers } from '@/features/users/hooks';
import { useDepartments, useTeams } from '../hooks';

/** Best-effort icon per department name (cosmetic only) — falls back to a generic building. */
function iconForDepartment(name: string): LucideIcon {
  const n = name.toLowerCase();
  if (/hr|people|human/.test(n)) return Users;
  if (/sale|revenue|business/.test(n)) return Handshake;
  if (/recruit|talent/.test(n)) return UserRound;
  if (/financ|account/.test(n)) return Banknote;
  if (/marketing|growth|brand/.test(n)) return Megaphone;
  if (/eng|dev|product|tech/.test(n)) return Wrench;
  if (/support|success|service|care/.test(n)) return Headphones;
  if (/legal|complian|security|risk/.test(n)) return ShieldCheck;
  return Building2;
}

/**
 * Overview tab: an org-chart-style visual — the account owner fanning out to
 * each department. Departments/Teams/Users have no "member" field anywhere in
 * the DTOs, so each card shows its real team count (teams whose departmentId
 * matches), not an invented headcount.
 */
export function OrgOverview() {
  const { data: departments, isLoading, isError, error } = useDepartments();
  const { data: teams } = useTeams();
  const { data: users } = useUsers();
  const { data: company } = useCurrentCompany();

  const owner = users?.find((u) => u.role === 'OWNER');
  const depts = departments ?? [];

  const teamCountFor = (departmentId: string) =>
    (teams ?? []).filter((t) => t.departmentId === departmentId).length;

  return (
    <section className="rounded-2xl border border-app-border bg-app-surface p-6 sm:p-8">
      <div className="flex justify-center">
        <div className="inline-flex items-center gap-3 rounded-2xl border border-app-border bg-app-raised px-5 py-3.5">
          <span className="flex h-11 w-11 shrink-0 items-center justify-center rounded-full bg-[linear-gradient(135deg,#6a30ec_0%,#5216dd_100%)] shadow-[0_10px_24px_-8px_rgba(91,33,230,0.75)]">
            <Crown className="h-5 w-5 text-app-ink" />
          </span>
          <div>
            <p className="font-bold text-app-ink">
              {owner?.name ?? company?.name ?? 'Owner'}
            </p>
            <p className="text-xs text-app-ink-3">Owner</p>
          </div>
        </div>
      </div>

      {isLoading ? (
        <p className="mt-8 text-center text-sm text-app-ink-3">Loading organization…</p>
      ) : isError ? (
        <p className="mt-8 text-center text-sm text-red-600">
          {error?.message ?? 'Could not load departments'}
        </p>
      ) : depts.length === 0 ? (
        <p className="mt-8 text-center text-sm text-app-ink-3">
          No departments yet — add one from the Departments tab.
        </p>
      ) : (
        <>
          {/* Single shared connector (not per-card) so it stays correct however
              many departments wrap to a second row — no dangling stray stems. */}
          <div className="flex justify-center">
            <div className="flex flex-col items-center">
              <div className="h-6 w-px bg-violet/40" />
              <ChevronDown className="-mt-1 h-3 w-3 text-violet/70" />
            </div>
          </div>
          <div className="grid grid-cols-1 gap-4 border-t border-violet/25 pt-8 sm:grid-cols-2 lg:grid-cols-4">
            {depts.map((dept) => {
              const Icon = iconForDepartment(dept.name);
              const count = teamCountFor(dept.id);
              return (
                <div
                  key={dept.id}
                  className="rounded-xl border border-app-border bg-app-surface p-4 transition-colors hover:border-app-border-strong"
                >
                  <div className="mb-2 flex h-8 w-8 items-center justify-center rounded-lg bg-violet/15">
                    <Icon className="h-4 w-4 text-violet" />
                  </div>
                  <p className="font-bold text-app-ink">{dept.name}</p>
                  <p className="text-xs text-app-ink-3">
                    {count === 0 ? 'No teams' : count === 1 ? '1 team' : `${count} teams`}
                  </p>
                </div>
              );
            })}
          </div>
        </>
      )}
    </section>
  );
}
