'use client';

import { useState } from 'react';
import { Check, CircleDashed, Loader2, X } from 'lucide-react';
import { Button } from '@/components/ui/Button';
import { ConfigureSkillForm } from './ConfigureSkillForm';
import { useVerifyConnection } from '../hooks';
import type { VerifyStepResult } from '../api';
import type { InstalledSkillDto, SkillDefinitionDto } from '../schemas';

/**
 * The universal connection wizard (plan §26), driving the §3 state machine.
 *
 * ## Why a wizard and not the old inline box
 *
 * The previous flow was one "API key" input and a Save button, for every skill.
 * For email that field had no meaning at all — a mailbox needs a server, a port,
 * a security mode, a username and a password — and pressing Save marked the
 * connector CONNECTED without contacting anything. So the customer got
 * "Installed" on one screen, "Not connected" on another, and no way to tell
 * which was true. §1 names that exact anti-pattern.
 *
 * The wizard makes the stages explicit and SEQUENTIAL: you cannot reach "Ready"
 * without the provider having actually accepted the credentials, and each stage
 * shows what it proved.
 *
 * ## Scope
 *
 * Rendering the fields is delegated to the existing data-driven
 * {@link ConfigureSkillForm}, which already handles every field type and routes
 * `secret: true` values into encrypted storage. The wizard only owns the
 * sequence — it deliberately does not become a second form implementation.
 */
type Stage = 'details' | 'verify' | 'test' | 'done';

const ORDER: { key: Stage; label: string }[] = [
  { key: 'details', label: 'Details' },
  { key: 'verify', label: 'Sign in' },
  { key: 'test', label: 'Test' },
  { key: 'done', label: 'Ready' },
];

export function SkillSetupWizard({
  installed,
  def,
  onClose,
}: {
  installed: InstalledSkillDto;
  def: SkillDefinitionDto;
  onClose?: () => void;
}) {
  const [stage, setStage] = useState<Stage>(
    // Already connected → the user is here to re-test or fix, not to start over.
    installed.connectionStatus === 'CONNECTED' ? 'test' : 'details',
  );
  const [steps, setSteps] = useState<VerifyStepResult[]>([]);
  const [account, setAccount] = useState<string | null>(null);
  const [testTo, setTestTo] = useState('');
  const verify = useVerifyConnection();

  const run = (sendTest: boolean) => {
    verify.mutate(
      { id: installed.id, sendTest, testTo: sendTest ? testTo : undefined },
      {
        onSuccess: (result) => {
          setSteps(result.steps);
          setAccount(result.account);
          if (!result.ok) return;
          setStage(sendTest ? 'done' : 'test');
        },
      },
    );
  };

  const currentIndex = ORDER.findIndex((s) => s.key === stage);

  return (
    <div className="rounded-2xl border border-white/[0.1] bg-white/[0.02] p-4">
      <div className="mb-4 flex items-start justify-between gap-3">
        <div>
          <p className="text-sm font-semibold text-white">
            Connect {def.name}
          </p>
          <p className="mt-0.5 text-xs text-zinc-500">
            Each step has to pass before this skill can run.
          </p>
        </div>
        {onClose ? (
          <button
            type="button"
            onClick={onClose}
            aria-label="Close setup"
            className="rounded-lg p-1 text-zinc-500 hover:bg-white/[0.06] hover:text-zinc-300"
          >
            <X className="h-4 w-4" aria-hidden />
          </button>
        ) : null}
      </div>

      {/* The rail. Numbered because §26's whole point is that the customer can
          see how far through they are and what is left. */}
      <ol className="mb-4 flex flex-wrap items-center gap-x-4 gap-y-2">
        {ORDER.map((s, i) => {
          const state = i < currentIndex ? 'done' : i === currentIndex ? 'current' : 'todo';
          return (
            <li key={s.key} className="flex items-center gap-1.5 text-xs">
              <span
                className={`flex h-5 w-5 items-center justify-center rounded-full text-[10px] font-semibold ${
                  state === 'done'
                    ? 'bg-status-succeeded/20 text-status-succeeded'
                    : state === 'current'
                      ? 'bg-violet text-white'
                      : 'bg-white/[0.06] text-zinc-500'
                }`}
              >
                {state === 'done' ? <Check className="h-3 w-3" aria-hidden /> : i + 1}
              </span>
              <span className={state === 'todo' ? 'text-zinc-600' : 'text-zinc-300'}>
                {s.label}
              </span>
            </li>
          );
        })}
      </ol>

      {stage === 'details' ? (
        <ConfigureSkillForm
          installed={installed}
          def={def}
          onDone={() => setStage('verify')}
        />
      ) : null}

      {stage === 'verify' ? (
        <div className="space-y-3">
          <p className="text-sm text-zinc-300">
            Orlixa will sign in to the provider with the details you saved. Nothing
            is sent yet.
          </p>
          <StepList steps={steps} />
          <div className="flex items-center gap-2">
            <Button variant="violet" onClick={() => run(false)} disabled={verify.isPending}>
              {verify.isPending ? 'Checking…' : 'Check connection'}
            </Button>
            <button
              type="button"
              onClick={() => setStage('details')}
              className="text-xs text-zinc-400 hover:text-zinc-200"
            >
              Back to details
            </button>
          </div>
        </div>
      ) : null}

      {stage === 'test' ? (
        <div className="space-y-3">
          {account ? (
            <p className="text-sm text-status-succeeded">
              Signed in as {account}.
            </p>
          ) : null}
          <p className="text-sm text-zinc-300">
            Send one real test message to prove it works end to end.
          </p>
          <div className="flex flex-wrap items-center gap-2">
            <input
              type="email"
              value={testTo}
              onChange={(e) => setTestTo(e.target.value)}
              // Defaulting to the connection's own address means the obvious
              // action can never email a stranger.
              placeholder={account ? `${account} (itself)` : 'Where to send it'}
              aria-label="Send the test to"
              className="field-modern max-w-xs"
            />
            <Button variant="violet" onClick={() => run(true)} disabled={verify.isPending}>
              {verify.isPending ? 'Sending…' : 'Send test'}
            </Button>
            <button
              type="button"
              onClick={() => setStage('done')}
              className="text-xs text-zinc-400 hover:text-zinc-200"
            >
              Skip the test
            </button>
          </div>
          <StepList steps={steps} />
        </div>
      ) : null}

      {stage === 'done' ? (
        <div className="space-y-3">
          <p className="flex items-center gap-1.5 text-sm text-status-succeeded">
            <Check className="h-4 w-4" aria-hidden />
            {def.name} is connected{account ? ` as ${account}` : ''}.
          </p>
          <StepList steps={steps} />
          {onClose ? (
            <Button variant="violet" onClick={onClose}>
              Done
            </Button>
          ) : null}
        </div>
      ) : null}

      {verify.isError ? (
        <p className="mt-3 text-sm text-status-failed">
          {verify.error?.message ?? 'Could not check the connection.'}
        </p>
      ) : null}
    </div>
  );
}

