import {
  CreditLimitsService,
  EmployeeExecutionCeilingExceededError,
  EmployeeTaskCeilingExceededError,
  EmployeeBudgetExceededError,
} from './credit-limits.service';

function makePrisma(employee: {
  budgetLimit: number | null;
  maxCreditsPerExecution: number | null;
  maxCreditsPerTask: number | null;
}) {
  const findUniqueOrThrow = jest.fn().mockResolvedValue(employee);
  const findUnique = jest.fn().mockResolvedValue(null);
  const create = jest.fn().mockResolvedValue({
    spent: 0,
    budgetLimitSnapshot: employee.budgetLimit,
  });
  const updateMany = jest.fn().mockResolvedValue({ count: 1 });
  const prisma = {
    aiEmployee: { findUniqueOrThrow },
    employeeCreditPeriodCounter: { findUnique, create, updateMany },
  } as unknown as import('../../common/prisma/prisma.service').PrismaService;
  return { prisma, findUniqueOrThrow, updateMany };
}

describe('CreditLimitsService — per-execution/per-task ceilings', () => {
  it('blocks an EXECUTION over maxCreditsPerExecution without touching the monthly counter', async () => {
    const { prisma, updateMany } = makePrisma({
      budgetLimit: null,
      maxCreditsPerExecution: 50,
      maxCreditsPerTask: null,
    });
    const service = new CreditLimitsService(prisma);

    await expect(
      service.checkAndReserveEmployeeBudget({
        employeeId: 'emp_1',
        companyId: 'co_1',
        cost: 75,
        costKind: 'EXECUTION',
      }),
    ).rejects.toThrow(EmployeeExecutionCeilingExceededError);
    expect(updateMany).not.toHaveBeenCalled();
  });

  it('blocks a TASK over maxCreditsPerTask', async () => {
    const { prisma } = makePrisma({
      budgetLimit: null,
      maxCreditsPerExecution: null,
      maxCreditsPerTask: 10,
    });
    const service = new CreditLimitsService(prisma);

    await expect(
      service.checkAndReserveEmployeeBudget({
        employeeId: 'emp_1',
        companyId: 'co_1',
        cost: 11,
        costKind: 'TASK',
      }),
    ).rejects.toThrow(EmployeeTaskCeilingExceededError);
  });

  it('allows a cost at or under the ceiling, and a null ceiling is unlimited', async () => {
    const { prisma } = makePrisma({
      budgetLimit: null,
      maxCreditsPerExecution: 50,
      maxCreditsPerTask: null,
    });
    const service = new CreditLimitsService(prisma);

    await expect(
      service.checkAndReserveEmployeeBudget({
        employeeId: 'emp_1',
        companyId: 'co_1',
        cost: 50,
        costKind: 'EXECUTION',
      }),
    ).resolves.toBeUndefined();
    await expect(
      service.checkAndReserveEmployeeBudget({
        employeeId: 'emp_1',
        companyId: 'co_1',
        cost: 999,
        costKind: 'TASK',
      }),
    ).resolves.toBeUndefined();
  });

  it('an EXECUTION-ceiling pass still runs the existing monthly-budget check afterward', async () => {
    const { prisma, updateMany } = makePrisma({
      budgetLimit: 1, // $1 → 100 credits at DEFAULT_CREDITS_PER_USD
      maxCreditsPerExecution: 200,
      maxCreditsPerTask: null,
    });
    const service = new CreditLimitsService(prisma);

    updateMany.mockResolvedValueOnce({ count: 0 }); // simulate monthly budget exhausted
    await expect(
      service.checkAndReserveEmployeeBudget({
        employeeId: 'emp_1',
        companyId: 'co_1',
        cost: 50,
        costKind: 'EXECUTION',
      }),
    ).rejects.toThrow(EmployeeBudgetExceededError);
  });
});
