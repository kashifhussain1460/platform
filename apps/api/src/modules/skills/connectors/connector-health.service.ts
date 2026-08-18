import { Inject, Injectable, Logger, NotFoundException, forwardRef } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Prisma, type InstalledSkill } from '@prisma/client';
import type { ConnectorHealthDto } from '@vaep/types';
import { PrismaService } from '../../../common/prisma/prisma.service';
import { CryptoService } from '../../../common/crypto/crypto.service';
import {
  CONNECTOR_ERROR_MAX_LEN,
  CONNECTOR_FAILURE_THRESHOLD,
  CONNECTOR_HEALTH_BATCH,
} from './connector.constants';
import { ConnectorTokenService } from './connector-token.service';
import { readCredentials, resolveFreshCredentials } from './credentials.util';
import { getHealthProbe } from './health-probe';

/** Statuses considered "live" — the only ones health signals act on. */
const LIVE_STATUSES: readonly InstalledSkill['connectionStatus'][] = [
  'CONNECTED',
  'DEGRADED',
];

/**
 * ConnectorHealthService — the SINGLE SOURCE OF TRUTH for connector connection-
 * status transitions (docs §1.7). Nothing else flips `connectionStatus` for
 * health reasons.
 *
 * State machine:
 *   CONNECTED ──≥N consecutive egress/probe failures──▶ DEGRADED
 *   DEGRADED  ──successful egress/probe──▶ CONNECTED
 *   CONNECTED│DEGRADED ──refresh revoked/invalid_grant──▶ DISCONNECTED (markDisconnected)
 * connect/reconnect resets counters → CONNECTED (owned by SkillsService).
 *
 * Signals:
 *   • PASSIVE (recordSuccess/recordFailure) — driven from the skill egress path
 *     (SkillsService.runTool) on every tool call. Tenant-scoped by (companyId,
 *     skillKey); a no-op when the skill is not installed as a connector, or the
 *     connector is not live (NOT_CONNECTED/DISCONNECTED). Never throws.
 *   • ACTIVE (probe/sweep) — a cheap authenticated call per HealthProbe strategy.
 *     REAL only in live mode (SKILL_EXECUTOR=real|auto); offline/mock → healthy
 *     (so the suite never hits the network and the scheduled sweep is a no-op).
 */
@Injectable()
export class ConnectorHealthService {
  private readonly logger = new Logger(ConnectorHealthService.name);
  /** Real network probes only in live executor mode; offline → mock healthy. */
  private readonly liveProbes: boolean;

  constructor(
    private readonly prisma: PrismaService,
    private readonly crypto: CryptoService,
    config: ConfigService,
    @Inject(forwardRef(() => ConnectorTokenService))
    private readonly tokens: ConnectorTokenService,
  ) {
    const mode = (config.get<string>('SKILL_EXECUTOR') ?? 'mock').toLowerCase();
    this.liveProbes = mode === 'real' || mode === 'auto';
  }

  // --- Passive signals (skill egress path) ---------------------------------

  /** Success on an egress call: reset the failure counter; DEGRADED → CONNECTED. */
  async recordSuccess(companyId: string, skillKey: string): Promise<void> {
    const connector = await this.byKey(companyId, skillKey);
    if (!connector || !this.isLive(connector)) {
      return;
    }
    // Nothing to change for a healthy CONNECTED connector → skip the write.
    if (
      connector.connectionStatus === 'CONNECTED' &&
      connector.consecutiveErrors === 0 &&
      !connector.lastHealthError
    ) {
      return;
    }
    await this.applySuccess(connector);
  }

  /** Failure on an egress call: increment; ≥N (from CONNECTED) → DEGRADED. */
  async recordFailure(
    companyId: string,
    skillKey: string,
    error: string,
  ): Promise<void> {
    const connector = await this.byKey(companyId, skillKey);
    if (!connector || !this.isLive(connector)) {
      return;
    }
    await this.applyFailure(connector, error);
  }

  // --- Active health check (endpoint + scheduled sweep) --------------------

  /**
   * Run an active probe against one connector, stamp `lastHealthCheckAt`, and
   * transition status from the result. Returns the updated row.
   */
  async probe(connector: InstalledSkill): Promise<InstalledSkill> {
    const result = await this.runProbe(connector);
    if (result.healthy) {
      return this.applySuccess(connector, true);
    }
    return this.applyFailure(
      connector,
      result.error ?? 'Health probe failed',
      true,
    );
  }

  /**
   * Scheduled sweep: probe every live (CONNECTED/DEGRADED) connector across all
   * tenants, batched. A NO-OP offline (SKILL_EXECUTOR=mock) so it is safe with no
   * live creds. Per-connector failures are isolated (one bad probe never aborts
   * the sweep).
   */
  async sweep(): Promise<{ probed: number }> {
    if (!this.liveProbes) {
      this.logger.debug('Health sweep skipped (offline / SKILL_EXECUTOR=mock)');
      return { probed: 0 };
    }
    const connectors = await this.prisma.installedSkill.findMany({
      where: { connectionStatus: { in: ['CONNECTED', 'DEGRADED'] }, enabled: true },
      orderBy: { lastHealthCheckAt: { sort: 'asc', nulls: 'first' } },
      take: CONNECTOR_HEALTH_BATCH,
    });
    let probed = 0;
    for (const connector of connectors) {
      try {
        await this.probe(connector);
        probed += 1;
      } catch (err) {
        this.logger.error(
          `Probe failed for connector ${connector.id}: ${this.msg(err)}`,
        );
      }
    }
    return { probed };
  }

  // --- Refresh-failure transition (called by ConnectorTokenService) --------