/**
 * The per-stage result list.
 *
 * SKIPPED is rendered distinctly from PASSED on purpose: §37 is explicit that a
 * connection is only complete once it has been tested, so a stage that did not
 * run must never look like one that succeeded.
 */
function StepList({ steps }: { steps: VerifyStepResult[] }) {
  if (steps.length === 0) return null;
  return (
    <ul className="space-y-1.5 rounded-xl border border-white/[0.06] bg-white/[0.02] p-3">
      {steps.map((s) => (
        <li key={s.key} className="flex items-start gap-2 text-xs">
          {s.status === 'PASSED' ? (
            <Check className="mt-0.5 h-3.5 w-3.5 shrink-0 text-status-succeeded" aria-hidden />
          ) : s.status === 'FAILED' ? (
            <X className="mt-0.5 h-3.5 w-3.5 shrink-0 text-status-failed" aria-hidden />
          ) : (
            <CircleDashed className="mt-0.5 h-3.5 w-3.5 shrink-0 text-zinc-600" aria-hidden />
          )}
          <div className="min-w-0">
            <p
              className={
                s.status === 'FAILED'
                  ? 'text-status-failed'
                  : s.status === 'PASSED'
                    ? 'text-zinc-200'
                    : 'text-zinc-500'
              }
            >
              {s.label}
              {s.status === 'SKIPPED' ? ' — not run' : ''}
            </p>
            {s.detail ? (
              <p className="mt-0.5 break-words text-zinc-500">{s.detail}</p>
            ) : null}
          </div>
        </li>
      ))}
    </ul>
  );
}

/** Small spinner used by callers that mount the wizard lazily. */
export function WizardLoading() {
  return (
    <div className="flex items-center gap-2 p-4 text-xs text-zinc-500">
      <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden />
      Loading setup…
    </div>
  );
}
