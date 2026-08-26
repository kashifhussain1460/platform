import { ConflictException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { ToolIdempotencyService } from './tool-idempotency.service';

function p2002(): Prisma.PrismaClientKnownRequestError {
  return new Prisma.PrismaClientKnownRequestError('Unique constraint failed', {
    code: 'P2002',
    clientVersion: 'test',
  });
}

describe('ToolIdempotencyService', () => {
  const params = {
    companyId: 'c_1',
    skillKey: 'postiz',
    tool: 'schedule_post',
    key: 'key_1',
    windowMs: 60_000,
  };

  function build() {
    const prisma: any = {
      toolIdempotencyRecord: {
        create: jest.fn(),
        findUniqueOrThrow: jest.fn(),
        update: jest.fn(),
      },
    };
    const service = new ToolIdempotencyService(prisma);
    return { service, prisma };
  }

  it('runs the effect and records COMPLETED on the first call', async () => {
    const { service, prisma } = build();
    prisma.toolIdempotencyRecord.create.mockResolvedValue({ id: 'rec_1' });
    const effect = jest.fn().mockResolvedValue({ hello: 'world' });

    const { result, deduped } = await service.runIdempotent({ ...params, effect });

    expect(effect).toHaveBeenCalledTimes(1);
    expect(deduped).toBe(false);
    expect(result).toEqual({ hello: 'world' });
    expect(prisma.toolIdempotencyRecord.update).toHaveBeenCalledWith({
      where: { id: 'rec_1' },
      data: { status: 'COMPLETED', resultJson: { hello: 'world' } },
    });
  });

  it('replays a prior COMPLETED result within the window WITHOUT running the effect again', async () => {
    const { service, prisma } = build();
    prisma.toolIdempotencyRecord.create.mockRejectedValue(p2002());
    prisma.toolIdempotencyRecord.findUniqueOrThrow.mockResolvedValue({
      id: 'rec_1',
      status: 'COMPLETED',
      resultJson: { scheduledPostId: 'sp_1' },
      createdAt: new Date(),
    });
    const effect = jest.fn();

    const { result, deduped } = await service.runIdempotent({ ...params, effect });

    expect(effect).not.toHaveBeenCalled();
    expect(deduped).toBe(true);
    expect(result).toEqual({ scheduledPostId: 'sp_1' });
  });

  it('throws ConflictException when a PENDING attempt is still in flight within the window', async () => {
    const { service, prisma } = build();
    prisma.toolIdempotencyRecord.create.mockRejectedValue(p2002());
    prisma.toolIdempotencyRecord.findUniqueOrThrow.mockResolvedValue({
      id: 'rec_1',
      status: 'PENDING',
      createdAt: new Date(),
    });
    const effect = jest.fn();

    await expect(service.runIdempotent({ ...params, effect })).rejects.toBeInstanceOf(
      ConflictException,
    );
    expect(effect).not.toHaveBeenCalled();
  });

  it('allows a fresh attempt (reusing the row) when the prior attempt FAILED', async () => {
    const { service, prisma } = build();
    prisma.toolIdempotencyRecord.create.mockRejectedValue(p2002());
    prisma.toolIdempotencyRecord.findUniqueOrThrow.mockResolvedValue({
      id: 'rec_1',
      status: 'FAILED',
      createdAt: new Date(),
    });
    prisma.toolIdempotencyRecord.update.mockResolvedValueOnce({ id: 'rec_1' });
    const effect = jest.fn().mockResolvedValue({ ok: true });

    const { result, deduped } = await service.runIdempotent({ ...params, effect });

    expect(effect).toHaveBeenCalledTimes(1);
    expect(deduped).toBe(false);
    expect(result).toEqual({ ok: true });
    // First update call re-opens the row to PENDING before the effect runs.
    expect(prisma.toolIdempotencyRecord.update).toHaveBeenNthCalledWith(1, {
      where: { id: 'rec_1' },
      data: { status: 'PENDING', resultJson: Prisma.JsonNull, errorMessage: null },
    });
  });

  it('allows a fresh attempt when a prior COMPLETED result is OUTSIDE the window', async () => {
    const { service, prisma } = build();
    prisma.toolIdempotencyRecord.create.mockRejectedValue(p2002());
    prisma.toolIdempotencyRecord.findUniqueOrThrow.mockResolvedValue({
      id: 'rec_1',
      status: 'COMPLETED',
      resultJson: { old: true },
      createdAt: new Date(Date.now() - 120_000), // older than the 60s window
    });
    prisma.toolIdempotencyRecord.update.mockResolvedValueOnce({ id: 'rec_1' });
    const effect = jest.fn().mockResolvedValue({ fresh: true });

    const { result, deduped } = await service.runIdempotent({ ...params, effect });

    expect(effect).toHaveBeenCalledTimes(1);
    expect(deduped).toBe(false);
    expect(result).toEqual({ fresh: true });
  });

  it('marks FAILED and rethrows when the effect itself throws', async () => {
    const { service, prisma } = build();
    prisma.toolIdempotencyRecord.create.mockResolvedValue({ id: 'rec_1' });
    const effect = jest.fn().mockRejectedValue(new Error('provider down'));

    await expect(service.runIdempotent({ ...params, effect })).rejects.toThrow(
      'provider down',
    );
    expect(prisma.toolIdempotencyRecord.update).toHaveBeenCalledWith({
      where: { id: 'rec_1' },
      data: { status: 'FAILED', errorMessage: 'provider down' },
    });
  });

  it('rethrows a non-P2002 error from the initial create unchanged', async () => {
    const { service, prisma } = build();
    prisma.toolIdempotencyRecord.create.mockRejectedValue(new Error('db down'));
    const effect = jest.fn();

    await expect(service.runIdempotent({ ...params, effect })).rejects.toThrow('db down');
    expect(effect).not.toHaveBeenCalled();
  });
});
