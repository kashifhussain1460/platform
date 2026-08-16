'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { ChevronRight, MessageSquare, Pause, Play, Settings } from 'lucide-react';
import { AppShell } from '@/components/app-shell/AppShell';
import { useAppShellProps } from '@/components/app-shell/useAppShellProps';
import { Button } from '@/components/ui/Button';
import { ChatPanel } from '@/features/employees/components/ChatPanel';
import { EmployeeAbout } from '@/features/employees/components/EmployeeAbout';
import { EmployeeSettings } from '@/features/employees/components/EmployeeSettings';
import { LearningPanel } from '@/features/employees/components/LearningPanel';
import {
  useConversations,
  useEmployee,
  useStartConversation,
  useUpdateEmployee,
} from '@/features/employees/hooks';
import { STATUS_STYLES, formatRole } from '@/features/employees/labels';
import { DocumentList } from '@/features/knowledge/components/DocumentList';
import { KnowledgeDropzone } from '@/features/knowledge/components/KnowledgeDropzone';
import { useDocuments } from '@/features/knowledge/hooks';
import type { EmployeeRole } from '@/features/knowledge/schemas';
import { EmployeeSkillPicker } from '@/features/skills/components/EmployeeSkillPicker';
import { useSessionStore } from '@/stores/session.store';

type TabId = 'overview' | 'chat' | 'memory' | 'tools' | 'knowledge' | 'settings';

const TABS: { id: TabId; label: string }[] = [
  { id: 'overview', label: 'Overview' },
  { id: 'chat', label: 'Chat' },
  { id: 'memory', label: 'Memory' },
  { id: 'tools', label: 'Tools' },
  { id: 'knowledge', label: 'Knowledge' },
  { id: 'settings', label: 'Settings' },
];

const secondaryBtnClass =
  'inline-flex items-center gap-1.5 rounded-xl border border-white/[0.12] bg-white/[0.03] px-4 py-2 text-sm font-medium text-zinc-300 transition-colors hover:border-white/25 hover:bg-white/[0.06] disabled:cursor-not-allowed disabled:opacity-50';

