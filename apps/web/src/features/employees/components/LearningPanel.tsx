'use client';

import { useState } from 'react';
import { Button } from '@/components/ui/Button';
import {
  useEmployeeLearning,
  useEmployeeMemories,
  useForgetMemory,
  useTeachMemory,
} from '../hooks';

const SOURCE_LABELS: Record<string, string> = {
  FEEDBACK: 'from feedback',
  MANUAL: 'taught',
  RUN: 'from a run',
};

/**
 * Learning panel (Step 15): feedback tallies, the durable memories the employee
 * has learned (with Teach a fact / Forget), and recent feedback. Optimistic
 * add/delete of memories.
 */
export function LearningPanel({ employeeId }: { employeeId: string }) {
  const { data: learning } = useEmployeeLearning(employeeId);
  const { data: memories } = useEmployeeMemories(employeeId);
  const teach = useTeachMemory(employeeId);
  const forget = useForgetMemory(employeeId);
  const [fact, setFact] = useState('');

  const onTeach = () => {
    const content = fact.trim();
    if (!content) return;
    teach.mutate({ kind: 'FACT', content }, { onSuccess: () => setFact('') });
  };

  const fb = learning?.feedback;
  const recent = learning?.recentFeedback ?? [];

  return (
    <section className="rounded-2xl border border-app-border bg-app-surface p-5">
      <h2 className="mb-4 text-sm font-medium text-app-ink">Learning</h2>

      {/* Feedback summary */}
      <div className="mb-5 grid grid-cols-3 gap-3">
        <div className="rounded-xl border border-app-border bg-app-surface p-3 text-center">
          <p className="text-lg font-semibold text-green-700">{fb?.up ?? 0}</p>
          <p className="text-xs text-app-ink-3">👍 Helpful</p>
        </div>
        <div className="rounded-xl border border-app-border bg-app-surface p-3 text-center">
          <p className="text-lg font-semibold text-red-600">{fb?.down ?? 0}</p>
          <p className="text-xs text-app-ink-3">👎 Needs work</p>
        </div>
        <div className="rounded-xl border border-app-border bg-app-surface p-3 text-center">
          <p className="text-lg font-semibold text-app-ink">
            {learning?.memories.total ?? 0}
          </p>
          <p className="text-xs text-app-ink-3">Memories</p>
        </div>
      </div>

      {/* Teach a fact */}
      <div className="mb-4 flex gap-2">
        <input
          type="text"
          value={fact}
          onChange={(e) => setFact(e.target.value)}
          placeholder="Teach the employee a fact it should remember…"
          className="field-modern"
        />
        <Button
          variant="violet"
          type="button"
          onClick={onTeach}
          disabled={teach.isPending || !fact.trim()}
        >
          {teach.isPending ? 'Teaching…' : 'Teach'}
        </Button>
      </div>

      {/* Memories list */}
      <h3 className="mb-2 text-xs font-medium text-app-ink-3">
        What this employee has learned
      </h3>
      {(memories ?? []).length === 0 ? (
        <p className="mb-4 text-sm text-app-ink-3">
          Nothing learned yet. Teach a fact or leave feedback in chat.
        </p>
      ) : (
        <ul className="mb-4 space-y-2">
          {(memories ?? []).map((m) => (
            <li
              key={m.id}
              className="flex items-start justify-between gap-3 rounded-xl border border-app-border bg-app-surface px-3 py-2"
            >
              <div className="min-w-0">
                <p className="break-words text-sm text-app-ink">{m.content}</p>
                <p className="mt-0.5 text-xs text-app-ink-3">
                  {m.kind}
                  {m.source ? ` · ${SOURCE_LABELS[m.source] ?? m.source}` : ''}
                </p>
              </div>
              <button
                type="button"
                className="shrink-0 text-xs text-app-ink-3 hover:text-red-600"
                disabled={forget.isPending}
                onClick={() => forget.mutate(m.id)}
              >
                Forget
              </button>
            </li>
          ))}
        </ul>
      )}

      {/* Recent feedback */}
      {recent.length > 0 && (
        <>
          <h3 className="mb-2 text-xs font-medium text-app-ink-3">
            Recent feedback
          </h3>
          <ul className="space-y-1">
            {recent.map((f) => (
              <li key={f.id} className="flex items-start gap-2 text-sm">
                <span>{f.rating === 'UP' ? '👍' : '👎'}</span>
                <span className="text-app-ink-2">
                  {f.correction || f.note || (
                    <span className="text-app-ink-3">(no note)</span>
                  )}
                </span>
              </li>
            ))}
          </ul>
        </>
      )}
    </section>
  );
}
