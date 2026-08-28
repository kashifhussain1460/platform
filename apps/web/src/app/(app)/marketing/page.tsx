'use client';

import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { AppShell } from '@/components/app-shell/AppShell';
import { useAppShellProps } from '@/components/app-shell/useAppShellProps';
import { CampaignList } from '@/features/marketing/components/CampaignList';
import { PostList } from '@/features/marketing/components/PostList';
import { SocialAccountList } from '@/features/marketing/components/SocialAccountList';
import { useSessionStore } from '@/stores/session.store';

type Tab = 'posts' | 'accounts' | 'campaigns';

const TABS: Array<{ id: Tab; label: string }> = [
  { id: 'posts', label: 'Posts' },
  { id: 'accounts', label: 'Accounts' },
  { id: 'campaigns', label: 'Campaigns' },
];

/**
 * The marketing workspace.
 *
 * The Marketing AI Employee could already schedule and publish to a company's
 * real, public social accounts — and there was no screen anywhere showing what
 * it had queued or sent. This page is that screen: what is going out, where it
 * is going, and how it is grouped.
 *
 * It only appears in the sidebar for companies that have hired a Marketing AI
 * Employee, decided by `/product-context` like every other area rather than by
 * a hardcoded nav entry here.
 */
export default function MarketingPage() {
  const router = useRouter();
  const accessToken = useSessionStore((s) => s.accessToken);
  const shellProps = useAppShellProps();
  const [tab, setTab] = useState<Tab>('posts');

  useEffect(() => {
    if (!accessToken) {
      router.replace('/login');
    }
  }, [accessToken, router]);

  if (!accessToken) {
    return null;
  }

  return (
    <AppShell {...shellProps}>
      <header className="mb-6 pt-2">
        <p className="text-sm text-app-ink-3">Marketing</p>
        <h1 className="text-2xl font-bold text-app-ink">Social publishing</h1>
      </header>

      <div className="mb-6 flex flex-wrap gap-2">
        {TABS.map((t) => (
          <button
            key={t.id}
            type="button"
            onClick={() => setTab(t.id)}
            className={`rounded-xl px-4 py-2 text-sm font-medium transition-colors ${
              tab === t.id
                ? 'bg-violet text-white'
                : 'border border-app-border text-app-ink-2 hover:text-app-ink'
            }`}
          >
            {t.label}
          </button>
        ))}
      </div>

      {tab === 'posts' && <PostList />}
      {tab === 'accounts' && <SocialAccountList />}
      {tab === 'campaigns' && <CampaignList />}
    </AppShell>
  );
}
