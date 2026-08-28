'use client';

import { useState } from 'react';
import type { ScheduledPostDto, ScheduledPostStatus } from '@vaep/types';
import { Button } from '@/components/ui/Button';
import { useCancelPost, useCreatePost, usePosts, useSocialAccounts } from '../hooks';

const FILTERS: Array<{ value: ScheduledPostStatus | undefined; label: string }> = [
  { value: undefined, label: 'All' },
  { value: 'DRAFT', label: 'Drafts' },
  { value: 'SCHEDULED', label: 'Scheduled' },
  { value: 'PUBLISHED', label: 'Published' },
  { value: 'FAILED', label: 'Failed' },
];

const STATUS_STYLE: Record<ScheduledPostStatus, string> = {
  DRAFT: 'bg-app-raised text-app-ink-3',
  PENDING_APPROVAL: 'bg-status-warning/15 text-sl-warning',
  SCHEDULED: 'bg-violet/15 text-violet-bright',
  PUBLISHED: 'bg-status-succeeded/15 text-sl-succeeded',
  FAILED: 'bg-status-failed/15 text-sl-failed',
};

const STATUS_LABEL: Record<ScheduledPostStatus, string> = {
  DRAFT: 'Draft',
  PENDING_APPROVAL: 'Waiting for approval',
  SCHEDULED: 'Scheduled',
  PUBLISHED: 'Published',
  FAILED: 'Failed',
};

function PostRow({ post }: { post: ScheduledPostDto }) {
  const cancel = useCancelPost();
  return (
    <li className="rounded-2xl border border-app-border bg-app-surface p-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="text-xs uppercase tracking-wide text-app-ink-3">
            {post.socialAccountName ?? post.socialAccountProvider}
            {post.campaignName && ` · ${post.campaignName}`}
          </p>
          <p className="mt-1 whitespace-pre-wrap text-sm text-app-ink">{post.content}</p>
          <p className="mt-1.5 text-xs text-app-ink-3">
            {post.status === 'PUBLISHED' && post.publishedAt
              ? `Published ${new Date(post.publishedAt).toLocaleString()}`
              : `For ${new Date(post.publishAt).toLocaleString()}`}
          </p>
        </div>
        <span
          className={`shrink-0 rounded-full px-2 py-0.5 text-[11px] font-medium ${STATUS_STYLE[post.status]}`}
        >
          {STATUS_LABEL[post.status]}
        </span>
      </div>

      <div className="mt-3 flex flex-wrap items-center gap-3">
        {post.permalink && (
          <a
            href={post.permalink}
            target="_blank"
            rel="noopener noreferrer"
            className="text-xs font-medium text-violet-bright hover:underline"
          >
            View the live post
          </a>
        )}
        {post.status !== 'PUBLISHED' && (
          <button
            type="button"
            className="text-xs font-medium text-app-ink-3 hover:text-app-ink disabled:opacity-50"
            disabled={cancel.isPending}
            onClick={() => cancel.mutate(post.id)}
          >
            {cancel.isPending ? 'Cancelling…' : 'Cancel'}
          </button>
        )}
        {post.status === 'SCHEDULED' && (
          // Says why the row has no Edit button, rather than leaving a
          // disabled control the customer has to guess about.
          <span className="text-xs text-app-ink-3">
            Already with the publisher — cancel and rewrite to change it.
          </span>
        )}
      </div>
      {cancel.isError && (
        <p className="mt-2 text-sm text-red-600">
          {cancel.error?.message ?? 'Could not cancel that post'}
        </p>
      )}
    </li>
  );
}

