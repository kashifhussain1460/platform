import { Injectable, Logger } from '@nestjs/common';
import type { MemoryKind } from '@prisma/client';
import { PrismaService } from '../../../../common/prisma/prisma.service';
import { resolveTemplate } from '../template';
import type {
  NodeExecContext,
  NodeHandler,
  NodeResult,
} from './node-handler';

/** Bound on recalled rows so a node cannot pull an employee's whole history. */
const DEFAULT_MEMORY_LIMIT = 10;
const MAX_MEMORY_LIMIT = 50;

/**
 * P2-03 — memory nodes.
 *
 * Both use the ALREADY-SHIPPED `EmployeeMemory` model, so no migration is
 * needed. Every query is scoped by `companyId` AND `employeeId`: memory is the
 * most sensitive per-employee state in the system, and a missing tenant filter
 * here would leak one customer's learned facts into another's run.
 */

/** MEMORY_READ: recall an employee's stored memories into the run context. */
@Injectable()
export class MemoryReadNodeHandler implements NodeHandler {
  readonly type = 'MEMORY_READ' as const;

  constructor(private readonly prisma: PrismaService) {}

  async execute({
    companyId,
    node,
    context,
  }: NodeExecContext): Promise<NodeResult> {
    const cfg = node.config ?? {};
    const employeeId = resolveTemplate(cfg.employeeId, context).trim();
    if (!employeeId) {
      throw new Error(`MEMORY_READ node "${node.id}" has no employeeId`);
    }

    const kind =
      cfg.kind === 'FACT' || cfg.kind === 'SUMMARY'
        ? (cfg.kind as MemoryKind)
        : undefined;
    const requested = Number(cfg.limit);
    const limit =
      Number.isFinite(requested) && requested > 0
        ? Math.min(requested, MAX_MEMORY_LIMIT)
        : DEFAULT_MEMORY_LIMIT;

    // Verify the employee belongs to THIS company before reading its memory —
    // an id from node config is author-supplied input, not a trusted value.
    const employee = await this.prisma.aiEmployee.findFirst({
      where: { id: employeeId, companyId },
      select: { id: true },
    });
    if (!employee) {
      throw new Error(
        `MEMORY_READ node "${node.id}": employee "${employeeId}" not found in this company`,
      );
    }

    const rows = await this.prisma.employeeMemory.findMany({
      where: { companyId, employeeId, ...(kind ? { kind } : {}) },
      orderBy: { createdAt: 'desc' },
      take: limit,
      select: { id: true, kind: true, content: true, source: true, createdAt: true },
    });

    const memories = rows.map((r) => ({
      id: r.id,
      kind: r.kind,
      content: r.content,
      source: r.source,
      createdAt: r.createdAt.toISOString(),
    }));

    return {
      output: { employeeId, kind: kind ?? 'ANY', count: memories.length, memories },
      contextValue: memories,
    };
  }
}

/** MEMORY_WRITE: save a fact or summary to an employee's memory. */
@Injectable()
export class MemoryWriteNodeHandler implements NodeHandler {
  readonly type = 'MEMORY_WRITE' as const;
  private readonly logger = new Logger(MemoryWriteNodeHandler.name);

  constructor(private readonly prisma: PrismaService) {}

  async execute({
    companyId,
    node,
    context,
    dryRun,
  }: NodeExecContext): Promise<NodeResult> {
    const cfg = node.config ?? {};
    const employeeId = resolveTemplate(cfg.employeeId, context).trim();
    const content = resolveTemplate(cfg.content, context).trim();
    const kind: MemoryKind = cfg.kind === 'SUMMARY' ? 'SUMMARY' : 'FACT';

    if (!employeeId) {
      throw new Error(`MEMORY_WRITE node "${node.id}" has no employeeId`);
    }
    if (!content) {
      throw new Error(
        `MEMORY_WRITE node "${node.id}" resolved an empty content template — refusing to store a blank memory`,
      );
    }

    const employee = await this.prisma.aiEmployee.findFirst({
      where: { id: employeeId, companyId },
      select: { id: true },
    });
    if (!employee) {
      throw new Error(
        `MEMORY_WRITE node "${node.id}": employee "${employeeId}" not found in this company`,
      );
    }

    // MEMORY_WRITE mutates durable employee state, so a dry run must not.
    if (dryRun) {
      const preview = {
        dryRun: true,
        employeeId,
        kind,
        content,
        preview: 'Would store this memory — nothing was written.',
      };
      return { output: preview, contextValue: preview };
    }

    const row = await this.prisma.employeeMemory.create({
      data: { companyId, employeeId, kind, content, source: 'RUN' },
    });
    this.logger.log(
      `memory.write employee=${employeeId} company=${companyId} kind=${kind} node=${node.id}`,
    );

    const stored = { id: row.id, employeeId, kind, content };
    return { output: stored, contextValue: stored };
  }
}
