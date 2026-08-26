import type { ReactNode } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { DepartmentDto } from '@vaep/types';
import { DepartmentSection } from './DepartmentSection';

/**
 * Mount + wiring coverage for the department management surface.
 *
 * A compile is not a render: this codebase has already shipped a component
 * that typechecked, passed every test and then looped infinitely in the
 * browser. These cases exercise the paths a build cannot — the scope editor
 * mounting, the quick-add presets firing, and the access badge telling the
 * truth about whether a department restricts anything.
 */
const createDepartment = vi.fn((_p: unknown): Promise<DepartmentDto> =>
  Promise.resolve(row({ id: 'new', name: 'Finance' })),
);
let departments: DepartmentDto[] = [];

function row(over: Partial<DepartmentDto> = {}): DepartmentDto {
  return {
    id: 'd1',
    companyId: 'co-1',
    name: 'HR',
    description: null,
    scopes: [],
    memberCount: 0,
    teamCount: 0,
    createdAt: '2026-08-22T00:00:00.000Z',
    ...over,
  };
}

vi.mock('../api', () => ({
  listDepartments: vi.fn(async () => departments),
  createDepartment: (p: unknown) => createDepartment(p),
  updateDepartment: vi.fn(async () => row()),
  deleteDepartment: vi.fn(async () => undefined),
  departmentDependencies: vi.fn(async () => ({
    departmentId: 'd1',
    name: 'HR',
    members: [],
    teams: [],
    scopes: [],
    wouldWidenAccess: false,
  })),
}));

// OWNER, so the management controls render.
vi.mock('@/features/users/hooks', () => ({
  useCurrentRole: () => 'OWNER',
  userKeys: { list: ['users'] },
}));

vi.mock('@/features/employees/hooks', () => ({
  useEmployees: () => ({
    data: [{ id: 'e1', name: 'HR Bot', role: 'HR' }],
  }),
}));

vi.mock('@/stores/session.store', () => ({
  useSessionStore: (selector: (s: { accessToken: string }) => unknown) =>
    selector({ accessToken: 'token' }),
}));

function renderSection() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const Wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={qc}>{children}</QueryClientProvider>
  );
  return render(<DepartmentSection />, { wrapper: Wrapper });
}

describe('DepartmentSection', () => {
  beforeEach(() => {
    createDepartment.mockClear();
    departments = [row({ memberCount: 3, teamCount: 1 })];
  });

  it('says a department with no scopes sees everything', async () => {
    renderSection();
    expect(await screen.findByText(/Sees everything/i)).not.toBeNull();
  });

  it('names what a scoped department is limited to', async () => {
    departments = [row({ scopes: ['HR', 'RECRUITER'] })];
    renderSection();
    expect(await screen.findByText(/Limited to HR, Recruiter/i)).not.toBeNull();
  });

  it('shows the member and team counts that make a delete’s cost visible', async () => {
    renderSection();
    expect(await screen.findByText(/3 people · 1 team/i)).not.toBeNull();
  });

  it('quick-add creates a preset department with no scopes', async () => {
    renderSection();
    const finance = await screen.findByRole('button', { name: /\+ Finance/i });
    fireEvent.click(finance);
    // A preset is a UI shortcut, NOT authorization logic — it must not smuggle
    // scopes in, or "quick add" would silently start restricting people.
    await waitFor(() =>
      expect(createDepartment).toHaveBeenCalledWith({ name: 'Finance' }),
    );
  });

  it('does not offer a preset the company already has', async () => {
    departments = [row({ name: 'Finance' })];
    renderSection();
    await screen.findByText('Finance');
    expect(screen.queryByRole('button', { name: /\+ Finance/i })).toBeNull();
  });

  it('mounts the access editor without crashing and explains the default', async () => {
    renderSection();
    fireEvent.click(await screen.findByRole('button', { name: /^Access$/i }));
    expect(
      await screen.findByText(/can see everything in the company/i),
    ).not.toBeNull();
  });

  it('the access editor lists AI Employees a scope would cover', async () => {
    renderSection();
    fireEvent.click(await screen.findByRole('button', { name: /^Access$/i }));
    // `AiEmployee` has no department FK — its department axis IS its role, so
    // the editor derives coverage from the selected scopes.
    fireEvent.click(await screen.findByRole('button', { name: /^HR$/i }));
    expect(await screen.findByText(/AI Employees in scope: HR Bot/i)).not.toBeNull();
  });
});
