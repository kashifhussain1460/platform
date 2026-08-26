import { Prisma } from '@prisma/client';
import { KnowledgeService } from './knowledge.service';

function fakePrisma() {
  return {
    knowledgeDocument: {
      create: jest.fn(),
      findMany: jest.fn().mockResolvedValue([]),
      findFirst: jest.fn(),
      update: jest.fn(),
      delete: jest.fn(),
    },
    knowledgeChunk: {
      updateMany: jest.fn(),
    },
    $queryRaw: jest.fn().mockResolvedValue([]),
    // Mirrors Prisma's real batch `$transaction(array)`: takes already-created
    // operation promises and resolves them together, returning their results
    // in order — enough fidelity for updateCategory()'s atomicity to be unit-tested.
    $transaction: jest.fn((ops: Promise<unknown>[]) => Promise.all(ops)),
  };
}

function fakeStorage() {
  return { put: jest.fn(), get: jest.fn(), delete: jest.fn() };
}

function fakeEmbeddings() {
  return { embed: jest.fn().mockResolvedValue({ vectors: [[0.1, 0.2, 0.3]] }) };
}

function fakeQueue() {
  return { add: jest.fn() };
}

describe('KnowledgeService category scoping', () => {
  it('list() without a category returns the plain companyId filter (unchanged behavior)', async () => {
    const prisma = fakePrisma();
    const service = new KnowledgeService(
      prisma as never,
      fakeStorage() as never,
      fakeEmbeddings() as never,
      fakeQueue() as never,
      { record: jest.fn() } as never,
      { actorById: jest.fn().mockResolvedValue(null) } as never,
    );

    await service.list('co_1');

    expect(prisma.knowledgeDocument.findMany).toHaveBeenCalledWith({
      where: { companyId: 'co_1' },
      orderBy: { createdAt: 'desc' },
      take: 50,
    });
  });

  it('list() with a category filters to that category OR Shared (null)', async () => {
    const prisma = fakePrisma();
    const service = new KnowledgeService(
      prisma as never,
      fakeStorage() as never,
      fakeEmbeddings() as never,
      fakeQueue() as never,
      { record: jest.fn() } as never,
      { actorById: jest.fn().mockResolvedValue(null) } as never,
    );

    await service.list('co_1', 'SALES');

    expect(prisma.knowledgeDocument.findMany).toHaveBeenCalledWith({
      where: { companyId: 'co_1', OR: [{ category: 'SALES' }, { category: null }] },
      orderBy: { createdAt: 'desc' },
      take: 50,
    });
  });

  it('search() without a category issues no category predicate (unchanged behavior)', async () => {
    const prisma = fakePrisma();
    const service = new KnowledgeService(
      prisma as never,
      fakeStorage() as never,
      fakeEmbeddings() as never,
      fakeQueue() as never,
      { record: jest.fn() } as never,
      { actorById: jest.fn().mockResolvedValue(null) } as never,
    );

    await service.search('co_1', { query: 'refund policy' });

    const sql = prisma.$queryRaw.mock.calls[0][0] as Prisma.Sql;
    expect(sql.sql).not.toContain('category');
  });

  it('search() with a category adds the category-OR-Shared predicate', async () => {
    const prisma = fakePrisma();
    const service = new KnowledgeService(
      prisma as never,
      fakeStorage() as never,
      fakeEmbeddings() as never,
      fakeQueue() as never,
      { record: jest.fn() } as never,
      { actorById: jest.fn().mockResolvedValue(null) } as never,
    );

    await service.search('co_1', { query: 'refund policy', category: 'SALES' });

    const sql = prisma.$queryRaw.mock.calls[0][0] as Prisma.Sql;
    expect(sql.sql).toContain('"category" = ');
    expect(sql.sql).toContain('"category" IS NULL');
    expect(sql.values).toContain('SALES');
  });

  it('updateCategory() updates the document and cascades to all its chunks', async () => {
    const prisma = fakePrisma();
    prisma.knowledgeDocument.findFirst.mockResolvedValue({ id: 'doc_1', companyId: 'co_1' });
    prisma.knowledgeDocument.update.mockResolvedValue({
      id: 'doc_1',
      companyId: 'co_1',
      filename: 'a.txt',
      mimeType: 'text/plain',
      sizeBytes: 10,
      storageKey: 'k',
      status: 'READY',
      error: null,
      chunkCount: 1,
      category: 'HR',
      createdAt: new Date(),
    });
    const service = new KnowledgeService(
      prisma as never,
      fakeStorage() as never,
      fakeEmbeddings() as never,
      fakeQueue() as never,
      { record: jest.fn() } as never,
      { actorById: jest.fn().mockResolvedValue(null) } as never,
    );

    const result = await service.updateCategory('co_1', 'doc_1', 'HR');

    expect(prisma.knowledgeDocument.update).toHaveBeenCalledWith({
      where: { id: 'doc_1' },
      data: { category: 'HR' },
    });
    expect(prisma.knowledgeChunk.updateMany).toHaveBeenCalledWith({
      where: { documentId: 'doc_1' },
      data: { category: 'HR' },
    });
    expect(prisma.$transaction).toHaveBeenCalledTimes(1);
    expect(prisma.$transaction.mock.calls[0][0]).toHaveLength(2);
    expect(result.category).toBe('HR');
  });

  it('updateCategory() accepts null to move a document back to Shared', async () => {
    const prisma = fakePrisma();
    prisma.knowledgeDocument.findFirst.mockResolvedValue({ id: 'doc_1', companyId: 'co_1' });
    prisma.knowledgeDocument.update.mockResolvedValue({
      id: 'doc_1',
      companyId: 'co_1',
      filename: 'a.txt',
      mimeType: 'text/plain',
      sizeBytes: 10,
      storageKey: 'k',
      status: 'READY',
      error: null,
      chunkCount: 1,
      category: null,
      createdAt: new Date(),
    });
    const service = new KnowledgeService(
      prisma as never,
      fakeStorage() as never,
      fakeEmbeddings() as never,
      fakeQueue() as never,
      { record: jest.fn() } as never,
      { actorById: jest.fn().mockResolvedValue(null) } as never,
    );

    const result = await service.updateCategory('co_1', 'doc_1', null);

    expect(prisma.knowledgeChunk.updateMany).toHaveBeenCalledWith({
      where: { documentId: 'doc_1' },
      data: { category: null },
    });
    expect(prisma.$transaction).toHaveBeenCalledTimes(1);
    expect(result.category).toBeNull();
  });
});
