'use client';

import { useState } from 'react';
import { Check, Sparkles } from 'lucide-react';
import type { ContentItemDto, CreativeVariantDto } from '@vaep/types';
import { Button } from '@/components/ui/Button';
import { useContentItem, useSelectVariant } from '../hooks';

/**
 * The 5–6 creative options for one post (§13/§31/§39/§90).
 *
 * ## Why the recommended option is shown alone at first
 *
 * §90 and §62 both call for progressive disclosure: 35 posts × 6 options is 210
 * variants, and a screen that opens all of them is a screen nobody reads. The
 * AI's recommendation is shown expanded, with the rest one click away.
 *
 * ## Recommended is not chosen
 *
 * §32 is explicit that an AI recommendation is not an approval, so the
 * recommended card is labelled and never pre-selected. The customer clicks
 * "Use this one" or it stays unchosen — and even then, selecting is not
 * approving (§3.4); nothing here makes a post publishable.
 */
function VariantCard({
  variant,
  isSelected,
  onSelect,
  saving,
}: {
  variant: CreativeVariantDto;
  isSelected: boolean;
  onSelect: () => void;
  saving: boolean;
}) {
  return (
    <li
      className={`rounded-2xl border p-4 transition-colors ${
        isSelected
          ? 'border-violet bg-violet/5'
          : 'border-app-border bg-app-surface hover:border-app-border-strong'
      }`}
    >
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div className="flex items-center gap-2">
          <span className="text-xs font-medium uppercase tracking-wide text-app-ink-3">
            Option {variant.variantNumber}
          </span>
          {variant.recommended && (
            <span className="inline-flex items-center gap-1 rounded-full bg-violet/15 px-2 py-0.5 text-[11px] font-medium text-violet-bright">
              <Sparkles className="h-3 w-3" />
              AI suggests this
            </span>
          )}
        </div>
        {isSelected && (
          <span className="inline-flex items-center gap-1 rounded-full bg-status-succeeded/15 px-2 py-0.5 text-[11px] font-medium text-sl-succeeded">
            <Check className="h-3 w-3" />
            Chosen
          </span>
        )}
      </div>

      {/* The angle is what makes six options six IDEAS rather than six
          rewordings, so it leads. */}
      <p className="mt-2 text-xs font-medium text-app-ink-2">{variant.contentAngle}</p>

      <p className="mt-3 font-medium text-app-ink">{variant.hook}</p>
      <p className="mt-2 whitespace-pre-wrap text-sm text-app-ink-2">{variant.caption}</p>

      <p className="mt-3 text-sm text-app-ink">{variant.cta}</p>

      {variant.hashtags.length > 0 && (
        <p className="mt-2 text-xs text-violet-bright">{variant.hashtags.join(' ')}</p>
      )}

      {variant.mediaBrief && (
        // Says plainly that this is a plan for media, not media. Showing it as
        // an image placeholder would imply something was generated (§103).
        <p className="mt-3 rounded-lg bg-app-raised px-3 py-2 text-xs text-app-ink-3">
          <span className="font-medium text-app-ink-2">Image idea: </span>
          {variant.mediaBrief}
          <span className="block pt-1 italic">
            Not generated yet — created once you choose this option.
          </span>
        </p>
      )}

      {variant.recommended && variant.recommendationReason && (
        <p className="mt-3 text-xs text-app-ink-3">
          <span className="font-medium">Why: </span>
          {variant.recommendationReason}
        </p>
      )}

      {!isSelected && (
        <Button
          type="button"
          variant="violet"
          className="mt-4"
          disabled={saving}
          onClick={onSelect}
        >
          {saving ? 'Saving…' : 'Use this one'}
        </Button>
      )}
    </li>
  );
}

export function VariantSelector({
  contentItemId,
  campaignId,
}: {
  contentItemId: string;
  campaignId: string;
}) {
  const { data, isLoading, isError, error } = useContentItem(contentItemId);
  const select = useSelectVariant(campaignId);
  const [showAll, setShowAll] = useState(false);

  if (isLoading) return <p className="text-sm text-app-ink-3">Loading options…</p>;
  if (isError) {
    return (
      <p className="text-sm text-red-600">
        {error?.message ?? 'Could not load the options for this post'}
      </p>
    );
  }

  const item = data as ContentItemDto;
  const variants = item.variants ?? [];

  if (variants.length === 0) {
    return (
      <p className="text-sm text-app-ink-3">
        This post has no options yet — it is still being written.
      </p>
    );
  }

  // Chosen first, else the AI's suggestion, else the first option.
  const lead =
    variants.find((v) => v.id === item.selectedVariantId) ??
    variants.find((v) => v.recommended) ??
    variants[0];
  const rest = variants.filter((v) => v.id !== lead.id);
  const visible = showAll ? [lead, ...rest] : [lead];

  return (
    <div className="space-y-3">
      {select.isError && (
        <p className="text-sm text-red-600">
          {select.error?.message ?? 'Could not save that choice'}
        </p>
      )}

      <ul className="space-y-3">
        {visible.map((v) => (
          <VariantCard
            key={v.id}
            variant={v}
            isSelected={v.id === item.selectedVariantId}
            saving={select.isPending}
            onSelect={() => select.mutate({ contentItemId: item.id, variantId: v.id })}
          />
        ))}
      </ul>

      {rest.length > 0 && (
        <button
          type="button"
          className="text-sm font-medium text-violet-bright hover:underline"
          onClick={() => setShowAll((v) => !v)}
        >
          {showAll ? 'Show fewer' : `Show ${rest.length} other option${rest.length === 1 ? '' : 's'}`}
        </button>
      )}
    </div>
  );
}
