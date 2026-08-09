import { BadRequestException, Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type {
  InstalledSkillDto,
  SkillCapability,
  SkillConnectionStatus,
  SkillConnectionType,
  SkillRequirementStatus,
  WorkflowDefinition,
  WorkflowSkillRequirementDto,
  WorkflowSkillRequirementsDto,
} from '@vaep/types';
import { SkillCapabilities } from './capabilities';
import { SkillCatalog } from './catalog';
import { SkillsService } from './skills.service';

/** A distinct skill dependency accumulated while scanning the graph. */
interface RawDependency {
  skillKey: string;
  tools: Set<string>;
  capabilities: Set<SkillCapability>;
  nodeIds: string[];
  employeeIds: Set<string>;
}

/**
 * Resolves a workflow's SKILL DEPENDENCIES capability-first (doc 30 §12).
 *
 * It scans the graph's TOOL_ACTION nodes (never conversational text), maps each
 * to a provider-agnostic capability, resolves the tenant's real connection for
 * that skill, and projects a per-requirement {@link SkillRequirementStatus}.
 * This is the single machine-readable source the in-chat Skill card and the
 * publish-time readiness gate both read from.
 *
 * Publish gating is intentionally scoped to real-execution modes: in
 * `SKILL_EXECUTOR=mock` every tool runs in the offline sandbox, so "connected"
 * is meaningless and blocking would be nonsensical (and would break the offline
 * e2e suite). Under `real`/`auto` — production, including the default deploy —
 * an unconnected required skill would otherwise silently fall through to the
 * mock executor, exactly the "silently continue toward executable" hazard the
 * spec forbids, so publish is blocked. The read endpoint always reports the
 * true readiness regardless of mode.
 */
@Injectable()
export class SkillRequirementsService {
  constructor(
    private readonly skills: SkillsService,
    private readonly config: ConfigService,
  ) {}

  private enforcementEnabled(): boolean {
    return (this.config.get<string>('SKILL_EXECUTOR') ?? 'mock').toLowerCase() !== 'mock';
  }

  /**
   * Machine-readable skill dependencies of a definition + a readiness roll-up.
   * `canManageConnection` reflects whether the requesting member may connect a
   * skill (OWNER/ADMIN); the card shows "Admin permission needed" when false.
   */
  async forDefinition(
    companyId: string,
    definition: WorkflowDefinition,
    opts: { canManageConnection: boolean },
  ): Promise<WorkflowSkillRequirementsDto> {
    return this.buildRequirements(companyId, this.extractDependencies(definition), opts);
  }

  /**
   * Resolve requirements for a bare list of skillKeys (no workflow needed) —
   * backs the in-chat Skill card's live-status refresh after a connect. Each
   * skill's capabilities are the full set it can satisfy.
   */
  async forSkillKeys(
    companyId: string,
    skillKeys: string[],
    opts: { canManageConnection: boolean },
  ): Promise<WorkflowSkillRequirementsDto> {
    const deps: RawDependency[] = [...new Set(skillKeys)].map((skillKey) => ({
      skillKey,
      tools: new Set(),
      capabilities: new Set(SkillCapabilities.capabilitiesFor(skillKey)),
      nodeIds: [],
      employeeIds: new Set(),
    }));
    return this.buildRequirements(companyId, deps, opts);
  }

  private async buildRequirements(
    companyId: string,
    deps: RawDependency[],
    opts: { canManageConnection: boolean },
  ): Promise<WorkflowSkillRequirementsDto> {
    const requirements: WorkflowSkillRequirementDto[] = [];
    for (const dep of deps) {
      // Resolve against the same connection execution would use: an employee-
      // owned connection only when every node for this skill pins the SAME
      // employee, otherwise the company-wide one.
      const scopedEmployeeId = dep.employeeIds.size === 1 ? [...dep.employeeIds][0] : null;
      const installed = await this.skills.findInstalledConnection(
        companyId,
        dep.skillKey,
        scopedEmployeeId,
      );
      requirements.push(this.toRequirement(dep, installed, opts.canManageConnection));
    }

    // Stable ordering: unresolved (blocking) first, then by display name.
    requirements.sort((a, b) => {
      const aBlock = this.isBlocking(a) ? 0 : 1;
      const bBlock = this.isBlocking(b) ? 0 : 1;
      return aBlock - bBlock || a.displayName.localeCompare(b.displayName);
    });

    const missingRequiredCount = requirements.filter((r) => this.isBlocking(r)).length;
    return {
      requirements,
      missingRequiredCount,
      allRequiredReady: missingRequiredCount === 0,
    };
  }

  /**
   * Throw a 400 listing the unready skills when a workflow with unresolved
   * required connections is published under a real-execution mode. No-op in
   * mock mode and when everything is READY. Draft saves never call this — a
   * draft may carry missing connections ("Configure Later").
   */
  async assertPublishable(companyId: string, definition: WorkflowDefinition): Promise<void> {
    if (!this.enforcementEnabled()) return;
    // canManageConnection is irrelevant to the gate itself; pass true.
    const { requirements, allRequiredReady } = await this.forDefinition(companyId, definition, {
      canManageConnection: true,
    });
    if (allRequiredReady) return;

    const blockers = requirements.filter((r) => this.isBlocking(r));
    const listed = blockers
      .map((r) => `${r.displayName} (${this.humanStatus(r.status)})`)
      .join(', ');
    throw new BadRequestException(
      `Cannot publish: ${blockers.length} required skill ` +
        `${blockers.length === 1 ? 'connection is' : 'connections are'} not ready — ${listed}. ` +
        'Connect the skill(s), or keep the workflow as a draft.',
    );
  }

  // --- internals ------------------------------------------------------------

  /** A dependency blocks publish when it's required and not operational. */
  private isBlocking(r: WorkflowSkillRequirementDto): boolean {
    return r.required && r.status !== 'READY';
  }

  private extractDependencies(definition: WorkflowDefinition): RawDependency[] {
    const byKey = new Map<string, RawDependency>();
    for (const node of definition.nodes) {
      // A disabled node is skipped by the engine, so it is not a runtime
      // dependency and must not block publish.
      if (node.type !== 'TOOL_ACTION' || node.disabled) continue;

      const skillKey = typeof node.config.skillKey === 'string' ? node.config.skillKey : '';
      const tool = typeof node.config.tool === 'string' ? node.config.tool : '';
      const employeeId = typeof node.config.employeeId === 'string' ? node.config.employeeId : '';
      if (!skillKey) continue; // an unresolved/placeholder node — surfaced by structural validation, not here.

      let dep = byKey.get(skillKey);
      if (!dep) {
        dep = {
          skillKey,
          tools: new Set(),
          capabilities: new Set(),
          nodeIds: [],
          employeeIds: new Set(),
        };
        byKey.set(skillKey, dep);
      }
      dep.nodeIds.push(node.id);
      if (tool) {
        dep.tools.add(tool);
        const capability = SkillCapabilities.forTool(skillKey, tool);
        if (capability) dep.capabilities.add(capability);
      }
      if (employeeId) dep.employeeIds.add(employeeId);
    }
    return [...byKey.values()];
  }

  private toRequirement(
    dep: RawDependency,
    installed: InstalledSkillDto | null,
    canManageConnection: boolean,
  ): WorkflowSkillRequirementDto {
    const known = SkillCatalog.has(dep.skillKey);
    const capabilities = [...dep.capabilities];
    const compatibleSkillKeys = [
      ...new Set(capabilities.flatMap((c) => SkillCapabilities.skillsFor(c))),
    ].filter((k) => k !== dep.skillKey);

    const requiresConnection = known && SkillCapabilities.requiresConnection(dep.skillKey);
    const connectionType: SkillConnectionType | null =
      (SkillCapabilities.connectionType(dep.skillKey) as SkillConnectionType | undefined) ?? null;

    return {
      skillKey: dep.skillKey,
      displayName: SkillCapabilities.displayName(dep.skillKey),
      provider: known ? SkillCapabilities.provider(dep.skillKey) : null,
      capabilities,
      compatibleSkillKeys,
      requiresConnection,
      required: true,
      status: this.projectStatus(dep.skillKey, known, requiresConnection, installed),
      connectionStatus: installed?.connectionStatus ?? null,
      connectionType: installed?.connectionType ?? connectionType,
      installedSkillId: installed?.id ?? null,
      credentialsSet: installed?.credentialsSet ?? false,
      nodeIds: dep.nodeIds,
      canManageConnection,
    };
  }

  /**
   * Project the tenant's real connection state onto the richer requirement
   * status. Only truthfully-determinable states are emitted here (see
   * {@link SkillRequirementStatus}); scope/health-derived states arrive with
   * the post-connect validation slice.
   */
  private projectStatus(
    skillKey: string,
    known: boolean,
    requiresConnection: boolean,
    installed: InstalledSkillDto | null,
  ): SkillRequirementStatus {
    if (!known) return 'ERROR'; // references a skill outside the catalog
    // A `none`-connection skill (http/scheduling/postiz/…) needs no auth: it is
    // operational as soon as it exists, so it never blocks.
    if (!requiresConnection) return 'READY';
    if (!installed || !installed.enabled) return 'NOT_CONNECTED';

    const status: SkillConnectionStatus = installed.connectionStatus;
    switch (status) {
      case 'CONNECTED':
        return 'READY';
      case 'DEGRADED':
        return 'DEGRADED';
      case 'DISCONNECTED':
        return 'DISCONNECTED';
      case 'NOT_CONNECTED':
      default:
        return 'NOT_CONNECTED';
    }
  }

  private humanStatus(status: SkillRequirementStatus): string {
    switch (status) {
      case 'NOT_CONNECTED':
        return 'not connected';
      case 'DEGRADED':
        return 'degraded';
      case 'DISCONNECTED':
        return 'disconnected — needs reconnecting';
      case 'ERROR':
        return 'unknown skill';
      default:
        return status.toLowerCase().replace(/_/g, ' ');
    }
  }
}
