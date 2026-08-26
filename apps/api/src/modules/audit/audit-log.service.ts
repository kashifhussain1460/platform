import { Injectable, Logger } from '@nestjs/common';
import type { AuditLog, LegalHoldScope, Prisma } from '@prisma/client';
import type { AuditLogDto } from '@vaep/types';
import { currentContext } from '../../common/observability/execution-context';
import { PrismaService } from '../../common/prisma/prisma.service';
import { clampLimit } from '../../common/pagination';
import {
  computeEventHash,
  verifyChain,
  type ChainVerification,
} from './audit-chain';
import { toAuditLogDto } from './audit-log.mapper';

/** WAVE 4 §4.2 — who acted. A null actorUserId alone cannot express this. */
/**
 * `PLATFORM_OPERATOR` (Credit system Phase 10) is a real human acting
 * OUTSIDE company auth entirely (`PlatformAdminGuard`, no `User` row) — not
 * `SYSTEM` (unattended) and not `USER` (`actorUserId` is a bare string column
 * with no FK, but overloading it with a PlatformOperator.id would still be
 * misleading about which identity table it names).
 */
export type AuditActorType = 'USER' | 'AI_EMPLOYEE' | 'SYSTEM' | 'PLATFORM_OPERATOR';

export interface RecordAuditParams {
  companyId: string;
  actorUserId?: string | null;
  /** e.g. "workflow.create", "user.role_changed", "skill.install". */
  action: string;
  /** e.g. "Workflow", "User", "InstalledSkill". */
  entityType: string;
  entityId?: string | null;
  metadata?: Record<string, unknown> | null;

  // --- WAVE 4 §4.2, all OPTIONAL so no existing caller changes --------------
  actorType?: AuditActorType;
  employeeId?: string | null;
  workflowId?: string | null;
  workflowRunId?: string | null;
  correlationId?: string | null;
  ip?: string | null;
  userAgent?: string | null;
}

export interface AuditQuery {
  entityType?: string;
  action?: string;
  actorUserId?: string;
  workflowRunId?: string;
  from?: Date;
  to?: Date;
  limit?: unknown;
}

/**
 * Keys whose VALUES are never safe to keep verbatim in an audit trail.
 *
 * §4.2: "sensitive old/new values must be safely redacted or protected." The
 * audit log is the most widely read table in the system — exported, shipped to a
 * SIEM, handed to an auditor — so a credential landing here has the widest blast
 * radius of anywhere.
 */
const SENSITIVE_KEY =
  /pass(word|phrase)|secret|token|credential|api[-_]?key|authorization|cookie|private[-_]?key|signature/i;
const REDACTED = '[redacted]';

/**
 * Who-did-what trail with tamper evidence (WAVE 4).
 *
 * `@Global`-exported (see audit.module.ts) so any module can inject this without
 * a circular import back to a "core" module.
 */
@Injectable()
export class AuditLogService {
  private readonly logger = new Logger(AuditLogService.name);

  constructor(private readonly prisma: PrismaService) {}

