'use client';

import type { ToolCallDto } from '@vaep/types';

/** Renders the skill/tool actions an employee took during a run (chat metadata). */
export function ToolCallsPanel({ toolCalls }: { toolCalls: ToolCallDto[] }) {
  if (!toolCalls || toolCalls.length === 0) {
    return null;
  }

  return (
    <div className="mt-2 space-y-2 rounded-xl border border-app-border bg-app-surface p-3 text-xs">
      <p className="mb-1 font-medium text-app-ink-2">Actions taken</p>
      <ul className="space-y-1.5">
        {toolCalls.map((call, i) => (
          <li
            key={`${call.skillKey}-${call.tool}-${i}`}
            className="rounded-lg border border-app-border bg-app-surface p-2"
          >
            <div className="mb-0.5 flex items-center justify-between gap-2">
              <span className="font-medium text-app-ink-2">
                {call.skillKey} · {call.tool}
              </span>
              <span className="flex items-center gap-1.5">
                {/* An `ok:true` simulated call is not a real success — the mock
                    executor reports one whenever a skill isn't connected (or a
                    specific tool has no real implementation yet), so this has to
                    be visible right next to the status, not just in a tooltip
                    someone has to know to check. */}
                {call.simulated && (
                  <span
                    title="This ran on the mock executor — no real request was made."
                    className="inline-block rounded-full bg-amber-500/15 px-2 py-0.5 font-medium text-amber-800"
                  >
                    simulated
                  </span>
                )}
                <span
                  className={`inline-block rounded-full px-2 py-0.5 font-medium ${
                    call.pendingApproval
                      ? 'bg-amber-500/15 text-amber-800'
                      : call.ok
                        ? 'bg-green-500/15 text-green-800'
                        : 'bg-red-500/15 text-red-600'
                  }`}
                >
                  {call.pendingApproval
                    ? 'awaiting approval'
                    : call.ok
                      ? 'ok'
                      : 'failed'}
                </span>
              </span>
            </div>
            <pre className="overflow-x-auto whitespace-pre-wrap break-words text-app-ink-3">
              {JSON.stringify(call.result ?? call.args)}
            </pre>
          </li>
        ))}
      </ul>
    </div>
  );
}