  /**
   * Force a connector DISCONNECTED after a revoked/invalid_grant token refresh
   * (docs §1.6) — needs re-auth. Raises an alert log; dependent workflows then
   * quarantine (docs §5.5) rather than fail-loop.
   */
  async markDisconnected(connectorId: string, reason: string): Promise<void> {
    const trimmed = this.truncate(reason);
    await this.prisma.installedSkill.update({
      where: { id: connectorId },
      data: {
        connectionStatus: 'DISCONNECTED',
        disabledReason: trimmed,
        lastHealthError: trimmed,
      },
    });
    this.logger.error(`ALERT connector ${connectorId} DISCONNECTED: ${trimmed}`);
  }

  // --- Read surface (endpoints) --------------------------------------------

  /** Health snapshot for an owned connector (404 when not the acting tenant's). */
  async getHealth(
    companyId: string,
    connectorId: string,
  ): Promise<ConnectorHealthDto> {
    return toConnectorHealthDto(await this.owned(companyId, connectorId));
  }

  /** Run a probe now on an owned connector and return the updated health. */
  async runHealthCheck(
    companyId: string,
    connectorId: string,
  ): Promise<ConnectorHealthDto> {
    const connector = await this.owned(companyId, connectorId);
    return toConnectorHealthDto(await this.probe(connector));
  }

  // --- Transition core -----------------------------------------------------

  /** Reset the failure counter + clear the error; heal DEGRADED → CONNECTED. */
  private async applySuccess(
    connector: InstalledSkill,
    probed = false,
  ): Promise<InstalledSkill> {
    const healed = connector.connectionStatus === 'DEGRADED';
    const data: Prisma.InstalledSkillUpdateInput = {
      consecutiveErrors: 0,
      lastHealthError: null,
    };
    if (healed) {
      data.connectionStatus = 'CONNECTED';
    }
    if (probed) {
      data.lastHealthCheckAt = new Date();
    }
    const updated = await this.prisma.installedSkill.update({
      where: { id: connector.id },
      data,
    });
    if (healed) {
      this.logger.log(
        `Connector ${connector.id} (${connector.skillKey}) recovered DEGRADED → CONNECTED`,
      );
    }
    return updated;
  }

  /** Increment the failure counter; CONNECTED + ≥N → DEGRADED (records the error). */
  private async applyFailure(
    connector: InstalledSkill,
    error: string,
    probed = false,
  ): Promise<InstalledSkill> {
    const next = connector.consecutiveErrors + 1;
    const data: Prisma.InstalledSkillUpdateInput = {
      consecutiveErrors: next,
      lastHealthError: this.truncate(error),
    };
    if (probed) {
      data.lastHealthCheckAt = new Date();
    }
    const degrading =
      connector.connectionStatus === 'CONNECTED' &&
      next >= CONNECTOR_FAILURE_THRESHOLD;
    if (degrading) {
      data.connectionStatus = 'DEGRADED';
    }
    const updated = await this.prisma.installedSkill.update({
      where: { id: connector.id },
      data,
    });
    if (degrading) {
      this.logger.warn(
        `Connector ${connector.id} (${connector.skillKey}) CONNECTED → DEGRADED after ${next} consecutive errors: ${error}`,
      );
    }
    return updated;
  }

  /** Resolve the probe result. Offline/mock → healthy (never touches the network). */
  private async runProbe(connector: InstalledSkill) {
    if (!this.liveProbes) {
      return { healthy: true, mock: true };
    }
    const creds = await resolveFreshCredentials(
      this.tokens,
      connector,
      readCredentials(this.crypto, connector.credentials),
      (msg) => this.logger.warn(`Token refresh failed for connector ${connector.id}: ${msg}`),
    );
    const config = (connector.config as Record<string, unknown> | null) ?? {};
    try {
      return await getHealthProbe(connector.skillKey).probe(creds, config);
    } catch (err) {
      return { healthy: false, error: this.msg(err) };
    }
  }

  // --- Helpers -------------------------------------------------------------

  private byKey(
    companyId: string,
    skillKey: string,
  ): Promise<InstalledSkill | null> {
    // findFirst (not findUnique + the companyId_skillKey_employeeId compound
    // key): Prisma's compound-unique-index type requires a non-null
    // employeeId, even though the column is nullable — see the note on
    // SkillsService.resolveInstalledForExecution. This company-wide lookup
    // (employeeId: null) reproduces the exact row the old 2-field key matched.
    return this.prisma.installedSkill.findFirst({
      where: { companyId, skillKey, employeeId: null },
    });
  }

  private async owned(
    companyId: string,
    connectorId: string,
  ): Promise<InstalledSkill> {
    const connector = await this.prisma.installedSkill.findFirst({
      where: { id: connectorId, companyId },
    });
    if (!connector) {
      throw new NotFoundException('Connector not found');
    }
    return connector;
  }

  private isLive(connector: InstalledSkill): boolean {
    return LIVE_STATUSES.includes(connector.connectionStatus);
  }

  private truncate(text: string): string {
    return text.length > CONNECTOR_ERROR_MAX_LEN
      ? text.slice(0, CONNECTOR_ERROR_MAX_LEN)
      : text;
  }

  private msg(err: unknown): string {
    return err instanceof Error ? err.message : String(err);
  }
}

/** Prisma row → public ConnectorHealthDto. */
export function toConnectorHealthDto(c: InstalledSkill): ConnectorHealthDto {
  return {
    connectorId: c.id,
    status: c.connectionStatus,
    lastHealthCheckAt: c.lastHealthCheckAt?.toISOString() ?? null,
    consecutiveErrors: c.consecutiveErrors,
    lastHealthError: c.lastHealthError,
    tokenExpiresAt: c.tokenExpiresAt?.toISOString() ?? null,
    disabledReason: c.disabledReason,
  };
}