export default function EmployeeDetailPage({
  params,
}: {
  params: { id: string };
}) {
  const router = useRouter();
  const accessToken = useSessionStore((s) => s.accessToken);
  const shellProps = useAppShellProps();
  const employeeId = params.id;

  const { data: employee } = useEmployee(employeeId);
  const { data: conversations } = useConversations(employeeId);
  const startConversation = useStartConversation(employeeId);
  const updateEmployee = useUpdateEmployee();
  const [conversationId, setConversationId] = useState<string | null>(null);
  const [activeTab, setActiveTab] = useState<TabId>('overview');

  // Client-side route guard.
  useEffect(() => {
    if (!accessToken) {
      router.replace('/login');
    }
  }, [accessToken, router]);

  // Default to the most recent conversation once loaded.
  useEffect(() => {
    if (!conversationId && conversations && conversations.length > 0) {
      setConversationId(conversations[0].id);
    }
  }, [conversations, conversationId]);

  if (!accessToken) {
    return null;
  }

  const onStart = () => {
    startConversation.mutate(
      {},
      { onSuccess: (conversation) => setConversationId(conversation.id) },
    );
  };

  const togglePause = () => {
    if (!employee) return;
    updateEmployee.mutate({
      id: employee.id,
      data: { status: employee.status === 'ACTIVE' ? 'PAUSED' : 'ACTIVE' },
    });
  };

  return (
    <AppShell {...shellProps}>
      <nav className="mb-4 flex items-center gap-1.5 pt-2 text-sm text-zinc-500">
        <Link href="/employees" className="transition-colors hover:text-zinc-300">
          AI Employees
        </Link>
        <ChevronRight className="h-3.5 w-3.5" />
        <span className="text-zinc-300">{employee?.name ?? 'Loading…'}</span>
      </nav>

      <div className="mb-6 flex flex-wrap items-start justify-between gap-4">
        <div>
          <h1 className="text-2xl font-bold text-white sm:text-3xl">
            {employee?.name ?? 'Loading…'}
          </h1>
          <div className="mt-2 flex items-center gap-3">
            <span className="text-sm text-zinc-400">
              {employee ? formatRole(employee.role) : ''}
            </span>
            {employee && (
              <span
                className={`rounded-full px-2.5 py-0.5 text-xs font-medium ${STATUS_STYLES[employee.status]}`}
              >
                {employee.status}
              </span>
            )}
          </div>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          {employee && (
            <button
              type="button"
              onClick={togglePause}
              disabled={updateEmployee.isPending}
              className={secondaryBtnClass}
            >
              {employee.status === 'ACTIVE' ? (
                <>
                  <Pause className="h-4 w-4" />
                  Pause
                </>
              ) : (
                <>
                  <Play className="h-4 w-4" />
                  Resume
                </>
              )}
            </button>
          )}
          <button
            type="button"
            onClick={() => setActiveTab('chat')}
            className={secondaryBtnClass}
          >
            <MessageSquare className="h-4 w-4" />
            Chat
          </button>
          <button
            type="button"
            onClick={() => setActiveTab('settings')}
            className={secondaryBtnClass}
          >
            <Settings className="h-4 w-4" />
            Settings
          </button>
        </div>
      </div>

      <div className="mb-6 flex flex-wrap gap-1">
        {TABS.map((t) => (
          <button
            key={t.id}
            type="button"
            onClick={() => setActiveTab(t.id)}
            className={`rounded-xl px-4 py-2 text-sm font-medium transition-colors ${
              activeTab === t.id
                ? 'bg-violet text-white'
                : 'text-zinc-400 hover:bg-white/[0.04] hover:text-white'
            }`}
          >
            {t.label}
          </button>
        ))}
      </div>

      {activeTab === 'overview' &&
        (employee ? (
          <EmployeeAbout employee={employee} />
        ) : (
          <p className="text-sm text-zinc-500">Loading…</p>
        ))}

      {activeTab === 'chat' && (
        <div className="space-y-3">
          <div className="flex justify-end">
            <button
              type="button"
              onClick={onStart}
              disabled={startConversation.isPending}
              className={secondaryBtnClass}
            >
              {startConversation.isPending ? 'Starting…' : 'New conversation'}
            </button>
          </div>
          {conversationId && employee ? (
            <ChatPanel conversationId={conversationId} employee={employee} />
          ) : (
            <div className="rounded-2xl border border-white/[0.07] bg-white/[0.02] p-8 text-center">
              <p className="mb-4 text-sm text-zinc-400">
                {conversations && conversations.length === 0
                  ? 'No conversations yet.'
                  : 'Loading conversation…'}
              </p>
              <Button
                variant="violet"
                onClick={onStart}
                disabled={startConversation.isPending}
              >
                {startConversation.isPending ? 'Starting…' : 'Start a conversation'}
              </Button>
            </div>
          )}
        </div>
      )}

      {activeTab === 'memory' && <LearningPanel employeeId={employeeId} />}

      {activeTab === 'tools' && (
        <EmployeeSkillPicker
          employeeId={employeeId}
          employeeName={employee?.name}
        />
      )}

      {activeTab === 'knowledge' &&
        (employee ? (
          <EmployeeKnowledgeTab role={employee.role} name={employee.name} />
        ) : (
          <p className="text-sm text-zinc-500">Loading…</p>
        ))}

      {activeTab === 'settings' &&
        (employee ? (
          <EmployeeSettings employee={employee} />
        ) : (
          <p className="text-sm text-zinc-500">Loading…</p>
        ))}
    </AppShell>
  );
}

/**
 * The employee's Knowledge tab — drop files, and they belong to this employee.
 *
 * ## Why there is no "Visible to" control here
 *
 * On THIS page the answer is already known: a document uploaded from Anushka's
 * tab is Anushka's. Offering the dropdown let you pick another role from her
 * page and upload a document she could not read — a control whose only possible
 * use was to get it wrong. The global `/knowledge` page is where a genuine
 * choice exists, and that is where the control lives.
 *
 * So the category is FIXED to the employee's role and stated as a fact, not
 * offered as a decision. Existing documents can still be re-scoped from their
 * row in the list, which is a deliberate act on a specific file rather than a
 * setting to overlook at upload time.
 */
function EmployeeKnowledgeTab({
  role,
  name,
}: {
  role: EmployeeRole;
  name: string;
}) {
  const { data: docs } = useDocuments(role);
  const isEmpty = !docs || docs.length === 0;

  return (
    <section>
      <div className="mb-3 flex flex-wrap items-baseline justify-between gap-2">
        <h2 className="text-sm font-medium text-zinc-400">
          {formatRole(role)} + Shared documents
        </h2>
        <p className="text-xs text-zinc-500">
          Anything you add here goes to {name} ({formatRole(role)}) — .txt, .md, .pdf
        </p>
      </div>
      <KnowledgeDropzone choice={role} isEmpty={isEmpty} ownerName={name}>
        <DocumentList category={role} />
      </KnowledgeDropzone>
    </section>
  );
}
