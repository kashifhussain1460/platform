'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { Button } from '@/components/ui/Button';
import { useCreateAiCampaign } from '../hooks';

const EXAMPLE =
  'Create a one-week campaign for our new product. Post 3 times a day on ' +
  'LinkedIn and Instagram. Focus on education and customer stories, and let me ' +
  'approve everything before anything is published.';

/**
 * Ask for a campaign in the customer's own words (§8/§57).
 *
 * Deliberately one free-text box rather than a form of dates, cadence and
 * platform checkboxes. The AI's job is to turn a sentence into that
 * configuration (§9), and asking a person to fill in the structured version
 * first would make the AI redundant. What it derived is shown afterwards on the
 * campaign page, where it can be checked.
 */
export function CampaignBriefForm() {
  const router = useRouter();
  const create = useCreateAiCampaign();
  const [brief, setBrief] = useState('');
  // The customer's own zone, offered as the default because a marketing
  // schedule almost always means THEIR working hours (§35).
  const [timezone, setTimezone] = useState(
    () => Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC',
  );

  const tooShort = brief.trim().length < 10;

  const submit = () => {
    if (tooShort) return;
    create.mutate(
      { brief: brief.trim(), timezone },
      { onSuccess: (campaign) => router.push(`/marketing/campaigns/${campaign.id}`) },
    );
  };

  return (
    <div className="rounded-2xl border border-app-border bg-app-surface p-4">
      <h2 className="font-medium text-app-ink">Describe the campaign you want</h2>
      <p className="mt-1 text-sm text-app-ink-2">
        Say it however you would to a colleague — how long, how often, which
        platforms, and what it should be about.
      </p>

      <textarea
        className="field-modern mt-3 min-h-[120px]"
        placeholder={EXAMPLE}
        value={brief}
        maxLength={4_000}
        onChange={(e) => setBrief(e.target.value)}
      />

      <div className="mt-3 flex flex-wrap items-center gap-3">
        <label className="text-xs text-app-ink-2">
          Post times are in
          <input
            className="field-modern ml-2 inline-block max-w-[220px]"
            value={timezone}
            onChange={(e) => setTimezone(e.target.value)}
            aria-label="Campaign timezone"
          />
        </label>
      </div>

      {create.isError && (
        <p className="mt-3 text-sm text-red-600">
          {create.error?.message ?? 'Could not start that campaign'}
        </p>
      )}

      <div className="mt-4 flex flex-wrap items-center gap-3">
        <Button type="button" variant="violet" disabled={create.isPending || tooShort} onClick={submit}>
          {create.isPending ? 'Starting…' : 'Plan this campaign'}
        </Button>
        {/* Sets the expectation before the click: this is minutes of work, and
            nothing reaches a social account without an explicit later step. */}
        <span className="text-xs text-app-ink-3">
          Writing the options takes a few minutes. Nothing is published — you
          review everything first.
        </span>
      </div>
    </div>
  );
}
