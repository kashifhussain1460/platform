import type { ReactNode } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { HandoffRequestDto } from '@vaep/types';
import { HandoffInbox } from '../components/HandoffInbox';

/**
 * The inbox exists so an escalation reaches a person. These tests pin the two
 * things that decide whether it does: that a row someone CANNOT action is
 * still shown (a hidden queue item is a stalled queue), and that resolving
 * sends the right outcome for the conversation.
 */
const resolveHandoff = vi.fn((_v: unknown) => Promise.resolve({} as HandoffRequestDto));
let rows: HandoffRequestDto[] = [];

vi.mock('../api', () => ({
  listHandoffs: vi.fn(async () => rows),
  resolveHandoff: (v: unknown) => resolveHandoff(v),
}));

vi.mock('@/stores/session.store', () => ({
  useSessionStore: (selector: (s: { accessToken: string }) => unknown) =>
    selector({ accessToken: 'token' }),
}));

const handoff = (over: Partial<HandoffRequestDto> = {}): HandoffRequestDto => ({
  id: 'ho_1',
  companyId: 'co-1',
  conversationId: 'conv_1',
  employeeId: 'emp_1',
  reason: 'Customer asked for a refund',
  status: 'PENDING',
  assigneeUserId: 'u_1',
  resolvedById: null,
  resolvedAt: null,
  note: null,
  createdAt: '2026-08-22T10:00:00.000Z',
  canResolve: true,
  conversation: {
    id: 'conv_1',
    contactEmail: 'buyer@example.com',
    status: 'ESCALATED',
    lastMessageAt: '2026-08-22T09:59:00.000Z',
    recentMessages: [
      { id: 'm1', direction: 'IN', body: 'I want my money back', createdAt: '2026-08-22T09:58:00.000Z' },
      { id: 'm2', direction: 'OUT', body: 'Let me get a colleague', createdAt: '2026-08-22T09:59:00.000Z' },
    ],
  },
  ...over,
});

function renderInbox(data: HandoffRequestDto[]) {
  rows = data;
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const Wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={qc}>{children}</QueryClientProvider>
  );
  return render(<HandoffInbox />, { wrapper: Wrapper });
}

describe('HandoffInbox', () => {
  beforeEach(() => resolveHandoff.mockClear());

  it('shows the customer and the reason the AI stepped back', async () => {
    renderInbox([handoff()]);
    expect(await screen.findByText('buyer@example.com')).not.toBeNull();
    expect(screen.getByText('Customer asked for a refund')).not.toBeNull();
  });

  it('can reveal the recent conversation without a second page', async () => {
    renderInbox([handoff()]);
    fireEvent.click(await screen.findByText(/Show last 2 messages/i));
    expect(screen.getByText('I want my money back')).not.toBeNull();
  });

  it('attributes each message to the right speaker', async () => {
    // The direction enum is IN/OUT, not INBOUND/OUTBOUND. Getting it wrong
    // silently labels every customer message as the AI, which is exactly the
    // context a human needs to be correct before they take the conversation.
    renderInbox([handoff()]);
    fireEvent.click(await screen.findByText(/Show last 2 messages/i));
    expect(screen.getByText('I want my money back').textContent).toContain('Customer');
    expect(screen.getByText('Let me get a colleague').textContent).toContain('AI');
  });

  it('"Hand back to the AI" sends resume: true', async () => {
    renderInbox([handoff()]);
    fireEvent.click(await screen.findByRole('button', { name: /Hand back to the AI/i }));
    await waitFor(() =>
      expect(resolveHandoff).toHaveBeenCalledWith({
        id: 'ho_1',
        body: { resume: true, note: undefined },
      }),
    );
  });

  it('"Close the conversation" sends resume: false', async () => {
    renderInbox([handoff()]);
    fireEvent.click(await screen.findByRole('button', { name: /Close the conversation/i }));
    await waitFor(() =>
      expect(resolveHandoff).toHaveBeenCalledWith({
        id: 'ho_1',
        body: { resume: false, note: undefined },
      }),
    );
  });

  it('passes an optional note through', async () => {
    renderInbox([handoff()]);
    const note = await screen.findByPlaceholderText(/Note \(optional\)/i);
    fireEvent.change(note, { target: { value: 'Refunded manually' } });
    fireEvent.click(screen.getByRole('button', { name: /Hand back to the AI/i }));
    await waitFor(() =>
      expect(resolveHandoff).toHaveBeenCalledWith({
        id: 'ho_1',
        body: { resume: true, note: 'Refunded manually' },
      }),
    );
  });

  it('SHOWS a row this user cannot action, and says why', async () => {
    // A support queue that hides work from a colleague is a queue that stalls.
    renderInbox([handoff({ canResolve: false })]);
    expect(await screen.findByText('buyer@example.com')).not.toBeNull();
    expect(screen.getByText(/routed to someone else/i)).not.toBeNull();
    expect(screen.queryByRole('button', { name: /Hand back to the AI/i })).toBeNull();
  });

  it('tells a new company what this queue is for when it is empty', async () => {
    renderInbox([]);
    expect(await screen.findByText(/Nothing waiting for a human/i)).not.toBeNull();
    expect(screen.getByText(/escalates here when it decides/i)).not.toBeNull();
  });

  it('renders a handoff whose conversation row is missing', async () => {
    renderInbox([handoff({ conversation: null })]);
    expect(await screen.findByText('Customer conversation')).not.toBeNull();
  });
});
