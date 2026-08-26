'use client';

import { useState } from 'react';
import { Button } from '@/components/ui/Button';
import { useDeleteDepartment, useDepartmentDependencies } from '../hooks';
import type { DepartmentDto } from '../schemas';

/**
 * Removing a department, with the consequence stated first.
 *
 * `User.departmentId` is `onDelete: SetNull`. Deleting a department that limits
 * its members to, say, HR therefore turns every one of those people into an
 * unrestricted company-wide reader — instantly, silently, and with nothing in
 * the old one-line `window.confirm` to suggest it. Privilege escalation by
 * deletion is still privilege escalation.
 *
 * So the flow is: show who is affected → offer to move them somewhere → and
 * only then allow the widening, named for what it is.
 */
export function DeleteDepartmentDialog({
  dept,
  allDepartments,
  onClose,
}: {
  dept: DepartmentDto;
  allDepartments: DepartmentDto[];
  onClose: () => void;
}) {
  const { data: deps, isLoading } = useDepartmentDependencies(dept.id);
  const del = useDeleteDepartment();
  const [reassignTo, setReassignTo] = useState('');

  const others = allDepartments.filter((d) => d.id !== dept.id);
  const memberCount = deps?.members.length ?? 0;
  const teamCount = deps?.teams.length ?? 0;
  const widens = deps?.wouldWidenAccess ?? false;
  // With members and no destination chosen, the only remaining path is the
  // explicit one — so the button has to say so rather than just "Remove".
  const forcing = memberCount > 0 && !reassignTo;

  const submit = () =>
    del.mutate(
      { id: dept.id, reassignTo: reassignTo || null, force: forcing },
      { onSuccess: onClose },
    );

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label={`Remove ${dept.name}`}
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4"
    >
      <div className="w-full max-w-lg space-y-4 rounded-2xl border border-app-border bg-app-surface p-5 shadow-xl">
        <h3 className="text-base font-semibold text-app-ink">
          Remove “{dept.name}”?
        </h3>

        {isLoading ? (
          <p className="text-sm text-app-ink-3">Checking what this affects…</p>
        ) : (
          <>
            <div className="space-y-2 rounded-xl border border-app-border bg-app-raised p-3 text-sm">
              <p className="text-app-ink-2">
                {memberCount === 0
                  ? 'Nobody is in this department.'
                  : `${memberCount} ${memberCount === 1 ? 'person is' : 'people are'} in this department: ${deps?.members
                      .map((m) => m.name)
                      .join(', ')}.`}
              </p>
              {teamCount > 0 && (
                <p className="text-app-ink-3">
                  {teamCount} {teamCount === 1 ? 'team' : 'teams'} will be left without a
                  department. Teams are never deleted.
                </p>
              )}
              {widens && (
                <p className="font-medium text-sl-warning">
                  This department currently limits its members to{' '}
                  {deps?.scopes.join(', ')}. Removing it without moving them gives
                  them access to everything in the company.
                </p>
              )}
            </div>

            {memberCount > 0 && others.length > 0 && (
              <div>
                <label
                  htmlFor="reassign-to"
                  className="mb-1 block text-sm font-medium text-app-ink-2"
                >
                  Move everyone to
                </label>
                <select
                  id="reassign-to"
                  className="field-modern"
                  value={reassignTo}
                  onChange={(e) => setReassignTo(e.target.value)}
                >
                  <option value="">
                    Don’t move them — they become company-wide
                  </option>
                  {others.map((d) => (
                    <option key={d.id} value={d.id}>
                      {d.name}
                    </option>
                  ))}
                </select>
              </div>
            )}

            {memberCount > 0 && others.length === 0 && (
              <p className="text-sm text-app-ink-3">
                There is no other department to move them to. Create one first if you
                do not want them to become company-wide.
              </p>
            )}
          </>
        )}

        {del.isError && (
          <p className="text-sm text-red-600">
            {del.error?.message ?? 'Could not remove the department'}
          </p>
        )}

        <div className="flex justify-end gap-2">
          <button
            type="button"
            className="rounded-lg border border-app-border-strong bg-app-surface px-3.5 py-1.5 text-sm font-medium text-app-ink-2 hover:bg-app-raised"
            onClick={onClose}
          >
            Cancel
          </button>
          <Button
            type="button"
            variant="violet"
            onClick={submit}
            disabled={isLoading || del.isPending}
          >
            {del.isPending
              ? 'Removing…'
              : reassignTo
                ? 'Move everyone & remove'
                : forcing
                  ? 'Remove & make them company-wide'
                  : 'Remove department'}
          </Button>
        </div>
      </div>
    </div>
  );
}
