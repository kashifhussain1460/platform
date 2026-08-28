'use client';

import { useState } from 'react';
import { Button } from '@/components/ui/Button';
import { useCampaigns, useCreateCampaign, useDeleteCampaign } from '../hooks';

/**
 * Campaigns are a label for grouping posts, not a scheduler of their own —
 * deleting one keeps its posts and just un-groups them, and the confirmation
 * text says so, because "delete campaign" reads like it takes the posts too.
 */
export function CampaignList() {
  const { data, isLoading, isError, error } = useCampaigns();
  const create = useCreateCampaign();
  const remove = useDeleteCampaign();
  const [name, setName] = useState('');
  const [goal, setGoal] = useState('');
  const campaigns = data ?? [];

  const submit = () => {
    if (!name.trim()) return;
    create.mutate(
      { name: name.trim(), goal: goal.trim() || undefined },
      {
        onSuccess: () => {
          setName('');
          setGoal('');
        },
      },
    );
  };

  return (
    <section className="space-y-4">
      <div className="rounded-2xl border border-app-border bg-app-surface p-4">
        <h2 className="font-medium text-app-ink">New campaign</h2>
        <div className="mt-3 flex flex-wrap gap-2">
          <input
            className="field-modern max-w-[260px]"
            placeholder="Name, e.g. Autumn launch"
            value={name}
            maxLength={200}
            onChange={(e) => setName(e.target.value)}
          />
          <input
            className="field-modern max-w-[320px]"
            placeholder="Goal (optional), e.g. 200 signups"
            value={goal}
            maxLength={2000}
            onChange={(e) => setGoal(e.target.value)}
          />
          <Button
            type="button"
            variant="violet"
            disabled={create.isPending || !name.trim()}
            onClick={submit}
          >
            {create.isPending ? 'Creating…' : 'Create'}
          </Button>
        </div>
        {create.isError && (
          <p className="mt-2 text-sm text-red-600">
            {create.error?.message ?? 'Could not create that campaign'}
          </p>
        )}
      </div>

      {isLoading ? (
        <p className="text-sm text-app-ink-3">Loading…</p>
      ) : isError ? (
        <p className="text-sm text-red-600">
          {error?.message ?? 'Could not load campaigns'}
        </p>
      ) : campaigns.length === 0 ? (
        <div className="rounded-2xl border border-app-border bg-app-surface p-6 text-center">
          <p className="text-sm text-app-ink-2">No campaigns yet.</p>
          <p className="mt-1 text-xs text-app-ink-3">
            Campaigns group related posts so you can see how a push performed as a
            whole.
          </p>
        </div>
      ) : (
        <ul className="space-y-2">
          {campaigns.map((c) => (
            <li
              key={c.id}
              className="flex flex-wrap items-center justify-between gap-3 rounded-2xl border border-app-border bg-app-surface p-4"
            >
              <div>
                <p className="font-medium text-app-ink">{c.name}</p>
                <p className="text-xs text-app-ink-3">
                  {c.postCount} post{c.postCount === 1 ? '' : 's'}
                  {c.goal && ` · ${c.goal}`}
                </p>
              </div>
              <button
                type="button"
                className="text-xs font-medium text-app-ink-3 hover:text-app-ink disabled:opacity-50"
                disabled={remove.isPending}
                onClick={() => {
                  if (
                    window.confirm(
                      `Delete "${c.name}"? Its ${c.postCount} post(s) are kept — they just stop being grouped.`,
                    )
                  ) {
                    remove.mutate(c.id);
                  }
                }}
              >
                Delete
              </button>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
