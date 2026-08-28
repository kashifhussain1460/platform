'use client';

import { useState } from 'react';
import type { SocialAccountDto } from '@vaep/types';
import { Button } from '@/components/ui/Button';
import {
  useDisconnectAccount,
  useImportAccounts,
  useSocialAccounts,
  useStartConnect,
} from '../hooks';

/** The providers Postiz supports that customers actually ask for first. */
const PLATFORMS = [
  { id: 'linkedin', label: 'LinkedIn' },
  { id: 'instagram', label: 'Instagram' },
  { id: 'facebook', label: 'Facebook' },
  { id: 'x', label: 'X' },
  { id: 'youtube', label: 'YouTube' },
  { id: 'tiktok', label: 'TikTok' },
];

const STATUS_STYLE: Record<SocialAccountDto['status'], string> = {
  CONNECTED: 'bg-status-succeeded/15 text-sl-succeeded',
  DEGRADED: 'bg-status-warning/15 text-sl-warning',
  DISCONNECTED: 'bg-app-raised text-app-ink-3',
};

/**
 * Connected social accounts.
 *
 * These rows are what makes the Marketing AI Employee work: `schedule_post`
 * and `publish_now` both look one up and fail without it. So this list is not
 * decoration — an empty one is the reason the AI says it cannot post, and the
 * empty state says exactly that instead of leaving the customer guessing.
 */
export function SocialAccountList() {
  const { data, isLoading, isError, error } = useSocialAccounts();
  const importAccounts = useImportAccounts();
  const connect = useStartConnect();
  const disconnect = useDisconnectAccount();
  const [platform, setPlatform] = useState(PLATFORMS[0].id);
  const accounts = data ?? [];

  const onConnect = () => {
    connect.mutate(platform, {
      onSuccess: ({ url }) => window.open(url, '_blank', 'noopener,noreferrer'),
    });
  };

  return (
    <section className="space-y-4">
      <div className="rounded-2xl border border-app-border bg-app-surface p-4">
        <h2 className="font-medium text-app-ink">Add a social account</h2>
        <p className="mt-1 text-sm text-app-ink-2">
          Connecting opens the provider&apos;s own sign-in page. Once you have finished
          there, choose <span className="font-medium">Refresh from the publisher</span>{' '}
          to bring the account across.
        </p>
        <div className="mt-3 flex flex-wrap items-center gap-2">
          <select
            className="field-modern max-w-[200px]"
            value={platform}
            onChange={(e) => setPlatform(e.target.value)}
          >
            {PLATFORMS.map((p) => (
              <option key={p.id} value={p.id}>
                {p.label}
              </option>
            ))}
          </select>
          <Button
            type="button"
            variant="violet"
            disabled={connect.isPending}
            onClick={onConnect}
          >
            {connect.isPending ? 'Opening…' : 'Connect'}
          </Button>
          <button
            type="button"
            className="rounded-lg border border-app-border-strong bg-app-surface px-3.5 py-1.5 text-sm font-medium text-app-ink-2 transition-colors hover:bg-app-raised disabled:opacity-50"
            disabled={importAccounts.isPending}
            onClick={() => importAccounts.mutate()}
          >
            {importAccounts.isPending ? 'Refreshing…' : 'Refresh from the publisher'}
          </button>
        </div>
        {connect.isError && (
          <p className="mt-2 text-sm text-red-600">
            {connect.error?.message ?? 'Could not start the connection'}
          </p>
        )}
        {importAccounts.isError && (
          // Most often this is the deliberate 409 from a company whose
          // publisher workspace has not been set up yet. Showing the server's
          // own sentence is better than a generic failure, because that
          // sentence tells them who to ask.
          <p className="mt-2 text-sm text-red-600">
            {importAccounts.error?.message ?? 'Could not refresh accounts'}
          </p>
        )}
        {importAccounts.isSuccess && (
          <p className="mt-2 text-sm text-app-ink-2">
            {importAccounts.data.imported} added, {importAccounts.data.updated} updated.
          </p>
        )}
      </div>

      {isLoading ? (
        <p className="text-sm text-app-ink-3">Loading…</p>
      ) : isError ? (
        <p className="text-sm text-red-600">
          {error?.message ?? 'Could not load social accounts'}
        </p>
      ) : accounts.length === 0 ? (
        <div className="rounded-2xl border border-app-border bg-app-surface p-6 text-center">
          <p className="text-sm text-app-ink-2">No social accounts connected yet.</p>
          <p className="mt-1 text-xs text-app-ink-3">
            Your Marketing AI Employee cannot post anywhere until at least one account
            is connected here.
          </p>
        </div>
      ) : (
        <ul className="space-y-2">
          {accounts.map((a) => (
            <li
              key={a.id}
              className="flex flex-wrap items-center justify-between gap-3 rounded-2xl border border-app-border bg-app-surface p-4"
            >
              <div>
                <p className="font-medium text-app-ink">{a.displayName ?? a.provider}</p>
                <p className="text-xs capitalize text-app-ink-3">{a.provider}</p>
              </div>
              <div className="flex items-center gap-2">
                <span
                  className={`rounded-full px-2 py-0.5 text-[11px] font-medium ${STATUS_STYLE[a.status]}`}
                >
                  {a.status === 'CONNECTED' ? 'Connected' : a.status.toLowerCase()}
                </span>
                {a.status === 'CONNECTED' && (
                  <button
                    type="button"
                    className="text-xs font-medium text-app-ink-3 hover:text-app-ink disabled:opacity-50"
                    disabled={disconnect.isPending}
                    onClick={() => disconnect.mutate(a.id)}
                  >
                    Disconnect
                  </button>
                )}
              </div>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
