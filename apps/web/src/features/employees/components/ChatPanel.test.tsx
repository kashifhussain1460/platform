import type { ReactNode } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ChatPanel } from './ChatPanel';
import { useSessionStore } from '@/stores/session.store';
import type { AiEmployeeDto } from '@vaep/types';

const sendMessageMock = vi.fn(async () => ({
  message: {
    id: 'm1',
    companyId: 'c1',
    conversationId: 'conv1',
    role: 'ASSISTANT',
    content: 'Hi there',
    metadata: null,
    createdAt: '2026-08-20T00:00:00.000Z',
  },
  plan: [],
  sources: [],
  validation: { grounded: true, confidence: 1, needsApproval: false },
  toolCalls: [],
  estimatedCredits: 12,
  creditsCharged: 9,
}));

vi.mock('../api', () => ({
  listMessages: vi.fn(async () => []),
  sendMessage: (...args: unknown[]) => sendMessageMock(...(args as [])),
}));

function makeWrapper() {
  const qc = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  return function Wrapper({ children }: { children: ReactNode }) {
    return <QueryClientProvider client={qc}>{children}</QueryClientProvider>;
  };
}

const employee: AiEmployeeDto = {
  id: 'e1',
  companyId: 'c1',
  name: 'Bot',
  role: 'SUPPORT',
  status: 'ACTIVE',
} as unknown as AiEmployeeDto;

describe('ChatPanel', () => {
  beforeEach(() => {
    useSessionStore.setState({ accessToken: 'tok_123' } as never);
    // jsdom doesn't implement scrollIntoView — the chat autoscroll effect calls it.
    Element.prototype.scrollIntoView = vi.fn();
  });

  it('a sent message shows both the estimate and the settled figure, never collapsing to one', async () => {
    render(<ChatPanel conversationId="conv1" employee={employee} />, {
      wrapper: makeWrapper(),
    });

    const input = screen.getByPlaceholderText('Ask your employee…');
    fireEvent.change(input, { target: { value: 'hello' } });
    fireEvent.click(screen.getByRole('button', { name: /send/i }));

    await waitFor(() =>
      expect(screen.getByText(/estimated usage: 12 credits — used 9/i)).not.toBeNull(),
    );
  });

  it('a balance=0 company sees the blocking modal on chat send, not a generic error toast', async () => {
    sendMessageMock.mockRejectedValueOnce({
      status: 409,
      message:
        'This company has run out of credits. An owner or admin needs to add more credits before this can continue.',
    });

    render(<ChatPanel conversationId="conv1" employee={employee} />, {
      wrapper: makeWrapper(),
    });

    const input = screen.getByPlaceholderText('Ask your employee…');
    fireEvent.change(input, { target: { value: 'hello' } });
    fireEvent.click(screen.getByRole('button', { name: /send/i }));

    await waitFor(() =>
      expect(screen.getByRole('dialog', { name: /out of credits/i })).not.toBeNull(),
    );
  });
});
