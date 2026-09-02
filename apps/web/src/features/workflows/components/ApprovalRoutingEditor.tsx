'use client';

import type {
  ApprovalEscalationStep,
  ApprovalOnTimeout,
  ApprovalRoutingConfig,
  ApprovalRoutingLevel,
  ApproverRuleType,
} from '@vaep/types';
import { useDepartments, useTeams } from '@/features/organization/hooks';
import { useUsers } from '@/features/users/hooks';

/**
 * Who has to sign off, and what happens if nobody does.
 *
 * ## Why this component exists
 *
 * The whole routing engine — six rule types, sequential multi-level sign-off,
 * per-level time limits, ordered fallback chains, and four timeout policies —
 * has been in the database, the service layer, the migration and the test suite
 * since Wave P3-05. The 2026-09-02 audit found it had **no user interface at
 * all**: `grep -rln "approverRule\|escalationChain" apps/web/src` returned
 * nothing, and the APPROVAL node editor rendered only `message` and
 * `autoApprove` even though the node catalog declares a `routing` key.
 *
 * The consequence for a customer was that every approval a workflow created was
 * *unrouted*, which falls back to "any OWNER or ADMIN may decide". Routing to a
 * department head, a named person, or the AI Employee's own manager was a
 * feature that existed everywhere except where someone could turn it on.
 *
 * ## Design notes
 *
 * - **Plain language over the domain vocabulary.** The backend calls these
 *   levels, escalation chains, SLA minutes and timeout policies. A customer
 *   configuring sign-off for their own company is asked "Who has to approve
 *   this?", "If they don't respond within…", "Then ask…" and "If still nobody
 *   responds". The stored JSON is unchanged.
 * - **Real pickers, not id fields.** The rule type decides what the target
 *   means (a user id, a Role, a Department id, a Team id, or nothing at all),
 *   so the second control changes with the first. Typing a raw cuid into a text
 *   box was never going to be the answer.
 * - **`AUTO_APPROVE` is marked as the dangerous one.** Doc 08 §8.2.11 makes
 *   `NONE` the default deliberately; a timeout that approves on the customer's
 *   behalf deserves to look different from one that does not.
 * - **No routing is a valid, explicit choice.** With no levels the request is
 *   unrouted and any owner or admin can decide, which is the historical
 *   behaviour every existing workflow relies on. The empty state says so rather
 *   than implying the feature is broken.
 */

const RULE_LABELS: Record<ApproverRuleType, string> = {
  ANY_ADMIN: 'Any owner or admin',
  USER: 'A specific person',
  ROLE: 'Anyone with a role',
  DEPARTMENT: 'Anyone in a department',
  TEAM: 'Anyone on a team',
  EMPLOYEE_MANAGER: "The AI Employee's manager",
};

/** Rule types whose `target` is meaningless — the rule resolves the person itself. */
const RULES_WITHOUT_TARGET: ReadonlySet<ApproverRuleType> = new Set<ApproverRuleType>([
  'ANY_ADMIN',
  'EMPLOYEE_MANAGER',
]);

const TIMEOUT_LABELS: Record<ApprovalOnTimeout, string> = {
  NONE: 'Keep waiting — the run stays paused',
  ESCALATE: 'Pass it up the fallback list',
  AUTO_REJECT: 'Reject it and stop the run',
  AUTO_APPROVE: 'Approve it automatically',
};

const TIMEOUT_ORDER: readonly ApprovalOnTimeout[] = [
  'NONE',
  'ESCALATE',
  'AUTO_REJECT',
  'AUTO_APPROVE',
];

const selectCls = 'field-modern text-sm';
const numberCls = 'field-modern text-sm';

/** Friendly minute presets; a level with no limit simply never times out. */
const SLA_PRESETS: readonly { label: string; minutes: number | undefined }[] = [
  { label: 'No time limit', minutes: undefined },
  { label: '30 minutes', minutes: 30 },
  { label: '1 hour', minutes: 60 },
  { label: '4 hours', minutes: 240 },
  { label: '1 day', minutes: 1440 },
  { label: '3 days', minutes: 4320 },
];

