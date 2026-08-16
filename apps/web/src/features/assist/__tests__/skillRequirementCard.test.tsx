import { render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { describe, expect, it, vi, beforeEach } from 'vitest';
import type { WorkflowSkillRequirementDto } from '@vaep/types';
import { SkillRequirementCard } from '../components/SkillRequirementCard';

const getSkillRequirements = vi.fn();
vi.mock('@/features/skills/api', () => ({
  getSkillRequirements: (keys: string[]) => getSkillRequirements(keys),
  installSkill: vi.fn(),
  authorizeOAuth: vi.fn(),
}));

const req = (over: Partial<WorkflowSkillRequirementDto> = {}) =>
  ({
    skillKey: 'email',
    displayName: 'Email',
    provider: null,
    capabilities: ['EMAIL_SEND'],
    compatibleSkillKeys: [],
    requiresConnection: true,
    required: true,
    status: 'NOT_CONNECTED',
    connectionStatus: 'NOT_CONNECTED',
    connectionType: 'api_key',
    installedSkillId: null,
    credentialsSet: false,
    nodeIds: ['n2'],
    canManageConnection: true,
    ...over,
  }) as WorkflowSkillRequirementDto;

const payload = (r: WorkflowSkillRequirementDto) => ({
  requirements: [r],
  missingRequiredCount: r.status === 'READY' ? 0 : 1,
  allRequiredReady: r.status === 'READY',
});

function renderCard(props: Partial<Parameters<typeof SkillRequirementCard>[0]> = {}) {
  const qc = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: 0 } },
  });
  return render(
    <QueryClientProvider client={qc}>
      <SkillRequirementCard
        requirements={[req()]}
        sessionId="s1"
        {...props}
      />
    </QueryClientProvider>,
  );
}

describe('SkillRequirementCard', () => {
  beforeEach(() => {
    getSkillRequirements.mockReset();
  });

  it('says the skill is installed but not connected, so the two screens agree', async () => {
    // The trap: the Skills page says "Installed" and this card says "Not
    // connected". Both true — installing does not set credentials. The card has
    // to name the missing half or the user has nowhere to go.
    getSkillRequirements.mockResolvedValue(
      payload(req({ installedSkillId: 'inst_1' })),
    );
    renderCard({ requirements: [req({ installedSkillId: 'inst_1' })] });

    // No jest-dom in this project — plain assertions only.
    expect(
      // Deliberately stops before the apostrophe: the JSX uses `&apos;` (U+0027)
      // and matching a curly quote here silently fails.
      await screen.findByText(/Installed, but its credentials/i),
    ).toBeTruthy();
    expect(screen.getByText(/Finish connecting it/i)).toBeTruthy();
  });

  it('deep-links to that specific skill rather than the top of the Skills page', async () => {
    getSkillRequirements.mockResolvedValue(payload(req()));
    renderCard();

    const link = await screen.findByRole('link', { name: /Set up on the Skills page/i });
    expect(link.getAttribute('href')).toBe('/skills?connect=email');
  });

  it('carries on by itself once the skill becomes connected', async () => {
    // Was: the card kept saying "not connected" until the user re-typed the
    // whole prompt. It now notices on its own and resumes the turn.
    const onResume = vi.fn();
    getSkillRequirements.mockResolvedValue(payload(req({ status: 'READY' })));

    renderCard({ onResume, autoResume: true });

    await waitFor(() => expect(onResume).toHaveBeenCalledTimes(1));
  });

  it('does NOT resume an old card just because the conversation was reopened', async () => {
    // `autoResume` is off for every message except the last one; without this
    // guard, opening a finished conversation would fire a fresh turn.
    const onResume = vi.fn();
    getSkillRequirements.mockResolvedValue(payload(req({ status: 'READY' })));

    renderCard({ onResume, autoResume: false });

    await screen.findByText(/Everything this workflow needs is connected/i);
    expect(onResume).not.toHaveBeenCalled();
  });

  it('resumes at most once, even as the poll keeps returning ready', async () => {
    const onResume = vi.fn();
    getSkillRequirements.mockResolvedValue(payload(req({ status: 'READY' })));

    const { rerender } = renderCard({ onResume, autoResume: true });
    await waitFor(() => expect(onResume).toHaveBeenCalledTimes(1));

    rerender(
      <QueryClientProvider client={new QueryClient()}>
        <SkillRequirementCard
          requirements={[req({ status: 'READY' })]}
          sessionId="s1"
          onResume={onResume}
          autoResume
        />
      </QueryClientProvider>,
    );
    expect(onResume).toHaveBeenCalledTimes(1);
  });
});
