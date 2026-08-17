import { Mail, FileSearch, MailWarning, ScrollText } from 'lucide-react';
import type { ElementType } from 'react';
import { SlackIcon } from './brand-icons';

function Node({
  Icon,
  title,
  label,
  tone,
  className = '',
}: {
  Icon: ElementType<{ className?: string }>;
  title: string;
  label: string;
  tone: 'emerald' | 'violet' | 'sky' | 'rose';
  className?: string;
}) {
  const tones: Record<typeof tone, string> = {
    emerald: 'bg-emerald-400/15 text-emerald-400',
    violet: 'bg-violet/20 text-violet-bright',
    sky: 'bg-sky-400/15 text-sky-300',
    rose: 'bg-rose-400/15 text-rose-400',
  };
  return (
    <div
      className={`flex items-center gap-2.5 rounded-xl border border-white/[0.08] bg-void-card px-3.5 py-2.5 shadow-dark-card ${className}`}
    >
      <span className={`flex h-8 w-8 shrink-0 items-center justify-center rounded-lg p-1.5 ${tones[tone]}`}>
        <Icon className="h-full w-full" />
      </span>
      <div className="min-w-0">
        <p className="truncate text-[13px] font-semibold text-white">{title}</p>
        <p className="truncate text-[11px] text-fg-muted">{label}</p>
      </div>
    </div>
  );
}

/** No-code workflow builder mockup: trigger → AI step → condition → branches. */
export function WorkflowDiagram() {
  return (
    <div className="overflow-x-auto rounded-2xl border border-white/[0.08] bg-void-section p-6 sm:p-8">
      <div className="flex min-w-[720px] items-center justify-center gap-3">
        <Node Icon={Mail} title="New Email" label="Trigger" tone="emerald" />
        <Connector />
        <Node Icon={FileSearch} title="Extract Data" label="AI Step" tone="violet" />
        <Connector />

        <div className="flex h-16 w-16 shrink-0 rotate-45 items-center justify-center rounded-xl border border-white/[0.1] bg-void-card">
          <span className="-rotate-45 text-center text-[11px] font-semibold leading-tight text-white">
            Approved?
          </span>
        </div>

        <div className="flex flex-col gap-3">
          <div className="flex items-center gap-2">
            <span className="text-[11px] font-medium text-emerald-400">Yes</span>
            <Connector short />
            <Node Icon={SlackIcon} title="Notify Manager" label="Slack" tone="sky" />
          </div>
          <div className="flex items-center gap-2">
            <span className="text-[11px] font-medium text-rose-400">No</span>
            <Connector short />
            <Node Icon={MailWarning} title="Send Rejection" label="Email" tone="rose" />
          </div>
        </div>
      </div>

      <div className="mt-4 flex min-w-[720px] justify-center">
        <Node Icon={ScrollText} title="Log Activity" label="Notion" tone="violet" className="opacity-90" />
      </div>
    </div>
  );
}

function Connector({ short = false }: { short?: boolean }) {
  return <span className={`h-px shrink-0 bg-white/[0.15] ${short ? 'w-4' : 'w-8'}`} aria-hidden />;
}