function Composer() {
  const { data: accounts } = useSocialAccounts();
  const create = useCreatePost();
  const [content, setContent] = useState('');
  const [accountId, setAccountId] = useState('');
  const [publishAt, setPublishAt] = useState('');

  const connected = (accounts ?? []).filter((a) => a.status === 'CONNECTED');
  const target = accountId || connected[0]?.id || '';

  const submit = (schedule: boolean) => {
    if (!target || !content.trim()) return;
    create.mutate(
      {
        socialAccountId: target,
        content: content.trim(),
        publishAt: publishAt ? new Date(publishAt).toISOString() : undefined,
        schedule,
      },
      {
        onSuccess: () => {
          setContent('');
          setPublishAt('');
        },
      },
    );
  };

  if (connected.length === 0) {
    return (
      <div className="rounded-2xl border border-app-border bg-app-surface p-4 text-sm text-app-ink-2">
        Connect a social account first — there is nowhere to post to yet.
      </div>
    );
  }

  return (
    <div className="rounded-2xl border border-app-border bg-app-surface p-4">
      <h2 className="font-medium text-app-ink">Write a post</h2>
      <div className="mt-3 space-y-2">
        <textarea
          className="field-modern min-h-[96px]"
          placeholder="What should go out?"
          value={content}
          maxLength={10_000}
          onChange={(e) => setContent(e.target.value)}
        />
        <div className="flex flex-wrap gap-2">
          <select
            className="field-modern max-w-[220px]"
            value={target}
            onChange={(e) => setAccountId(e.target.value)}
          >
            {connected.map((a) => (
              <option key={a.id} value={a.id}>
                {a.displayName ?? a.provider}
              </option>
            ))}
          </select>
          <input
            type="datetime-local"
            className="field-modern max-w-[220px]"
            value={publishAt}
            onChange={(e) => setPublishAt(e.target.value)}
          />
        </div>
        {create.isError && (
          <p className="text-sm text-red-600">
            {create.error?.message ?? 'Could not save that post'}
          </p>
        )}
        <div className="flex flex-wrap items-center gap-2">
          <button
            type="button"
            className="rounded-lg border border-app-border-strong bg-app-surface px-3.5 py-1.5 text-sm font-medium text-app-ink-2 transition-colors hover:bg-app-raised disabled:opacity-50"
            disabled={create.isPending || !content.trim()}
            onClick={() => submit(false)}
          >
            Save as draft
          </button>
          <Button
            type="button"
            variant="violet"
            disabled={create.isPending || !content.trim() || !publishAt}
            onClick={() => submit(true)}
          >
            {create.isPending ? 'Saving…' : 'Schedule it'}
          </Button>
          {/* The two buttons do genuinely different things and the difference
              is worth stating: one is private, one leaves the building. */}
          <span className="text-xs text-app-ink-3">
            A draft stays here. Scheduling sends it to the publisher and it will go out
            on its own.
          </span>
        </div>
      </div>
    </div>
  );
}

export function PostList() {
  const [status, setStatus] = useState<ScheduledPostStatus | undefined>(undefined);
  const { data, isLoading, isError, error } = usePosts(status);
  const posts = data ?? [];

  return (
    <section className="space-y-4">
      <Composer />

      <div className="flex flex-wrap gap-2">
        {FILTERS.map((f) => (
          <button
            key={f.label}
            type="button"
            onClick={() => setStatus(f.value)}
            className={`rounded-full px-3.5 py-1.5 text-xs font-medium transition-colors ${
              status === f.value
                ? 'bg-violet text-white'
                : 'border border-app-border text-app-ink-2 hover:text-app-ink'
            }`}
          >
            {f.label}
          </button>
        ))}
      </div>

      {isLoading ? (
        <p className="text-sm text-app-ink-3">Loading…</p>
      ) : isError ? (
        <p className="text-sm text-red-600">{error?.message ?? 'Could not load posts'}</p>
      ) : posts.length === 0 ? (
        <div className="rounded-2xl border border-app-border bg-app-surface p-6 text-center">
          <p className="text-sm text-app-ink-2">Nothing here yet.</p>
          <p className="mt-1 text-xs text-app-ink-3">
            Posts you write and posts your Marketing AI Employee schedules both appear
            in this list.
          </p>
        </div>
      ) : (
        <ul className="space-y-3">
          {posts.map((p) => (
            <PostRow key={p.id} post={p} />
          ))}
        </ul>
      )}
    </section>
  );
}
