import type { ReactNode } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { DepartmentDependenciesDto, DepartmentDto } from '@vaep/types';
import { DeleteDepartmentDialog } from './DeleteDepartmentDialog';

/**
 * The delete dialog is the UI half of the Phase 2 safety fix, so its decision
 * logic is worth pinning: which action the button actually performs, and
 * whether the widening is ever silent.
 */
const deleteDepartment = vi.fn((_vars: unknown): Promise<void> => Promise.resolve());
let dependencies: DepartmentDependenciesDto;

vi.mock('../api', () => ({
  departmentDependencies: vi.fn(async () => dependencies),
  deleteDepartment: (vars: unknown) => deleteDepartment(vars),
}));

const dept = (over: Partial<DepartmentDto> = {}): DepartmentDto => ({
  id: 'dept-hr',
  companyId: 'co-1',
  name: 'HR',
  description: null,
  scopes: ['HR'],
  memberCount: 1,
  teamCount: 0,
  createdAt: '2026-08-22T00:00:00.000Z',
  ...over,
});

const marketing = dept({ id: 'dept-mkt', name: 'Marketing', scopes: ['MARKETING'] });

function wrapper() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return function Wrapper({ children }: { children: ReactNode }) {
    return <QueryClientProvider client={qc}>{children}</QueryClientProvider>;
  };
}

const renderDialog = (all: DepartmentDto[] = [dept(), marketing]) =>
  render(
    <DeleteDepartmentDialog dept={dept()} allDepartments={all} onClose={vi.fn()} />,
    { wrapper: wrapper() },
  );

describe('DeleteDepartmentDialog', () => {
  beforeEach(() => {
    deleteDepartment.mockClear();
    dependencies = {
      departmentId: 'dept-hr',
      name: 'HR',
      members: [
        { id: 'u1', name: 'Dana Lead', email: 'dana@acme.com', role: 'ADMIN' },
      ],
      teams: [],
      scopes: ['HR'],
      wouldWidenAccess: true,
    };
  });

  it('names the people who would be affected', async () => {
    renderDialog();
    expect(await screen.findByText(/Dana Lead/)).not.toBeNull();
  });

  it('warns, in words, that access would be widened', async () => {
    renderDialog();
    expect(
      await screen.findByText(/gives them access to everything in the company/i),
    ).not.toBeNull();
  });

  it('labels the default action as the widening it actually is', async () => {
    renderDialog();
    expect(
      await screen.findByRole('button', { name: /Remove & make them company-wide/i }),
    ).not.toBeNull();
  });

  it('sends force=true only when no destination was chosen', async () => {
    renderDialog();
    const button = await screen.findByRole('button', {
      name: /Remove & make them company-wide/i,
    });
    fireEvent.click(button);
    await waitFor(() =>
      expect(deleteDepartment).toHaveBeenCalledWith({
        id: 'dept-hr',
        reassignTo: null,
        force: true,
      }),
    );
  });

  it('sends reassignTo (and NOT force) once a destination is picked', async () => {
    renderDialog();
    const select = await screen.findByLabelText(/Move everyone to/i);
    fireEvent.change(select, { target: { value: 'dept-mkt' } });

    const button = await screen.findByRole('button', { name: /Move everyone & remove/i });
    fireEvent.click(button);
    await waitFor(() =>
      expect(deleteDepartment).toHaveBeenCalledWith({
        id: 'dept-hr',
        reassignTo: 'dept-mkt',
        force: false,
      }),
    );
  });

  it('an empty department is a plain removal, with no scary wording', async () => {
    dependencies = { ...dependencies, members: [], wouldWidenAccess: false };
    renderDialog();
    expect(await screen.findByText(/Nobody is in this department/i)).not.toBeNull();
    const button = screen.getByRole('button', { name: /^Remove department$/i });
    fireEvent.click(button);
    await waitFor(() =>
      expect(deleteDepartment).toHaveBeenCalledWith({
        id: 'dept-hr',
        reassignTo: null,
        force: false,
      }),
    );
  });

  it('says so when there is nowhere to move people to', async () => {
    renderDialog([dept()]);
    expect(
      await screen.findByText(/no other department to move them to/i),
    ).not.toBeNull();
  });

  it('reports that teams survive, unassigned', async () => {
    dependencies = {
      ...dependencies,
      teams: [{ id: 't1', name: 'Recruiting' }],
    };
    renderDialog();
    expect(await screen.findByText(/Teams are never deleted/i)).not.toBeNull();
  });
});
