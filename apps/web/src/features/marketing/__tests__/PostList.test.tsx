import type { ReactNode } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ScheduledPostDto, SocialAccountDto } from '@vaep/types';
import { PostList } from '../components/PostList';

/**
 * The distinction these tests protect is the one that matters most on this
 * screen: "save a draft" stays inside Orlixa, "schedule it" publishes to a
 * real, public social account. A UI that blurs the two gets someone's brand
 * posted to by accident.
 */
const createPost = vi.fn((_v: unknown) => Promise.resolve({} as ScheduledPostDto));
const cancelPost = vi.fn((_id: string) => Promise.resolve({ id: 'sp_1' }));
let posts: ScheduledPostDto[] = [];
let accounts: SocialAccountDto[] = [];

vi.mock('../api', () => ({
  listPosts: vi.fn(async () => posts),
  listSocialAccounts: vi.fn(async () => accounts),
  createPost: (v: unknown) => createPost(v),
  cancelPost: (id: string) => cancelPost(id),
}));

vi.mock('@/stores/session.store', () => ({
  useSessionStore: (selector: (s: { accessToken: string }) => unknown) =>
    selector({ accessToken: 'token' }),
}));

const account = (over: Partial<SocialAccountDto> = {}): SocialAccountDto => ({
  id: 'sa_1',
  provider: 'instagram',
  displayName: 'Acme IG',
  status: 'CONNECTED',
  employeeId: null,
  externalAccountId: null,
  createdAt: '2026-08-01T00:00:00.000Z',
  ...over,
});

const post = (over: Partial<ScheduledPostDto> = {}): ScheduledPostDto => ({
  id: 'sp_1',
  socialAccountId: 'sa_1',
  socialAccountProvider: 'instagram',
  socialAccountName: 'Acme IG',
  campaignId: null,
  campaignName: null,
  content: 'Autumn sale starts today',
  publishAt: '2026-09-01T10:00:00.000Z',
  status: 'SCHEDULED',
  postizPostId: 'pz_1',
  permalink: null,
  publishedAt: null,
  createdAt: '2026-08-20T00:00:00.000Z',
  updatedAt: '2026-08-20T00:00:00.000Z',
  ...over,
});

function renderList(rows: ScheduledPostDto[], accs: SocialAccountDto[] = [account()]) {
  posts = rows;
  accounts = accs;
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const Wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={qc}>{children}</QueryClientProvider>
  );
  return render(<PostList />, { wrapper: Wrapper });
}

describe('PostList', () => {
  beforeEach(() => {
    createPost.mockClear();
    cancelPost.mockClear();
  });

  it('shows what is queued, where, and when', async () => {
    renderList([post()]);
    expect(await screen.findByText('Autumn sale starts today')).not.toBeNull();
    // "Acme IG" is also an <option> in the composer, so scope to the row.
    const row = screen.getByText('Autumn sale starts today').closest('li');
    expect(row?.textContent).toContain('Acme IG');
    expect(row?.textContent).toContain('Scheduled');
  });

  it('"Save as draft" does NOT schedule', async () => {
    renderList([]);
    const box = await screen.findByPlaceholderText(/What should go out\?/i);
    fireEvent.change(box, { target: { value: 'just an idea' } });
    fireEvent.click(screen.getByRole('button', { name: /Save as draft/i }));
    await waitFor(() =>
      expect(createPost).toHaveBeenCalledWith(
        expect.objectContaining({ content: 'just an idea', schedule: false }),
      ),
    );
  });

  it('will not let you schedule without a time', async () => {
    // Scheduling without a date used to be possible and the server rejected
    // it; refusing in the UI keeps the irreversible action deliberate.
    renderList([]);
    const box = await screen.findByPlaceholderText(/What should go out\?/i);
    fireEvent.change(box, { target: { value: 'no date yet' } });
    const scheduleBtn = screen.getByRole('button', { name: /Schedule it/i });
    expect((scheduleBtn as HTMLButtonElement).disabled).toBe(true);
  });

  it('"Schedule it" sends schedule: true with the chosen time', async () => {
    renderList([]);
    fireEvent.change(await screen.findByPlaceholderText(/What should go out\?/i), {
      target: { value: 'real post' },
    });
    const when = document.querySelector('input[type="datetime-local"]') as HTMLInputElement;
    fireEvent.change(when, { target: { value: '2026-09-01T10:00' } });
    fireEvent.click(screen.getByRole('button', { name: /Schedule it/i }));
    await waitFor(() =>
      expect(createPost).toHaveBeenCalledWith(
        expect.objectContaining({ content: 'real post', schedule: true }),
      ),
    );
    expect(createPost.mock.calls[0][0]).toHaveProperty('publishAt');
  });

  it('offers no composer when nothing is connected', async () => {
    // There is nowhere for the post to go, so an enabled box would be a lie.
    renderList([], []);
    expect(await screen.findByText(/nowhere to post to yet/i)).not.toBeNull();
    expect(screen.queryByRole('button', { name: /Schedule it/i })).toBeNull();
  });

  it('ignores a disconnected account as a target', async () => {
    renderList([], [account({ status: 'DISCONNECTED' })]);
    expect(await screen.findByText(/nowhere to post to yet/i)).not.toBeNull();
  });

  it('cannot cancel something already public, and links to it instead', async () => {
    renderList([
      post({
        status: 'PUBLISHED',
        permalink: 'https://example.com/p/1',
        publishedAt: '2026-08-21T09:00:00.000Z',
      }),
    ]);
    expect(await screen.findByText(/View the live post/i)).not.toBeNull();
    expect(screen.queryByRole('button', { name: /^Cancel$/i })).toBeNull();
  });

  it('explains why a scheduled post has no edit control', async () => {
    renderList([post()]);
    expect(await screen.findByText(/Already with the publisher/i)).not.toBeNull();
  });

  it('cancels a post that has not gone out', async () => {
    renderList([post({ status: 'DRAFT', postizPostId: null })]);
    fireEvent.click(await screen.findByRole('button', { name: /^Cancel$/i }));
    await waitFor(() => expect(cancelPost).toHaveBeenCalledWith('sp_1'));
  });

  it('tells a new company what the empty list means', async () => {
    renderList([]);
    expect(await screen.findByText(/Nothing here yet/i)).not.toBeNull();
  });
});
