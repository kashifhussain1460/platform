'use client';

import { useState } from 'react';
import Link from 'next/link';
import type { WorkflowDto, WorkflowTemplateDto } from '@vaep/types';
import { Button } from '@/components/ui/Button';
import { useInstallWorkflowTemplate, useMarketplace } from '../hooks';
import { categoryBadgeClass, categoryIcon } from '../labels';

/** One workflow-template card → Install (optimistic). Same card recipe as
 * the employee templates so the two sections read as one catalog. */
function WorkflowTemplateCard({ template }: { template: WorkflowTemplateDto }) {
  const install = useInstallWorkflowTemplate();
  const [created, setCreated] = useState<WorkflowDto | null>(null);

  const onInstall = () => {
    install.mutate(
      { key: template.key, name: template.name },
      { onSuccess: (workflow) => setCreated(workflow) },
    );
  };

  const stepCount = template.definition.nodes.length;
  const Icon = categoryIcon(template.category);

  return (
    <li className="rounded-2xl border border-app-border bg-app-surface p-5 transition-colors hover:border-app-border-strong">
      <div className="flex items-start gap-3">
        <span
          className={`flex h-11 w-11 shrink-0 items-center justify-center rounded-xl ${categoryBadgeClass(template.category)}`}
        >
          <Icon className="h-5 w-5" strokeWidth={2} />
        </span>
        <div className="min-w-0 flex-1">
          <p className="font-bold text-app-ink">{template.name}</p>
          <p className="text-xs text-app-ink-3">{template.category}</p>
        </div>
      </div>

      <p className="mt-3 text-sm text-app-ink-2">{template.description}</p>
      <p className="mt-2 text-xs text-app-ink-3">
        {stepCount} steps: {template.definition.nodes.map((n) => n.type).join(' → ')}
      </p>

      <div className="mt-4">
        <Button variant="violet" onClick={onInstall} disabled={install.isPending}>
          {install.isPending ? 'Installing…' : 'Install'}
        </Button>
      </div>

      {created && !created.id.startsWith('temp_') && (
        <p className="mt-3 text-xs text-green-700">
          Installed.{' '}
          <Link
            href={`/workflows/${created.id}`}
            className="font-medium text-violet underline hover:text-app-ink"
          >
            Open workflow →
          </Link>
        </p>
      )}
    </li>
  );
}

/** Workflow Templates section. */
export function WorkflowTemplateList() {
  const { data, isLoading } = useMarketplace();

  if (isLoading) {
    return <p className="text-sm text-app-ink-3">Loading templates…</p>;
  }

  return (
    <ul className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
      {(data?.workflows ?? []).map((template) => (
        <WorkflowTemplateCard key={template.key} template={template} />
      ))}
    </ul>
  );
}