export function ApprovalRoutingEditor({
  value,
  onChange,
}: {
  value: ApprovalRoutingConfig | undefined;
  onChange: (next: ApprovalRoutingConfig | undefined) => void;
}) {
  const { data: users } = useUsers();
  const { data: departments } = useDepartments();
  const { data: teams } = useTeams();

  const levels = value?.levels ?? [];

  const setLevels = (next: ApprovalRoutingLevel[]) => {
    // Dropping the last level removes the whole config rather than storing
    // `{ levels: [] }`. The backend treats an empty array and an absent config
    // identically, and an absent key keeps the saved graph honest about the
    // fact that nothing is configured.
    if (next.length === 0) {
      onChange(undefined);
      return;
    }
    onChange({ ...value, levels: next });
  };

  const patchLevel = (index: number, patch: Partial<ApprovalRoutingLevel>) => {
    setLevels(levels.map((l, i) => (i === index ? { ...l, ...patch } : l)));
  };

  /**
   * Changing the rule CLEARS the target, deliberately. A department id left
   * behind on a rule that now means "a specific person" would be stored, sent,
   * and silently match nobody — the request would sit undecidable for ever.
   */
  const changeRule = (index: number, rule: ApproverRuleType) => {
    patchLevel(index, { rule, target: undefined });
  };

  /** Target picker for a rule, or an explanation when the rule needs none. */
  const renderTarget = (
    rule: ApproverRuleType,
    target: string | undefined,
    onTarget: (next: string | undefined) => void,
  ) => {
    if (RULES_WITHOUT_TARGET.has(rule)) {
      return (
        <p className="text-xs text-app-ink-3">
          {rule === 'EMPLOYEE_MANAGER'
            ? "Whoever is set as the manager on the AI Employee running this step. Set that on the employee's Settings tab."
            : 'Everyone with the owner or admin role can decide.'}
        </p>
      );
    }

    const options =
      rule === 'USER'
        ? (users ?? []).map((u) => ({ value: u.id, label: `${u.name} · ${u.email}` }))
        : rule === 'DEPARTMENT'
          ? (departments ?? []).map((d) => ({ value: d.id, label: d.name }))
          : rule === 'TEAM'
            ? (teams ?? []).map((t) => ({ value: t.id, label: t.name }))
            : [
                { value: 'OWNER', label: 'Owner' },
                { value: 'ADMIN', label: 'Admin' },
                { value: 'MEMBER', label: 'Member' },
              ];

    if (options.length === 0) {
      // Honest empty state with the fix, rather than an empty dropdown that
      // looks like a loading bug.
      return (
        <p className="text-xs text-sl-warning">
          {rule === 'DEPARTMENT'
            ? 'No departments yet — add one under Organization first.'
            : rule === 'TEAM'
              ? 'No teams yet — add one under Organization first.'
              : 'No people to choose from yet — invite someone under Team first.'}
        </p>
      );
    }

    return (
      <select
        className={selectCls}
        value={target ?? ''}
        onChange={(e) => onTarget(e.target.value || undefined)}
      >
        <option value="">Choose…</option>
        {options.map((o) => (
          <option key={o.value} value={o.value}>
            {o.label}
          </option>
        ))}
      </select>
    );
  };

  const renderSla = (
    minutes: number | undefined,
    onMinutes: (next: number | undefined) => void,
  ) => {
    const isPreset = SLA_PRESETS.some((p) => p.minutes === minutes);
    return (
      <div className="flex flex-wrap items-center gap-2">
        <select
          className={selectCls}
          value={isPreset ? String(minutes ?? '') : 'custom'}
          onChange={(e) => {
            if (e.target.value === 'custom') {
              onMinutes(minutes ?? 60);
              return;
            }
            onMinutes(e.target.value === '' ? undefined : Number(e.target.value));
          }}
        >
          {SLA_PRESETS.map((p) => (
            <option key={p.label} value={p.minutes === undefined ? '' : String(p.minutes)}>
              {p.label}
            </option>
          ))}
          <option value="custom">Custom…</option>
        </select>
        {!isPreset && (
          <span className="flex items-center gap-1.5 text-xs text-app-ink-2">
            <input
              type="number"
              min={1}
              className={`${numberCls} w-24`}
              value={minutes ?? ''}
              onChange={(e) =>
                onMinutes(e.target.value === '' ? undefined : Number(e.target.value))
              }
            />
            minutes
          </span>
        )}
      </div>
    );
  };

  if (levels.length === 0) {
    return (
      <div className="rounded-xl border border-dashed border-app-border p-4">
        <p className="text-sm text-app-ink-2">
          Anyone who owns or administers this company can approve this step.
        </p>
        <p className="mt-1 text-xs text-app-ink-3">
          Add a rule if it should go to a specific person, a department, a team, or the
          AI Employee&rsquo;s manager instead — and to set a time limit.
        </p>
        <button
          type="button"
          onClick={() => setLevels([{ rule: 'ANY_ADMIN' }])}
          className="mt-3 rounded-lg border border-app-border-strong px-3 py-1.5 text-sm font-medium text-app-ink hover:bg-app-raised"
        >
          Choose who approves
        </button>
      </div>
    );
  }

  return (
    <div className="space-y-3">
      {levels.map((level, index) => {
        const chain = level.escalationChain ?? [];
        const patchChain = (next: ApprovalEscalationStep[]) =>
          patchLevel(index, { escalationChain: next.length > 0 ? next : undefined });

        return (
          <div
            key={index}
            className="rounded-xl border border-app-border bg-app-surface p-4"
          >
            <div className="mb-3 flex items-center justify-between">
              <p className="text-xs font-semibold uppercase tracking-wide text-app-ink-3">
                {levels.length > 1 ? `Sign-off ${index + 1} of ${levels.length}` : 'Who approves'}
              </p>
              <button
                type="button"
                onClick={() => setLevels(levels.filter((_, i) => i !== index))}
                className="text-xs font-medium text-app-ink-3 hover:text-sl-failed"
              >
                Remove
              </button>
            </div>

            <div className="grid gap-3 sm:grid-cols-2">
              <div>
                <label className="mb-1 block text-xs font-medium text-app-ink-2">
                  Send it to
                </label>
                <select
                  className={selectCls}
                  value={level.rule}
                  onChange={(e) => changeRule(index, e.target.value as ApproverRuleType)}
                >
                  {(Object.keys(RULE_LABELS) as ApproverRuleType[]).map((rule) => (
                    <option key={rule} value={rule}>
                      {RULE_LABELS[rule]}
                    </option>
                  ))}
                </select>
              </div>
              <div>
                <label className="mb-1 block text-xs font-medium text-app-ink-2">
                  Which one
                </label>
                {renderTarget(level.rule, level.target, (target) =>
                  patchLevel(index, { target }),
                )}
              </div>
            </div>

            <div className="mt-3 grid gap-3 sm:grid-cols-2">
              <div>
                <label className="mb-1 block text-xs font-medium text-app-ink-2">
                  If they don&rsquo;t respond within
                </label>
                {renderSla(level.slaMinutes, (slaMinutes) =>
                  patchLevel(index, { slaMinutes }),
                )}
              </div>
              <div>
                <label className="mb-1 block text-xs font-medium text-app-ink-2">
                  Then
                </label>
                <select
                  className={selectCls}
                  value={level.onTimeout ?? 'NONE'}
                  onChange={(e) =>
                    patchLevel(index, { onTimeout: e.target.value as ApprovalOnTimeout })
                  }
                  disabled={level.slaMinutes === undefined}
                >
                  {TIMEOUT_ORDER.map((policy) => (
                    <option key={policy} value={policy}>
                      {TIMEOUT_LABELS[policy]}
                    </option>
                  ))}
                </select>
                {level.slaMinutes === undefined && (
                  <p className="mt-1 text-xs text-app-ink-3">
                    Set a time limit first — without one there is nothing to time out.
                  </p>
                )}
                {level.onTimeout === 'AUTO_APPROVE' && level.slaMinutes !== undefined && (
                  <p className="mt-1 text-xs text-sl-warning">
                    This approves without a human. Whatever this step gates will happen on
                    its own.
                  </p>
                )}
              </div>
            </div>

            {/* The fallback list. Only worth showing once a time limit exists,
                because escalation is triggered by that limit being missed. */}
            {level.slaMinutes !== undefined && (
              <div className="mt-4 border-t border-app-border pt-3">
                <p className="mb-2 text-xs font-medium text-app-ink-2">
                  If the time limit passes, ask these people next — in order
                </p>
                {chain.length === 0 && (
                  <p className="mb-2 text-xs text-app-ink-3">
                    Nobody yet. A good last resort is “Any owner or admin”, so a person on
                    holiday can never block the run for ever.
                  </p>
                )}
                <div className="space-y-2">
                  {chain.map((hop, hopIndex) => (
                    <div
                      key={hopIndex}
                      className="grid items-start gap-2 rounded-lg bg-app-raised p-2 sm:grid-cols-[auto,1fr,1fr,auto]"
                    >
                      <span className="pt-2 text-xs font-medium text-app-ink-3">
                        {hopIndex + 1}.
                      </span>
                      <select
                        className={selectCls}
                        value={hop.rule}
                        onChange={(e) =>
                          patchChain(
                            chain.map((h, i) =>
                              i === hopIndex
                                ? {
                                    ...h,
                                    rule: e.target.value as ApproverRuleType,
                                    target: undefined,
                                  }
                                : h,
                            ),
                          )
                        }
                      >
                        {(Object.keys(RULE_LABELS) as ApproverRuleType[]).map((rule) => (
                          <option key={rule} value={rule}>
                            {RULE_LABELS[rule]}
                          </option>
                        ))}
                      </select>
                      <div>
                        {renderTarget(hop.rule, hop.target, (target) =>
                          patchChain(
                            chain.map((h, i) => (i === hopIndex ? { ...h, target } : h)),
                          ),
                        )}
                      </div>
                      <button
                        type="button"
                        onClick={() =>
                          patchChain(chain.filter((_, i) => i !== hopIndex))
                        }
                        className="pt-2 text-xs font-medium text-app-ink-3 hover:text-sl-failed"
                      >
                        Remove
                      </button>
                    </div>
                  ))}
                </div>
                <button
                  type="button"
                  onClick={() => patchChain([...chain, { rule: 'ANY_ADMIN' }])}
                  className="mt-2 text-xs font-medium text-violet hover:text-app-ink"
                >
                  + Add a fallback
                </button>
              </div>
            )}
          </div>
        );
      })}

      <div className="flex flex-wrap items-center gap-3">
        <button
          type="button"
          onClick={() => setLevels([...levels, { rule: 'ANY_ADMIN' }])}
          className="rounded-lg border border-app-border-strong px-3 py-1.5 text-sm font-medium text-app-ink hover:bg-app-raised"
        >
          + Add another sign-off
        </button>
        {levels.length > 1 && (
          <p className="text-xs text-app-ink-3">
            Each sign-off happens in order. The run stays paused until the last one
            approves.
          </p>
        )}
      </div>
    </div>
  );
}