  /**
   * Record one entry, chained to its predecessor.
   *
   * Still NEVER throws: an audit write failing must not break the action it
   * describes. That trade is worth naming — it means a write can be silently
   * lost, and the chain then reports a SEQUENCE_GAP rather than pretending the
   * history is complete. Failing the user's action instead would turn an
   * observability problem into an outage.
   *
   * The write runs inside a transaction holding a per-company advisory lock.
   * Without serialisation two concurrent writes read the same predecessor and
   * both chain off it: the sequence unique-constraint rejects one, and a chain
   * that forked would be indistinguishable from a tampered one.
   */
  async record(params: RecordAuditParams): Promise<string | null> {
    try {
      return await this.prisma.$transaction(async (tx) => {
        // Serialise per company. `hashtext` maps the id into the int4 the
        // advisory-lock API takes; a collision between two companies costs a
        // little contention and nothing else.
        await tx.$executeRaw`
          SELECT pg_advisory_xact_lock(hashtext(${`audit:${params.companyId}`}))
        `;

        const previous = await tx.auditLog.findFirst({
          where: { companyId: params.companyId },
          orderBy: { seq: 'desc' },
          select: { seq: true, eventHash: true },
        });

        // WAVE 4 §4.2 / WAVE 5 §5.1 — fill the correlation fields from the
        // ambient execution context when the caller did not pass them. Every
        // one of the 35+ existing call sites therefore gains ip, userAgent,
        // correlationId and run linkage without being edited: an audit trail
        // whose enrichment depends on every author remembering is an audit
        // trail that is enriched almost nowhere.
        const ctx = currentContext();
        const seq = (previous?.seq ?? 0n) + 1n;
        const entry = {
          companyId: params.companyId,
          seq,
          actorUserId: params.actorUserId ?? ctx?.userId ?? null,
          actorType: params.actorType ?? 'USER',
          action: params.action,
          entityType: params.entityType,
          entityId: params.entityId ?? null,
          employeeId: params.employeeId ?? ctx?.employeeId ?? null,
          workflowId: params.workflowId ?? ctx?.workflowId ?? null,
          workflowRunId: params.workflowRunId ?? ctx?.workflowRunId ?? null,
          correlationId:
            params.correlationId ?? ctx?.correlationId ?? ctx?.traceId ?? null,
          ip: params.ip ?? ctx?.ip ?? null,
          userAgent: params.userAgent ?? ctx?.userAgent ?? null,
          metadata: redactSensitive(params.metadata ?? null),
          // Set explicitly rather than letting the DB default it: the hash
          // covers this value, so it must be the SAME instant that is stored.
          createdAt: new Date(),
        };

        const created = await tx.auditLog.create({
          data: {
            ...entry,
            metadata: (entry.metadata ?? undefined) as
              | Prisma.InputJsonValue
              | undefined,
            previousHash: previous?.eventHash ?? null,
            eventHash: computeEventHash(entry, previous?.eventHash ?? null),
          },
        });
        return created.id;
      });
    } catch (err) {
      this.logger.warn(
        `Failed to record audit log entry (${params.action}): ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
      return null;
    }
  }

  /** Recent entries for the company (a global feed), optionally by entityType. */
  async list(
    companyId: string,
    entityType?: string,
    limitRaw?: unknown,
  ): Promise<AuditLogDto[]> {
    return this.query(companyId, { entityType, limit: limitRaw });
  }

  /** WAVE 4 §4.1 — the query API: by actor, action, run or time range. */
  async query(companyId: string, q: AuditQuery): Promise<AuditLogDto[]> {
    const rows = await this.prisma.auditLog.findMany({
      where: {
        companyId,
        ...(q.entityType ? { entityType: q.entityType } : {}),
        ...(q.action ? { action: q.action } : {}),
        ...(q.actorUserId ? { actorUserId: q.actorUserId } : {}),
        ...(q.workflowRunId ? { workflowRunId: q.workflowRunId } : {}),
        ...(q.from || q.to
          ? {
              createdAt: {
                ...(q.from ? { gte: q.from } : {}),
                ...(q.to ? { lte: q.to } : {}),
              },
            }
          : {}),
      },
      orderBy: { createdAt: 'desc' },
      take: clampLimit(q.limit),
    });
    return this.withActorNames(rows);
  }

  /**
   * WAVE 4 §4.4 — verify this company's chain.
   *
   * Reads in `seq` order (the write order), NOT `createdAt`: two entries can
   * share a millisecond, and a verifier sorting by timestamp would report a
   * phantom LINK_MISMATCH whenever they did.
   */
  async verify(companyId: string): Promise<ChainVerification> {
    const rows = await this.prisma.auditLog.findMany({
      where: { companyId },
      orderBy: { seq: 'asc' },
    });
    return verifyChain(rows.map(toChainable));
  }

  /**
   * WAVE 4 §4.1 — export as NDJSON (one JSON object per line).
   *
   * The hashes are INCLUDED: an export that dropped them could not be verified
   * by whoever receives it, which defeats the point of keeping a chain. Ordered
   * oldest-first so the recipient can walk it as a chain.
   */
  async exportNdjson(companyId: string, q: AuditQuery = {}): Promise<string> {
    const rows = await this.prisma.auditLog.findMany({
      where: {
        companyId,
        ...(q.from || q.to
          ? {
              createdAt: {
                ...(q.from ? { gte: q.from } : {}),
                ...(q.to ? { lte: q.to } : {}),
              },
            }
          : {}),
      },
      orderBy: { seq: 'asc' },
    });
    return rows
      .map((r) =>
        JSON.stringify({
          ...r,
          // BigInt is not JSON-serialisable; emit the sequence as a string.
          seq: String(r.seq),
          createdAt: r.createdAt.toISOString(),
        }),
      )
      .join('\n');
  }

  /**
   * True when this company has an ACTIVE legal hold covering `scope` (§4.5,
   * widened in WAVE 8 §8.3).
   *
   * An `ALL` hold covers everything, so it satisfies any scope asked about; an
   * `AUDIT` hold covers only the audit trail. Callers ask for what they are
   * about to delete, and a hold that does not cover it does not block them —
   * which is why the check takes a scope rather than answering "is anything
   * held".
   */
  async hasActiveLegalHold(
    companyId: string,
    scope: LegalHoldScope = 'AUDIT',
  ): Promise<boolean> {
    const hold = await this.prisma.legalHold.findFirst({
      where: {
        companyId,
        releasedAt: null,
        scope: scope === 'ALL' ? 'ALL' : { in: ['ALL', scope] },
      },
      select: { id: true },
    });
    return Boolean(hold);
  }

  private async withActorNames(rows: AuditLog[]): Promise<AuditLogDto[]> {
    const actorIds = [
      ...new Set(
        rows.map((r) => r.actorUserId).filter((id): id is string => Boolean(id)),
      ),
    ];
    const actors = actorIds.length
      ? await this.prisma.user.findMany({
          where: { id: { in: actorIds } },
          select: { id: true, name: true },
        })
      : [];
    const nameById = new Map(actors.map((u) => [u.id, u.name]));

    return rows.map((r) =>
      toAuditLogDto(r, r.actorUserId ? (nameById.get(r.actorUserId) ?? null) : null),
    );
  }
}

/** Prisma row → the shape the pure chain functions verify. */
function toChainable(r: AuditLog) {
  return {
    id: r.id,
    companyId: r.companyId,
    seq: r.seq,
    actorUserId: r.actorUserId,
    actorType: r.actorType,
    action: r.action,
    entityType: r.entityType,
    entityId: r.entityId,
    employeeId: r.employeeId,
    workflowId: r.workflowId,
    workflowRunId: r.workflowRunId,
    correlationId: r.correlationId,
    ip: r.ip,
    userAgent: r.userAgent,
    metadata: r.metadata,
    createdAt: r.createdAt,
    previousHash: r.previousHash,
    eventHash: r.eventHash,
  };
}

/**
 * Replace the VALUE of any sensitive-looking key, at any depth.
 *
 * Matches on the KEY NAME, not the value: a value cannot be recognised as a
 * token by looking at it, and guessing would both miss real secrets and mangle
 * innocent text. Callers should not put secrets in `metadata` at all — this is
 * the backstop for when someone does.
 */
export function redactSensitive(value: unknown): unknown {
  if (value === null || typeof value !== 'object') return value;
  if (Array.isArray(value)) return value.map(redactSensitive);
  const out: Record<string, unknown> = {};
  for (const [key, v] of Object.entries(value as Record<string, unknown>)) {
    out[key] = SENSITIVE_KEY.test(key) ? REDACTED : redactSensitive(v);
  }
  return out;
}
