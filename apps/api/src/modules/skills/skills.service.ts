import {
  BadRequestException,
  ConflictException,
  Inject,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { Prisma, type InstalledSkill } from '@prisma/client';
import type {
  ConfigFieldDto,
  EmployeeSkillDto,
  InstalledSkillDto,
  SkillConnectionStatus,
  SkillDefinitionDto,
  ToolCallDto,
  ToolDefinitionDto,
} from '@vaep/types';
import { PrismaService } from '../../common/prisma/prisma.service';
import { clampLimit } from '../../common/pagination';
import { AuditLogService } from '../audit/audit-log.service';
import { CryptoService } from '../../common/crypto/crypto.service';
import { redactSecrets } from '../../common/crypto/redact-secrets';
import { enrichContext } from '../../common/observability/execution-context';
import {
  METRIC,
  MetricsRegistry,
} from '../../common/observability/metrics.registry';
import { CircuitBreakerRegistry } from '../../common/resilience/circuit-breaker.registry';
import { CircuitOpenError } from '../../common/resilience/circuit-breaker';
import { RateLimiter } from '../../common/resilience/rate-limiter';
import { countsTowardCircuit } from '../../common/resilience/error-classifier';
import { SkillCatalog, type SkillDefinition } from './catalog';
import {
  getProviderAdapter,
  runVerification,
  type VerifyStep,
} from './providers';
import { ConnectorHealthService } from './connectors/connector-health.service';
import { ConnectorTokenService } from './connectors/connector-token.service';
import {
  credString,
  readCredentials as decryptCreds,
  sealCredentials as encryptCreds,
} from './connectors/credentials.util';
import { ConfigureSkillDto } from './dto/configure-skill.dto';
import { ConnectSkillDto } from './dto/connect-skill.dto';
import { InstallSkillDto } from './dto/install-skill.dto';
import { UpdateInstalledSkillDto } from './dto/update-installed-skill.dto';
import {
  SKILL_EXECUTOR_TOKEN,
  type ExecutorContext,
  type SkillExecutionResult,
  type SkillExecutor,
} from './executors/skill-executor';
import { toEmployeeSkillDto, toInstalledSkillDto } from './skills.mapper';
import { SuppressionService } from '../engines/marketing/suppression.service';
import { extractRecipients } from './recipient-extraction';

/** The detail of the first FAILED verification step — what to show + store. */
function lastFailure(steps: VerifyStep[]): string | undefined {
  return steps.find((s) => s.status === 'FAILED')?.detail;
}

/**
 * Tenant-scoped skills: install/uninstall built-in skills, assign them to
 * employees, resolve an employee's available tools, and run a tool through the
 * (swappable) SkillExecutor while writing an audit row. Every query is scoped by
 * companyId (from the JWT) so tenants never see each other's skills.
 */
@Injectable()
export class SkillsService {
  private readonly logger = new Logger(SkillsService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly crypto: CryptoService,
    private readonly health: ConnectorHealthService,
    private readonly tokens: ConnectorTokenService,
    private readonly breakers: CircuitBreakerRegistry,
    private readonly rateLimiter: RateLimiter,
    @Inject(SKILL_EXECUTOR_TOKEN) private readonly executor: SkillExecutor,
    private readonly auditLog: AuditLogService,
    // WAVE 5 §5.3 — provider latency + skill failure, at the one choke point.
    private readonly metrics: MetricsRegistry,
    // WAVE 3 §3.6 — "may we contact this person?", enforced for every tool.
    private readonly suppression: SuppressionService,
  ) {}

  // --- Catalog -------------------------------------------------------------

  /** The built-in catalog (code, not DB) with each skill's tools. */
  getCatalog(): SkillDefinitionDto[] {
    return SkillCatalog.list();
  }

  // --- Installed skills ----------------------------------------------------

  async install(
    companyId: string,
    dto: InstallSkillDto,
    actorUserId?: string,
  ): Promise<InstalledSkillDto> {
    const def = SkillCatalog.get(dto.skillKey);
    if (!def) {
      throw new NotFoundException(`Unknown skill: ${dto.skillKey}`);
    }
    const employeeId = dto.employeeId ?? null;
    let employeeName: string | null = null;
    if (employeeId) {
      const employee = await this.prisma.aiEmployee.findFirst({
        where: { id: employeeId, companyId },
        select: { name: true },
      });
      if (!employee) {
        throw new NotFoundException('Employee not found');
      }
      employeeName = employee.name;
    }
    // findFirst (not findUnique + the compound key) because `employeeId` here
    // is `string | null`: Prisma's compound-unique-index type requires a
    // non-null `employeeId`, even though the column is nullable (see the
    // note on resolveInstalledForExecution below) — findFirst on the same
    // 3-field equality matches the identical row in every case that matters.
    const existing = await this.prisma.installedSkill.findFirst({
      where: { companyId, skillKey: dto.skillKey, employeeId },
    });
    if (existing) {
      throw new ConflictException('Skill is already installed');
    }
    // Transactional: an employee-owned connection is auto-assigned to that same
    // employee (there's exactly one sensible owner, so a separate manual
    // "assign" step would be pure friction) — both writes commit together.
    const row = await this.prisma.$transaction(async (tx) => {
      const created = await tx.installedSkill.create({
        data: {
          companyId,
          skillKey: dto.skillKey,
          employeeId,
          displayName:
            dto.displayName?.trim() ||
            (employeeName ? `${def.name} — ${employeeName}` : def.name),
          config:
            dto.config === undefined
              ? undefined
              : (dto.config as Prisma.InputJsonObject),
          // Mirror the catalog connection type; starts NOT_CONNECTED (default).
          connectionType: def.connection.type,
          enabled: true,
        },
      });
      if (employeeId) {
        await tx.employeeSkill.create({
          data: { companyId, employeeId, installedSkillId: created.id },
        });
      }
      return created;
    });
    await this.auditLog.record({
      companyId,
      actorUserId,
      action: 'skill.install',
      entityType: 'InstalledSkill',
      entityId: row.id,
      metadata: { skillKey: dto.skillKey, employeeId },
    });
    return toInstalledSkillDto(row);
  }

  async listInstalled(
    companyId: string,
    limitRaw?: unknown,
  ): Promise<InstalledSkillDto[]> {
    const rows = await this.prisma.installedSkill.findMany({
      where: { companyId },
      orderBy: { createdAt: 'desc' },
      take: clampLimit(limitRaw),
    });
    return rows.map(toInstalledSkillDto);
  }

  /**
   * Resolve the InstalledSkill that a workflow step for `skillKey` would run
   * against — the acting employee's OWN connection if one exists, else the
   * company-wide one — as a masked DTO (never raw credentials). Returns null
   * when the tenant has no such connection. Used by the workflow skill-
   * dependency resolver to report per-skill connection readiness; it reuses the
   * same lookup as execution so "what the card shows" can never drift from
   * "what actually runs".
   */
  async findInstalledConnection(
    companyId: string,
    skillKey: string,
    employeeId?: string | null,
  ): Promise<InstalledSkillDto | null> {
    const row = await this.resolveInstalledForExecution(
      companyId,
      employeeId ?? null,
      skillKey,
    );
    return row ? toInstalledSkillDto(row) : null;
  }

  async updateInstalled(
    companyId: string,
    id: string,
    dto: UpdateInstalledSkillDto,
  ): Promise<InstalledSkillDto> {
    await this.findOwnedInstalled(companyId, id);
    const row = await this.prisma.installedSkill.update({
      where: { id },
      data: {
        enabled: dto.enabled,
        displayName: dto.displayName,
        config:
          dto.config === undefined
            ? undefined
            : (dto.config as Prisma.InputJsonObject),
      },
    });
    return toInstalledSkillDto(row);
  }

  async uninstall(companyId: string, id: string): Promise<void> {
    await this.findOwnedInstalled(companyId, id);
    // Cascades to EmployeeSkill assignments (onDelete: Cascade).
    await this.prisma.installedSkill.delete({ where: { id } });
  }

  // --- Configuration + connection ------------------------------------------

  /**
   * Set company-specific configuration. Each provided field is validated against
   * the skill's catalog `configSchema` (type / required / select-options).
   * Non-secret fields are stored in `config`; `secret:true` fields go to
   * `credentials`, ENCRYPTED at rest (only a masked boolean is ever returned).
   * Config/connection is OPTIONAL and NON-BLOCKING — the mock executor runs
   * without either.
   */
  async configureSkill(
    companyId: string,
    id: string,
    dto: ConfigureSkillDto,
  ): Promise<InstalledSkillDto> {
    const installed = await this.findOwnedInstalled(companyId, id);
    const def = this.defFor(installed.skillKey);
    const { config, secrets } = this.partitionConfig(def, dto.config);

    const mergedConfig = {
      ...((installed.config as Record<string, unknown> | null) ?? {}),
      ...config,
    };
    // Merge new secrets into any already-stored (decrypted) creds, then re-seal
    // as an encrypted envelope. Leave the column untouched when there are none.
    const mergedCreds = {
      ...this.readCredentials(installed.credentials),
      ...secrets,
    };

    const row = await this.prisma.installedSkill.update({
      where: { id },
      data: {
        config: mergedConfig as Prisma.InputJsonObject,
        credentials:
          Object.keys(mergedCreds).length > 0
            ? this.sealCredentials(mergedCreds)
            : undefined,
      },
    });
    return toInstalledSkillDto(row);
  }

  /**
   * Connect an installed skill. For `api_key` skills the provided key(s) are
   * stored in `credentials`; for `oauth` skills this is a STUB that just marks
   * the skill connected (accepting whatever token is passed). Sets
   * connectionStatus=CONNECTED and connectionType from the catalog. The provided
   * credentials are ENCRYPTED at rest (never returned raw).
   *
   * TODO: real OAuth authorization-code flow.
   */
  async connectSkill(
    companyId: string,
    id: string,
    dto: ConnectSkillDto,
  ): Promise<InstalledSkillDto> {
    const installed = await this.findOwnedInstalled(companyId, id);
    const def = this.defFor(installed.skillKey);

    // Merge with any existing (decrypted) creds, then persist only the ciphertext.
    const mergedCreds = {
      ...this.readCredentials(installed.credentials),
      ...dto.credentials,
    };

    // §37 — "A skill is NOT complete because the Install button works."
    //
    // This method used to write CONNECTED unconditionally: type any string into
    // the box and the connector claimed to be live, while the first real
    // execution failed (or silently ran on the mock executor). That is the §1
    // `Install → API Key → Save` anti-pattern, and it is why a customer could
    // see "Installed" on one screen and "Not connected" on another with no way
    // to tell which was right.
    //
    // Skills WITHOUT an adapter keep the previous behaviour on purpose — see the
    // provider-adapter header. Only providers that can actually be checked are
    // held to the gate.
    const adapter = getProviderAdapter(installed.skillKey);
    if (adapter) {
      const check = await adapter.validateCredentials({
        creds: mergedCreds,
        config: ((installed.config as Record<string, unknown> | null) ?? {}),
      });
      if (!check.ok) {
        await this.auditLog.record({
          companyId,
          action: 'connector.connect_failed',
          entityType: 'InstalledSkill',
          entityId: installed.id,
          metadata: {
            skillKey: installed.skillKey,
            code: check.code ?? 'AUTH_FAILED',
            // The adapter guarantees this carries no credential (§4).
            detail: check.detail ?? null,
          },
        });
        throw new BadRequestException(
          check.detail ?? 'The provider rejected these credentials.',
        );
      }
    }

    const row = await this.prisma.installedSkill.update({
      where: { id },
      data: {
        credentials: this.sealCredentials(mergedCreds),
        connectionType: def.connection.type,
        connectionStatus: 'CONNECTED',
        // (Re)connect resets the health lifecycle → CONNECTED (docs §1.7).
        consecutiveErrors: 0,
        lastHealthError: null,
        disabledReason: null,
        tokenExpiresAt: this.parseExpiry(mergedCreds),
      },
    });
    // WAVE 9 §Audit — connector lifecycle. Connecting a skill grants an AI
    // Employee the ability to act on a real outside account, so it belongs in
    // the trail next to role changes. Credentials are NEVER included: the
    // metadata records that a connection happened, not what it authenticates
    // with.
    await this.auditLog.record({
      companyId,
      action: 'connector.connected',
      entityType: 'InstalledSkill',
      entityId: row.id,
      metadata: {
        skillKey: installed.skillKey,
        connectionType: def.connection.type,
        employeeId: installed.employeeId ?? null,
      },
    });
    return toInstalledSkillDto(row);
  }

  /** Disconnect: clear credentials, reset health, back to NOT_CONNECTED. */
  async disconnectSkill(
    companyId: string,
    id: string,
  ): Promise<InstalledSkillDto> {
    const installed = await this.findOwnedInstalled(companyId, id);
    const row = await this.prisma.installedSkill.update({
      where: { id },
      data: {
        credentials: Prisma.JsonNull,
        connectionStatus: 'NOT_CONNECTED',
        consecutiveErrors: 0,
        lastHealthError: null,
        disabledReason: null,
        tokenExpiresAt: null,
      },
    });
    await this.auditLog.record({
      companyId,
      action: 'connector.disconnected',
      entityType: 'InstalledSkill',
      entityId: row.id,
      metadata: {
        skillKey: installed.skillKey,
        employeeId: installed.employeeId ?? null,
      },
    });
    return toInstalledSkillDto(row);
  }

  // --- Assignments (employee ↔ installed skill) ----------------------------

  async assign(
    companyId: string,
    employeeId: string,
    installedSkillId: string,
  ): Promise<EmployeeSkillDto> {
    await this.assertEmployee(companyId, employeeId);
    await this.findOwnedInstalled(companyId, installedSkillId);
    // Idempotent: re-assigning an already-assigned skill returns the existing row.
    const existing = await this.prisma.employeeSkill.findUnique({
      where: { employeeId_installedSkillId: { employeeId, installedSkillId } },
    });
    if (existing) {
      return toEmployeeSkillDto(existing);
    }
    const row = await this.prisma.employeeSkill.create({
      data: { companyId, employeeId, installedSkillId },
    });
    return toEmployeeSkillDto(row);
  }

  async unassign(
    companyId: string,
    employeeId: string,
    installedSkillId: string,
  ): Promise<void> {
    await this.assertEmployee(companyId, employeeId);
    const row = await this.prisma.employeeSkill.findFirst({
      where: { companyId, employeeId, installedSkillId },
    });
    if (!row) {
      throw new NotFoundException('Skill is not assigned to this employee');
    }
    await this.prisma.employeeSkill.delete({ where: { id: row.id } });
  }

  async listEmployeeSkills(
    companyId: string,
    employeeId: string,
    limitRaw?: unknown,
  ): Promise<EmployeeSkillDto[]> {
    await this.assertEmployee(companyId, employeeId);
    const rows = await this.prisma.employeeSkill.findMany({
      where: { companyId, employeeId },
      orderBy: { createdAt: 'asc' },
      take: clampLimit(limitRaw),
    });
    return rows.map(toEmployeeSkillDto);
  }

  // --- Runtime seam --------------------------------------------------------

  /** Tools available to an employee: from its assigned + ENABLED installed skills. */
  async getToolsForEmployee(
    companyId: string,
    employeeId: string,
  ): Promise<ToolDefinitionDto[]> {
    const rows = await this.prisma.employeeSkill.findMany({
      where: { companyId, employeeId, installedSkill: { enabled: true } },
      include: { installedSkill: true },
      orderBy: { createdAt: 'asc' },
    });
    const tools: ToolDefinitionDto[] = [];
    for (const row of rows) {
      const def = SkillCatalog.get(row.installedSkill.skillKey);
      if (def) {
        // Tag each tool with its owning skill (docs/test-cases WF-E3): tool
        // NAMES aren't globally unique (e.g. both `email` and `gmail` expose
        // `send_email`) — an LLM provider resolves the right skill from this
        // field instead of an ambiguous global name search.
        tools.push(
          ...def.tools.map((t) => ({ ...t, skillKey: row.installedSkill.skillKey })),
        );
      }
    }
    return tools;
  }

  /**
   * Suppressed recipients for this call, or null when it addresses nobody.
   *
   * Fails OPEN on an infrastructure error, deliberately and narrowly: if the
   * suppression table cannot be read, blocking every outbound message across the
   * platform turns a database blip into a total communications outage. The
   * trade is stated rather than hidden — it is the one place here that prefers
   * availability, and it is logged at error level so it cannot pass unnoticed.
   */
  private async findSuppressedRecipients(
    companyId: string,
    skillKey: string,
    tool: string,
    args: Record<string, unknown>,
  ): Promise<{ channel: string; addresses: string[] } | null> {
    const recipients = extractRecipients(skillKey, tool, args);
    if (!recipients) return null;
    try {
      const addresses = await this.suppression.findSuppressed(
        companyId,
        recipients.channel,
        recipients.addresses,
      );
      return addresses.length > 0
        ? { channel: recipients.channel, addresses }
        : null;
    } catch (err) {
      this.logger.error(
        `suppression check FAILED for ${skillKey}.${tool} (company=${companyId}) — ` +
          `allowing the send; investigate immediately: ${
            err instanceof Error ? err.message : String(err)
          }`,
      );
      return null;
    }
  }

  /**
   * Least-privilege gate (doc 09 §9.D). A call attributed to a specific AI
   * employee may only run tools from a skill that employee was actually granted
   * (an ENABLED EmployeeSkill row). A call with NO employeeId (company-wide
   * manual `POST /skills/:id/run`, or a workflow TOOL_ACTION that names no
   * employee) is out of employee scope and is allowed as before — back-compat.
   */
  private async employeeMayUseSkill(
    ctx: ExecutorContext,
    skillKey: string,
  ): Promise<boolean> {
    if (!ctx.employeeId) return true;
    const grant = await this.prisma.employeeSkill.findFirst({
      where: {
        companyId: ctx.companyId,
        employeeId: ctx.employeeId,
        installedSkill: { skillKey, enabled: true },
      },
      select: { id: true },
    });
    return grant !== null;
  }

  /**
   * Execute a tool via the SkillExecutor and WRITE a SkillExecution audit row.
   * Never throws for tool-level failures — returns a ToolCallDto with ok:false
   * so the caller (runtime or manual endpoint) can surface it.
   */
  async runTool(
    ctx: ExecutorContext,
    skillKey: string,
    tool: string,
    args: Record<string, unknown>,
  ): Promise<ToolCallDto> {
    const safeArgs = (args ?? {}) as Record<string, unknown>;
    // WAVE 5 §5.3 — provider latency covers the WHOLE tool call, including
    // credential resolution and the circuit breaker, because that is what the
    // caller actually waits for. Timing only the fetch would understate it.
    const startedAt = Date.now();

    // Taint set for redaction (P1-8): {{secret.X}} values a node resolved, plus
    // the connector's own decrypted credential values (appended once resolved).
    const secretMaskValues: string[] = [...(ctx.secretValues ?? [])];

    // WAVE 3 §3.6 — suppression, checked BEFORE the provider call.
    //
    // Placed at this choke point rather than inside each executor so it covers
    // every path that can reach a person: the chat ACT loop, a workflow
    // TOOL_ACTION, a template, and any executor added later. A rule enforced in
    // one executor is a rule the next executor forgets.
    //
    // A hard block, not a warning: once the message is sent, "we'll review it
    // later" has no meaning — that single send IS the breach.
    const suppressed = await this.findSuppressedRecipients(
      ctx.companyId,
      skillKey,
      tool,
      safeArgs,
    );

    let outcome: SkillExecutionResult;
    if (suppressed) {
      outcome = {
        ok: false,
        error:
          `Blocked: ${suppressed.addresses.length} recipient(s) are on the ` +
          `${suppressed.channel} suppression list (unsubscribed, bounced or ` +
          `complained). Remove the suppression deliberately if this is wrong.`,
      };
      this.metrics.counter(
        METRIC.skillFailureTotal,
        'Tool calls that failed',
        { skill: skillKey, tool, reason: 'suppressed' },
      );
    } else if (!SkillCatalog.getTool(skillKey, tool)) {
      outcome = { ok: false, error: `Unknown skill/tool: ${skillKey}/${tool}` };
    } else if (!(await this.employeeMayUseSkill(ctx, skillKey))) {
      // Doc 09 §9.D — least privilege enforced at EXECUTION, not just when
      // listing tools. Without this an LLM hallucinating a skillKey, or a
      // TOOL_ACTION node naming any installed skill, would run with the
      // tenant's real credentials regardless of what the employee was granted.
      outcome = {
        ok: false,
        error: `Skill "${skillKey}" is not assigned to this AI employee`,
      };
    } else {
      // Real/auto executors need the tenant's decrypted credentials + config +
      // connection status. The default mock leaves usesInstalledCredentials
      // falsy so its path does ZERO extra DB work (suite behaviour unchanged).
      const execCtx = this.executor.usesInstalledCredentials
        ? await this.resolveExecutorContext(ctx, skillKey)
        : ctx;
      // A provider error can echo the very credential it rejected — add the
      // resolved credential values to the redaction set.
      for (const v of Object.values(execCtx.credentials ?? {})) {
        if (typeof v === 'string') secretMaskValues.push(v);
      }
      // Resilience (Unit C, docs §9): wrap ONLY real/auto provider calls against a
      // resolved connector with the per-connector circuit breaker + rate limiter.
      // The mock path (usesInstalledCredentials falsy) and connector-less calls run
      // UNWRAPPED, so the offline suite is never throttled or circuit-broken.
      const connectorId = this.executor.usesInstalledCredentials
        ? (execCtx.installedSkillId ?? null)
        : null;
      if (connectorId) {
        outcome = await this.runGuardedEgress(
          connectorId,
          skillKey,
          tool,
          safeArgs,
          execCtx,
        );
      } else {
        try {
          outcome = await this.executor.execute(
            skillKey,
            tool,
            safeArgs,
            execCtx,
          );
        } catch (err) {
          outcome = {
            ok: false,
            error: err instanceof Error ? err.message : 'Tool execution failed',
          };
        }
      }
      // Passive connector health signal (docs §1.8): a real egress outcome feeds
      // the state machine. No-op when the skill isn't installed as a connector or
      // isn't live; never breaks the tool call (health tracking is best-effort).
      await this.recordEgressHealth(ctx.companyId, skillKey, outcome);
    }

    // Redact any leaked secret/credential value from the persisted audit row AND
    // the returned call — the single taint boundary for tool egress. `safeArgs`
    // was handed to the executor with REAL values (a `{{secret.X}}` resolves
    // INTO an arg value); the persisted/returned copy must mask them, or the
    // secret lands verbatim in SkillExecution.args / step output / run context.
    const safeError = redactSecrets(outcome.error ?? null, secretMaskValues);
    const safeResult = redactSecrets(outcome.result ?? null, secretMaskValues);
    const maskedArgs = redactSecrets(safeArgs, secretMaskValues) as Record<
      string,
      unknown
    >;

    // WAVE 5 §5.3 — the two metrics the plan names for external calls. Emitted
    // here rather than inside each executor: this is the single choke point
    // every tool call passes through, so one site covers mock, real and every
    // future executor.
    this.metrics.observe(
      METRIC.providerLatencyMs,
      'End-to-end latency of one tool call',
      Date.now() - startedAt,
      { skill: skillKey, ok: String(outcome.ok) },
    );
    if (!outcome.ok) {
      this.metrics.counter(
        METRIC.skillFailureTotal,
        'Tool calls that failed',
        { skill: skillKey, tool },
      );
    }

    const execution = await this.prisma.skillExecution.create({
      data: {
        companyId: ctx.companyId,
        employeeId: ctx.employeeId ?? null,
        conversationId: ctx.conversationId ?? null,
        skillKey,
        tool,
        args: maskedArgs as Prisma.InputJsonObject,
        result:
          safeResult == null
            ? Prisma.JsonNull
            : (safeResult as Prisma.InputJsonValue),
        status: outcome.ok ? 'SUCCESS' : 'ERROR',
        error: typeof safeError === 'string' ? safeError : null,
      },
    });

    // Correlation (WAVE 3 §12 / WAVE 5 §5.1): every log line and audit entry
    // emitted after this call can now name the exact SkillExecution row, which
    // is the join key between "the workflow did something" and "the provider
    // was called".
    enrichContext({ skillExecutionId: execution.id });

    return {
      skillKey,
      tool,
      args: maskedArgs,
      result: safeResult ?? null,
      ok: outcome.ok,
      // Only on failure, and only the masked form — the same string the
      // SkillExecution row stores. A success carrying an `error` key would be a
      // confusing shape for every consumer.
      ...(outcome.ok || typeof safeError !== 'string'
        ? {}
        : { error: safeError }),
    };
  }

  /**
   * Run a real/auto provider tool call through the per-connector circuit breaker
   * + rate limiter (docs §9). A tripped breaker fast-fails WITHOUT calling the
   * provider and returns a clear "temporarily unavailable" error (which then feeds
   * ConnectorHealthService via recordEgressHealth → DEGRADED). A rate-limit denial
   * surfaces a retryable "rate limit exceeded" error (no provider call, and NOT a
   * breaker failure — it's our throttle, not the provider's fault). Provider
   * failures that indicate the connector is unhealthy (RETRYABLE, or auth) advance
   * the breaker; plain validation (4xx) failures leave it untouched.
   */
  private async runGuardedEgress(
    connectorId: string,
    skillKey: string,
    tool: string,
    args: Record<string, unknown>,
    execCtx: ExecutorContext,
  ): Promise<SkillExecutionResult> {
    // 1) Circuit gate — OPEN → fast-fail; the provider is NOT called.
    try {
      await this.breakers.guard(connectorId);
    } catch (err) {
      if (err instanceof CircuitOpenError) {
        return {
          ok: false,
          error: `${skillKey} is temporarily unavailable (circuit open); please retry shortly`,
        };
      }
      throw err;
    }

    // 2) Per-connector rate limit — deny → retryable tool error (no provider call).
    const allowed = await this.rateLimiter.acquireForConnector(connectorId);
    if (!allowed) {
      return {
        ok: false,
        error: `${skillKey} rate limit exceeded; please retry shortly`,
      };
    }

    // 3) The provider call (executor returns {ok:false} rather than throwing, but
    //    guard against an unexpected throw and record it against the breaker).
    let outcome: SkillExecutionResult;
    try {
      outcome = await this.executor.execute(skillKey, tool, args, execCtx);
    } catch (err) {
      if (countsTowardCircuit(err)) {
        await this.breakers.recordFailure(connectorId);
      }
      return {
        ok: false,
        error: err instanceof Error ? err.message : 'Tool execution failed',
      };
    }

    // 4) Feed the breaker from the outcome.
    if (outcome.ok) {
      await this.breakers.recordSuccess(connectorId);
    } else if (countsTowardCircuit(outcome.error)) {
      await this.breakers.recordFailure(connectorId);
    }
    return outcome;
  }

  /** Manual execution of a tool on an installed skill (logs a SkillExecution). */
  async executeInstalledTool(
    companyId: string,
    installedSkillId: string,
    tool: string,
    args: Record<string, unknown>,
  ): Promise<ToolCallDto> {
    const installed = await this.findOwnedInstalled(companyId, installedSkillId);
    if (!installed.enabled) {
      throw new ConflictException('Skill is disabled');
    }
    if (!SkillCatalog.getTool(installed.skillKey, tool)) {
      throw new NotFoundException(`Unknown tool: ${tool}`);
    }
    return this.runTool({ companyId }, installed.skillKey, tool, args);
  }

  // --- Runtime credential resolution (for real executors) ------------------

  /**
   * Build the ExecutorContext a real/auto executor needs: look up the tenant's
   * InstalledSkill for `skillKey` and fold in its decrypted credentials, config
   * and connectionStatus. Tenant-scoped by ctx.companyId. When the skill is not
   * installed the original ctx is returned unchanged (executor falls back).
   */
  private async resolveExecutorContext(
    ctx: ExecutorContext,
    skillKey: string,
  ): Promise<ExecutorContext> {
    const installed = await this.resolveInstalledForExecution(
      ctx.companyId,
      ctx.employeeId,
      skillKey,
    );
    if (!installed) {
      return ctx;
    }
    const credentials = this.readCredentials(installed.credentials);
    // OAuth egress uses a FRESH access token: when the connector has a refresh
    // token and its cached expiry is near/passed, ConnectorTokenService renews it
    // (single-flight) and persists the new token. API-key connectors are
    // unaffected (no refresh token → the stored value is used as-is).
    if (
      installed.connectionType === 'oauth' &&
      credString(credentials, 'refreshToken', 'refresh_token')
    ) {
      try {
        const fresh = await this.tokens.getAccessToken(installed.id);
        if (fresh) {
          credentials.accessToken = fresh;
        }
      } catch (err) {
        // Refresh failed (revoked → ConnectorTokenService already flipped the
        // connector DISCONNECTED; or a provider misconfig). Leave creds as-is: the
        // executor surfaces the auth error and dependent workflows quarantine.
        this.logger.warn(
          `Token refresh failed for connector ${installed.id} (${skillKey}): ${
            err instanceof Error ? err.message : String(err)
          }`,
        );
      }
    }
    return {
      ...ctx,
      installedSkillId: installed.id,
      connectionStatus:
        installed.connectionStatus as ExecutorContext['connectionStatus'],
      config: (installed.config as Record<string, unknown> | null) ?? null,
      credentials,
    };
  }

  /**
   * Prefer the acting employee's OWN connection for this skill (e.g. its own
   * Gmail mailbox) when one exists; otherwise fall back to the company-wide
   * connection (employeeId: null) — today's exact behavior when no
   * employee-owned connection has ever been created.
   *
   * NOTE: the `employeeId: null` (company-wide) lookup below uses `findFirst`
   * with a flat filter rather than `findUnique` on the
   * `companyId_skillKey_employeeId` compound key: Prisma's generated compound-
   * unique-index type requires `employeeId: string` (it excludes `null`) even
   * though the column is nullable — a deliberate Prisma typing rule, because a
   * nullable column inside a compound unique index isn't actually enforced as
   * unique by Postgres for NULL (two NULLs are never "equal", so the DB allows
   * more than one row where employeeId IS NULL). `findFirst` on the same
   * 3-field equality still uses the same composite index and returns the exact
   * same row for every case this codebase relies on (a concrete employeeId IS
   * uniquely enforced by the DB); only the (intentionally non-unique) NULL case
   * differs, where "first" is the correct read since there is no DB-level
   * uniqueness guarantee to defer to. The narrowed non-null lookup above keeps
   * `findUnique` + the compound key since that combination compiles and is
   * genuinely unique.
   */
  private async resolveInstalledForExecution(
    companyId: string,
    employeeId: string | null | undefined,
    skillKey: string,
  ): Promise<InstalledSkill | null> {
    if (employeeId) {
      const own = await this.prisma.installedSkill.findUnique({
        where: {
          companyId_skillKey_employeeId: { companyId, skillKey, employeeId },
        },
      });
      if (own) {
        return own;
      }
    }
    return this.prisma.installedSkill.findFirst({
      where: { companyId, skillKey, employeeId: null },
    });
  }

  /**
   * Feed a tool-call outcome into ConnectorHealthService (passive health signal,
   * docs §1.8). Runs for every real egress attempt; a no-op when the skill is not
   * installed as a connector for this tenant, or the connector is not live.
   * Wrapped so a health-tracking hiccup never breaks (or fails) the tool call.
   */
  private async recordEgressHealth(
    companyId: string,
    skillKey: string,
    outcome: SkillExecutionResult,
  ): Promise<void> {
    try {
      if (outcome.ok) {
        await this.health.recordSuccess(companyId, skillKey);
      } else {
        await this.health.recordFailure(
          companyId,
          skillKey,
          outcome.error ?? 'tool call failed',
        );
      }
    } catch (err) {
      this.logger.warn(
        `Connector health tracking failed for ${skillKey}: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    }
  }

  /** Parse an OAuth `expiresAt` ISO string from creds into a Date (or null). */
  private parseExpiry(creds: Record<string, unknown>): Date | null {
    const iso = credString(creds, 'expiresAt');
    if (!iso) {
      return null;
    }
    const date = new Date(iso);
    return Number.isNaN(date.getTime()) ? null : date;
  }

  // --- Credentials at rest (encrypted) -------------------------------------

  /**
   * INTERNAL accessor for real executors: decrypt an installed skill's stored
   * credentials into the raw secrets object. Returns `{}` when none are set.
   * NEVER wired to an HTTP response — the mapper still only exposes
   * `credentialsSet`. Callers must ensure the id belongs to the acting tenant.
   */
  async getDecryptedCredentials(
    installedSkillId: string,
  ): Promise<Record<string, unknown>> {
    const row = await this.prisma.installedSkill.findUnique({
      where: { id: installedSkillId },
    });
    if (!row) {
      throw new NotFoundException('Installed skill not found');
    }
    return this.readCredentials(row.credentials);
  }

  // --- OAuth connection (used by the OAuth authorize/callback flow) ---------

  /** Fetch an owned installed skill row (OAuth authorize needs its skillKey). */
  getOwnedInstalled(companyId: string, id: string): Promise<InstalledSkill> {
    return this.findOwnedInstalled(companyId, id);
  }

  /**
   * Persist OAuth tokens (encrypted) onto an installed skill and mark it
   * CONNECTED. Called by the public OAuth callback after the code→token
   * exchange; scoped by the companyId carried in the signed state so a tenant
   * can only connect its own skill.
   */
  /**
   * §3 / §26 — run the connection state machine and report every stage.
   *
   * This is what the setup wizard calls. It is deliberately SEPARATE from
   * `connectSkill`: connect proves the credentials are usable (cheap, no side
   * effect, runs on every save), while verify additionally discovers the account
   * and can send a real test message — which the user has to ask for, because a
   * test that emails somebody is itself an outbound action.
   *
   * A skill with no adapter reports a single SKIPPED step rather than a green
   * tick, so "we cannot check this provider yet" never reads as "verified".
   */
  async verifyConnection(
    companyId: string,
    id: string,
    opts: { includeTest?: boolean; testTo?: string } = {},
  ): Promise<{
    ok: boolean;
    steps: VerifyStep[];
    account: string | null;
    code?: string;
    connectionStatus: SkillConnectionStatus;
  }> {
    const installed = await this.findOwnedInstalled(companyId, id);
    const adapter = getProviderAdapter(installed.skillKey);
    const current = installed.connectionStatus as SkillConnectionStatus;

    if (!adapter) {
      return {
        ok: false,
        steps: [
          {
            key: 'credentials',
            label: 'Sign in to the provider',
            status: 'SKIPPED',
            detail: 'Orlixa cannot verify this provider automatically yet.',
          },
        ],
        account: null,
        connectionStatus: current,
      };
    }

    const input = {
      creds: this.readCredentials(installed.credentials),
      config: ((installed.config as Record<string, unknown> | null) ?? {}),
    };
    const result = await runVerification(adapter, input, {
      includeTest: Boolean(opts.includeTest),
      testTo: opts.testTo,
    });

    // The verification IS the status. A pass promotes the connector to
    // CONNECTED and resets the health lifecycle exactly as `connect` does; a
    // failure demotes it, because a connection that cannot authenticate right
    // now must not keep telling workflows it is usable.
    const nextStatus: SkillConnectionStatus = result.ok
      ? 'CONNECTED'
      : current === 'CONNECTED'
        ? 'DEGRADED'
        : 'NOT_CONNECTED';

    const row = await this.prisma.installedSkill.update({
      where: { id },
      data: {
        connectionStatus: nextStatus,
        lastHealthCheckAt: new Date(),
        consecutiveErrors: result.ok ? 0 : { increment: 1 },
        lastHealthError: result.ok ? null : (lastFailure(result.steps) ?? null),
        ...(result.ok ? { disabledReason: null } : {}),
        ...(result.account
          ? {
              config: {
                ...input.config,
                // Non-secret, and the thing §6 assignment is reasoned about.
                connectedAccount: result.account,
              } as Prisma.InputJsonObject,
            }
          : {}),
      },
    });

    await this.auditLog.record({
      companyId,
      action: result.ok ? 'connector.verified' : 'connector.verify_failed',
      entityType: 'InstalledSkill',
      entityId: row.id,
      metadata: {
        skillKey: installed.skillKey,
        account: result.account,
        code: result.code ?? null,
        testRequested: Boolean(opts.includeTest),
        steps: result.steps.map((s) => ({ key: s.key, status: s.status })),
      },
    });

    return { ...result, connectionStatus: nextStatus };
  }

  async connectOAuth(
    companyId: string,
    installedSkillId: string,
    tokens: Record<string, unknown>,
  ): Promise<void> {
    const installed = await this.findOwnedInstalled(companyId, installedSkillId);
    const merged = {
      ...this.readCredentials(installed.credentials),
      ...tokens,
    };
    await this.prisma.installedSkill.update({
      where: { id: installedSkillId },
      data: {
        credentials: this.sealCredentials(merged),
        connectionType: this.defFor(installed.skillKey).connection.type,
        connectionStatus: 'CONNECTED',
        // Fresh OAuth connect resets the health lifecycle + caches token expiry.
        consecutiveErrors: 0,
        lastHealthError: null,
        disabledReason: null,
        tokenExpiresAt: this.parseExpiry(merged),
      },
    });
  }

  /** Decrypt/unwrap stored credentials (delegates to the shared connector util). */
  private readCredentials(
    stored: Prisma.JsonValue | null,
  ): Record<string, unknown> {
    return decryptCreds(this.crypto, stored);
  }

  /** Encrypt a raw secrets object into the `{ enc }` envelope (shared util). */
  private sealCredentials(raw: Record<string, unknown>): Prisma.InputJsonObject {
    return encryptCreds(this.crypto, raw);
  }

  // --- Config validation helpers -------------------------------------------

  /** Resolve the catalog definition for an installed skill (must exist). */
  private defFor(skillKey: string): SkillDefinition {
    const def = SkillCatalog.get(skillKey);
    if (!def) {
      throw new NotFoundException(`Unknown skill: ${skillKey}`);
    }
    return def;
  }

  /**
   * Validate each provided field against the skill's configSchema and split them
   * into non-secret `config` values and `secrets`. Unknown/invalid fields → 400.
   */
  private partitionConfig(
    def: SkillDefinition,
    input: Record<string, unknown>,
  ): { config: Record<string, unknown>; secrets: Record<string, unknown> } {
    const byKey = new Map<string, ConfigFieldDto>(
      (def.configSchema ?? []).map((f) => [f.key, f]),
    );
    const config: Record<string, unknown> = {};
    const secrets: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(input)) {
      const field = byKey.get(key);
      if (!field) {
        throw new BadRequestException(`Unknown config field: ${key}`);
      }
      this.assertFieldValue(field, value);
      if (field.secret) {
        secrets[key] = value;
      } else {
        config[key] = value;
      }
    }
    return { config, secrets };
  }

  /** Assert a single value matches its field's type / required / options. */
  private assertFieldValue(field: ConfigFieldDto, value: unknown): void {
    const empty = value === undefined || value === null || value === '';
    if (empty) {
      if (field.required) {
        throw new BadRequestException(`${field.key} is required`);
      }
      return; // clearing an optional field is allowed
    }
    switch (field.type) {
      case 'number':
        if (typeof value !== 'number' || !Number.isFinite(value)) {
          throw new BadRequestException(`${field.key} must be a number`);
        }
        break;
      case 'boolean':
        if (typeof value !== 'boolean') {
          throw new BadRequestException(`${field.key} must be a boolean`);
        }
        break;
      case 'select':
        if (
          typeof value !== 'string' ||
          !(field.options ?? []).includes(value)
        ) {
          throw new BadRequestException(
            `${field.key} must be one of: ${(field.options ?? []).join(', ')}`,
          );
        }
        break;
      case 'string':
      case 'textarea':
      default:
        if (typeof value !== 'string') {
          throw new BadRequestException(`${field.key} must be a string`);
        }
    }
  }

  // --- Ownership helpers ---------------------------------------------------

  private async findOwnedInstalled(
    companyId: string,
    id: string,
  ): Promise<InstalledSkill> {
    const row = await this.prisma.installedSkill.findFirst({
      where: { id, companyId },
    });
    if (!row) {
      throw new NotFoundException('Installed skill not found');
    }
    return row;
  }

  private async assertEmployee(
    companyId: string,
    employeeId: string,
  ): Promise<void> {
    const employee = await this.prisma.aiEmployee.findFirst({
      where: { id: employeeId, companyId },
      select: { id: true },
    });
    if (!employee) {
      throw new NotFoundException('Employee not found');
    }
  }
}
