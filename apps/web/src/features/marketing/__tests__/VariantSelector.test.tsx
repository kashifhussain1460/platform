import type { ReactNode } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ContentItemDto, CreativeVariantDto } from '@vaep/types';
import { VariantSelector } from '../components/VariantSelector';

/**
 * The review screen's two load-bearing behaviours:
 *
 *   1. Progressive disclosure (§31/§62/§90) — 210 variants must not all be on
 *      screen; the AI's suggestion leads and the rest are one click away.
 *   2. A recommendation is NOT a selection (§32), and a selection is NOT an
 *      approval (§3.4). Blurring either would let content reach a feed without
 *      a human ever deciding.
 */
const selectVariant = vi.fn((_v: unknown) => Promise.resolve({} as ContentItemDto));
let item: ContentItemDto;

vi.mock('../api', () => ({
  getContentItem: vi.fn(async () => item),
  selectVariant: (v: unknown) => selectVariant(v),
}));

vi.mock('@/stores/session.store', () => ({
  useSessionStore: (selector: (s: { accessToken: string }) => unknown) =>
    selector({ accessToken: 'token' }),
}));

const variant = (n: number, over: Partial<CreativeVariantDto> = {}): CreativeVariantDto => ({
  id: `v${n}`,
  variantNumber: n,
  version: 1,
  hook: `Hook ${n}`,
  caption: `Caption ${n}`,
  cta: 'Book a demo',
  hashtags: ['#Marketing'],
  contentAngle: `Angle ${n}`,
  mediaBrief: `Media idea ${n}`,
  recommended: false,
  recommendationReason: null,
  status: 'READY',
  ...over,
});

function makeItem(over: Partial<ContentItemDto> = {}): ContentItemDto {
  return {
    id: 'item_1',
    campaignId: 'camp_1',
    dayNumber: 1,
    sequence: 1,
    objective: 'Education',
    contentType: 'Educational',
    scheduledAt: '2026-09-01T09:00:00.000Z',
    timezone: 'UTC',
    currentVersion: 1,
    selectedVariantId: null,
    status: 'READY_FOR_REVIEW',
    variantCount: 6,
    variants: [
      variant(1),
      variant(2),
      variant(3),
      variant(4, { recommended: true, recommendationReason: 'Matches your tone' }),
      variant(5),
      variant(6),
    ],
    ...over,
  };
}

function renderSelector(data: ContentItemDto = makeItem()) {
  item = data;
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const Wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={qc}>{children}</QueryClientProvider>
  );
  return render(<VariantSelector contentItemId="item_1" campaignId="camp_1" />, {
    wrapper: Wrapper,
  });
}

describe('VariantSelector', () => {
  beforeEach(() => selectVariant.mockClear());

  it('shows the AI’s suggestion first and hides the other five', async () => {
    renderSelector();
    expect(await screen.findByText('Angle 4')).not.toBeNull();
    // The other options are behind a click, not on screen.
    expect(screen.queryByText('Angle 1')).toBeNull();
    expect(screen.getByText(/Show 5 other options/i)).not.toBeNull();
  });

  it('reveals every option on demand', async () => {
    renderSelector();
    fireEvent.click(await screen.findByText(/Show 5 other options/i));
    for (const n of [1, 2, 3, 4, 5, 6]) {
      expect(screen.getByText(`Angle ${n}`)).not.toBeNull();
    }
  });

  it('labels the recommendation as a suggestion and does NOT pre-select it', async () => {
    // §32 — an AI recommendation is not an approval, and must not look like one.
    renderSelector();
    expect(await screen.findByText(/AI suggests this/i)).not.toBeNull();
    expect(screen.queryByText(/^Chosen$/)).toBeNull();
    expect(screen.getByRole('button', { name: /Use this one/i })).not.toBeNull();
  });

  it('records a choice when the customer picks one', async () => {
    renderSelector();
    fireEvent.click(await screen.findByRole('button', { name: /Use this one/i }));
    await waitFor(() =>
      expect(selectVariant).toHaveBeenCalledWith({
        contentItemId: 'item_1',
        variantId: 'v4',
      }),
    );
  });

  it('leads with the CHOSEN option once one exists, not the recommendation', async () => {
    renderSelector(makeItem({ selectedVariantId: 'v2' }));
    expect(await screen.findByText('Angle 2')).not.toBeNull();
    expect(screen.getByText(/^Chosen$/)).not.toBeNull();
    // The recommended one is now just another option behind the toggle.
    expect(screen.queryByText('Angle 4')).toBeNull();
  });

  it('says the media does not exist yet rather than implying it does', async () => {
    // §103 — media is generated AFTER selection. Showing an image placeholder
    // would suggest something was already produced.
    renderSelector();
    expect(await screen.findByText(/Not generated yet/i)).not.toBeNull();
  });

  it('explains an empty option set instead of rendering nothing', async () => {
    renderSelector(makeItem({ variants: [], variantCount: 0 }));
    expect(await screen.findByText(/still being written/i)).not.toBeNull();
  });
});
