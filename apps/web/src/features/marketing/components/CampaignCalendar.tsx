'use client';

import { useState } from 'react';
import { ChevronDown, ChevronRight } from 'lucide-react';
import type { AiCampaignDetailDto, ContentItemDto, ContentItemStatus } from '@vaep/types';
import { useCampaignContent } from '../hooks';
import { VariantSelector } from './VariantSelector';

const STATUS_LABEL: Record<ContentItemStatus, string> = {
  DRAFT: 'Being written',
  GENERATING: 'Being written',
  READY_FOR_REVIEW: 'Needs review',
  EDIT_REQUIRED: 'Needs edits',
  APPROVED: 'Approved',
  SCHEDULED: 'Scheduled',
  PUBLISHING: 'Publishing',
  PUBLISHED: 'Published',
  FAILED: 'Failed',
  CANCELLED: 'Cancelled',
};

const STATUS_STYLE: Record<ContentItemStatus, string> = {
  DRAFT: 'bg-app-raised text-app-ink-3',
  GENERATING: 'bg-app-raised text-app-ink-3',
  READY_FOR_REVIEW: 'bg-status-warning/15 text-sl-warning',
  EDIT_REQUIRED: 'bg-status-warning/15 text-sl-warning',
  APPROVED: 'bg-status-succeeded/15 text-sl-succeeded',
  SCHEDULED: 'bg-violet/15 text-violet-bright',
  PUBLISHING: 'bg-violet/15 text-violet-bright',
  PUBLISHED: 'bg-status-succeeded/15 text-sl-succeeded',
  FAILED: 'bg-status-failed/15 text-sl-failed',
  CANCELLED: 'bg-app-raised text-app-ink-3',
};

/** Local time in the CAMPAIGN's zone, never the reader's browser (§35). */
function localTime(iso: string | null, timezone: string): string {
  if (!iso) return '—';
  return new Intl.DateTimeFormat('en-GB', {
    timeZone: timezone,
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).format(new Date(iso));
}

function localDate(iso: string | null, timezone: string): string {
  if (!iso) return '';
  return new Intl.DateTimeFormat('en-GB', {
    timeZone: timezone,
    weekday: 'long',
    day: 'numeric',
    month: 'short',
  }).format(new Date(iso));
}

/**
 * The campaign review screen (§33/§59/§62).
 *
 * Grouped by day and collapsed to one row per post. Opening a row is what
 * fetches that post's options — 35 posts × 6 is 210 variants, and loading them
 * all to render a calendar would be slow and show far more than anyone asked
 * to see.
 */
export function CampaignCalendar({ campaign }: { campaign: AiCampaignDetailDto }) {
  const { data, isLoading, isError, error } = useCampaignContent(
    campaign.id,
    campaign.generation.inProgress,
  );
  const [openId, setOpenId] = useState<string | null>(null);

  if (isLoading) return <p className="text-sm text-app-ink-3">Loading the calendar…</p>;
  if (isError) {
    return (
      <p className="text-sm text-red-600">
        {error?.message ?? 'Could not load this campaign’s calendar'}
      </p>
    );
  }

  const items = data ?? [];
  if (items.length === 0) {
    return (
      <div className="rounded-2xl border border-app-border bg-app-surface p-6 text-center">
        <p className="text-sm text-app-ink-2">No posts planned yet.</p>
        <p className="mt-1 text-xs text-app-ink-3">
          {campaign.generation.inProgress
            ? 'The calendar appears here as it is built.'
            : 'Generation finished without producing any posts.'}
        </p>
      </div>
    );
  }

  // Group by day, preserving the API's ordering.
  const byDay = new Map<number, ContentItemDto[]>();
  for (const item of items) {
    byDay.set(item.dayNumber, [...(byDay.get(item.dayNumber) ?? []), item]);
  }

  return (
    <div className="space-y-6">
      {[...byDay.entries()].map(([day, posts]) => (
        <section key={day}>
          <h3 className="text-sm font-semibold text-app-ink">
            Day {day}
            <span className="ml-2 font-normal text-app-ink-3">
              {localDate(posts[0].scheduledAt, campaign.timezone)}
            </span>
          </h3>

          <ul className="mt-2 space-y-2">
            {posts.map((post) => {
              const open = openId === post.id;
              return (
                <li
                  key={post.id}
                  className="rounded-2xl border border-app-border bg-app-surface"
                >
                  <button
                    type="button"
                    className="flex w-full flex-wrap items-center gap-3 p-4 text-left"
                    onClick={() => setOpenId(open ? null : post.id)}
                  >
                    {open ? (
                      <ChevronDown className="h-4 w-4 shrink-0 text-app-ink-3" />
                    ) : (
                      <ChevronRight className="h-4 w-4 shrink-0 text-app-ink-3" />
                    )}
                    <span className="font-mono text-sm text-app-ink-2">
                      {localTime(post.scheduledAt, campaign.timezone)}
                    </span>
                    <span className="min-w-0 flex-1 truncate text-sm text-app-ink">
                      {post.objective}
                      <span className="text-app-ink-3"> · {post.contentType}</span>
                    </span>
                    <span className="text-xs text-app-ink-3">
                      {post.variantCount} option{post.variantCount === 1 ? '' : 's'}
                    </span>
                    {post.selectedVariantId && (
                      <span className="rounded-full bg-violet/15 px-2 py-0.5 text-[11px] font-medium text-violet-bright">
                        Chosen
                      </span>
                    )}
                    <span
                      className={`rounded-full px-2 py-0.5 text-[11px] font-medium ${STATUS_STYLE[post.status]}`}
                    >
                      {STATUS_LABEL[post.status]}
                    </span>
                  </button>

                  {open && (
                    <div className="border-t border-app-border p-4">
                      <VariantSelector contentItemId={post.id} campaignId={campaign.id} />
                    </div>
                  )}
                </li>
              );
            })}
          </ul>
        </section>
      ))}

      <p className="text-xs text-app-ink-3">
        Times shown in {campaign.timezone}.
      </p>
    </div>
  );
}
