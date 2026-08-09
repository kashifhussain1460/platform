import { Inject, Injectable } from '@nestjs/common';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import type {
  GenerateWorkflowResultDto,
  UnresolvedWorkflowNodeDto,
  WorkflowDefinition,
} from '@vaep/types';
import { extractJson } from '../../../common/json/extract-json';
import { PrismaService } from '../../../common/prisma/prisma.service';
import {
  LLM_PROVIDER_TOKEN,
  type LlmMessage,
  type LlmProvider,
} from '../../employees/llm/llm.provider';
import { SkillCatalog } from '../../skills/catalog';
import { SkillsService } from '../../skills/skills.service';
import { UsageService } from '../../usage/usage.service';
import { WorkflowDefinitionDto } from '../dto/workflow-definition.dto';
import {
  EMPLOYEES_CLOSE,
  EMPLOYEES_OPEN,
  GENERATION_MAX_ATTEMPTS,
  GENERATION_MAX_QUESTION_ROUNDS,
  INSTALLED_SKILLS_CLOSE,
  INSTALLED_SKILLS_OPEN,
  WORKFLOW_GENERATOR_MARKER,
} from '../workflows.constants';
import { validateDefinitionStructure } from './definition-validator';

interface GroundingSkill {
  skillKey: string;
  tools: string[];
}
interface GroundingEmployee {
  id: string;
  name: string;
  role: string;
}
type ParsedResponse =
  | { type: 'question'; message: string }
  | { type: 'draft'; definition: WorkflowDefinition }
  | null;
type DraftCheck =
  | { ok: true }
  | { ok: false; structural: true; reason: string }
  | { ok: false; structural: false; problems: UnresolvedWorkflowNodeDto[] };

/**
 * AI-assisted workflow drafting (docs/specs/2026-07-13-ai-workflow-generator-
 * design.md). Pure/side-effect-free w.r.t. the database — it never creates a
 * Workflow row; the caller (WorkflowsController) hands the returned definition
 * to the EXISTING `POST /workflows` create path once the user accepts it.
 *
 * Grounds every draft in the company's REAL installed skills + hired
 * employees, validates every reference before returning anything, gives the
 * model exactly one chance to self-correct a bad reference, and — if it's
 * still wrong — degrades just that one node to an empty "unconfigured"
 * placeholder rather than failing the whole request. Never throws for a bad
 * LLM output; always returns a usable result.
 */
@Injectable()
export class WorkflowGeneratorService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly skills: SkillsService,
    @Inject(LLM_PROVIDER_TOKEN) private readonly llm: LlmProvider,
    private readonly usage: UsageService,
  ) {}

  async generate(
    companyId: string,
    messages: LlmMessage[],
  ): Promise<GenerateWorkflowResultDto> {
    const userTurns = messages.filter((m) => m.role === 'user').length;
    const mustDraftNow = userTurns >= GENERATION_MAX_QUESTION_ROUNDS;

    const [installed, employees] = await Promise.all([
      this.skills.listInstalled(companyId),
      this.prisma.aiEmployee.findMany({
        where: { companyId },
        select: { id: true, name: true, role: true },
      }),
    ]);
    const groundingSkills: GroundingSkill[] = installed
      .map((s) => {
        const def = SkillCatalog.get(s.skillKey);
        return def ? { skillKey: s.skillKey, tools: def.tools.map((t) => t.name) } : null;
      })
      .filter((s): s is GroundingSkill => s !== null);

    let correction: string | undefined;
    for (let attempt = 1; attempt <= GENERATION_MAX_ATTEMPTS; attempt++) {
      const system = this.buildSystemPrompt(groundingSkills, employees, correction, mustDraftNow);
      const result = await this.llm.complete({ system, messages });
      if (result.usage) {
        await this.usage.record({
          companyId,
          source: 'workflow_generator',
          promptTokens: result.usage.promptTokens,
          completionTokens: result.usage.completionTokens,
        });
      }
      const parsed = this.parseResponse(result.content);
      const isLastAttempt = attempt === GENERATION_MAX_ATTEMPTS;

      if (!parsed) {
        if (!isLastAttempt) {
          correction = 'your reply was not valid JSON matching the required shape.';
          continue;
        }
        if (mustDraftNow) {
          return this.fallbackDraftResult();
        }
        return {
          type: 'question',
          message:
            "I couldn't build that — could you describe the workflow again, naming the specific steps you need?",
        };
      }
      if (parsed.type === 'question') {
        // Server-side guarantee of the design spec's 3-round question cap
        // (docs/specs/2026-07-13-ai-workflow-generator-design.md, "User flow"
        // point 3): the model MUST NOT be trusted to obey the prompt
        // instruction alone. Once the cap is reached, a question is never
        // returned to the caller — don't waste a retry on it either, just
        // hand back a minimal usable draft immediately.
        if (mustDraftNow) {
          return this.fallbackDraftResult();
        }
        return parsed;
      }

      const check = await this.checkDraft(parsed.definition, groundingSkills, employees);
      if (check.ok) {
        return { type: 'draft', definition: parsed.definition, unresolvedNodes: [] };
      }
      if (check.structural) {
        if (!isLastAttempt) {
          correction = check.reason;
          continue;
        }
        if (mustDraftNow) {
          return this.fallbackDraftResult();
        }
        return {
          type: 'question',
          message:
            "I couldn't build a valid workflow from that — could you describe it again, one step at a time?",
        };
      }
      if (!isLastAttempt) {
        correction = check.problems.map((p) => p.reason).join(' ');
        continue;
      }
      return {
        type: 'draft',
        definition: this.degradeToPlaceholders(parsed.definition, check.problems),
        unresolvedNodes: check.problems,
      };
    }
    /* istanbul ignore next -- the loop above always returns by the final attempt */
    throw new Error('Workflow generation did not terminate');
  }

  private buildSystemPrompt(
    skills: GroundingSkill[],
    employees: GroundingEmployee[],
    correction?: string,
    mustDraftNow?: boolean,
  ): string {
    const lines = [
      WORKFLOW_GENERATOR_MARKER,
      'You help build an automation workflow for an AI-workforce platform.',
      'Reply with ONLY one JSON object, no other text, matching exactly one of these two shapes:',
      '  {"type":"question","message":"<one clarifying question>"}',
      '  {"type":"draft","definition":{"nodes":[...],"edges":[...]}}',
      'Node "type" must be one of: TRIGGER, RETRIEVE, AI_STEP, TOOL_ACTION, WAIT, CONDITION, NOTIFY, APPROVAL.',
      'A TOOL_ACTION node\'s config must be {"skillKey":"...","tool":"...","args":{}} using ONLY a skillKey+tool pair from the installed skills list below — never invent one.',
      'An AI_STEP node\'s config may include an "employeeId" from the hired employees list below — pick the employee whose ROLE fits the task (e.g. screening/scoring CVs is a RECRUITER, not HR); omit it if none fits rather than using the wrong role.',
      'A node whose result a later node uses (AI_STEP, RETRIEVE) MUST set an "outputKey" in its config, e.g. "outputKey":"decision", and later nodes reference it as {{decision}} — never {{node_id}} (a node-id reference resolves to blank).',
      'Every node needs a unique "id"; edges are {"from":"<id>","to":"<id>"}. Start with one TRIGGER node with no incoming edge.',
      'The engine supports real branching: a CONDITION node\'s config is {"left":"<template>","op":"eq"|"neq"|"contains"|"gt"|"lt","right":"<literal>"}, and its TWO outgoing edges must each carry a "branch":"true" or "branch":"false" tag so the run takes the matching path — e.g. {"from":"gate","to":"schedule","branch":"true"} and {"from":"gate","to":"decline","branch":"false"}. Use this whenever the user describes an if/then/otherwise, a qualification gate, or any "do X only when Y" requirement — do not fake it with two unconditional linear paths.',
      `${INSTALLED_SKILLS_OPEN}${JSON.stringify(skills)}${INSTALLED_SKILLS_CLOSE}`,
      `${EMPLOYEES_OPEN}${JSON.stringify(employees)}${EMPLOYEES_CLOSE}`,
    ];
    if (correction) {
      lines.push(
        `Your previous reply had a problem: ${correction} Fix it and reply again with the same JSON contract.`,
      );
    }
    if (mustDraftNow) {
      lines.push(
        `The user has already replied ${GENERATION_MAX_QUESTION_ROUNDS} times — you MUST return {"type":"draft",...} now, never another {"type":"question",...}. For anything still unclear, make a reasonable assumption and proceed; do not ask for it.`,
      );
    }
    return lines.join('\n');
  }

  /**
   * Minimal, always-usable draft returned once the question-round cap is
   * reached and the model still tried to ask a question. Guarantees the user
   * reaches something within GENERATION_MAX_QUESTION_ROUNDS turns regardless
   * of whether the model actually obeys the "must draft now" instruction.
   */
  private fallbackDraftResult(): GenerateWorkflowResultDto {
    return {
      type: 'draft',
      definition: {
        nodes: [
          { id: 'trigger', type: 'TRIGGER', config: {} },
          { id: 'notify', type: 'NOTIFY', config: { message: 'Configure this workflow further.' } },
        ],
        edges: [{ from: 'trigger', to: 'notify' }],
      },
      unresolvedNodes: [
        {
          nodeId: 'notify',
          reason:
            "AI needed more detail than you provided — this is a starting skeleton; add the steps you need.",
        },
      ],
    };
  }

  private parseResponse(content: string | undefined): ParsedResponse {
    // Tolerant extraction (G35): a model that wraps its JSON in a ```json fence
    // or adds a sentence of preamble used to fail a strict whole-string
    // JSON.parse and burn the single retry on a reply that was actually fine.
    const parsed = extractJson<{
      type?: string;
      message?: string;
      definition?: WorkflowDefinition;
    }>(content);
    if (!parsed) return null;
    if (parsed.type === 'question' && typeof parsed.message === 'string') {
      return { type: 'question', message: parsed.message };
    }
    if (parsed.type === 'draft' && parsed.definition) {
      return { type: 'draft', definition: parsed.definition };
    }
    return null;
  }

  private async checkDraft(
    definition: WorkflowDefinition,
    skills: GroundingSkill[],
    employees: GroundingEmployee[],
  ): Promise<DraftCheck> {
    // class-validator catches shape problems raw JSON.parse can't (e.g. a node
    // "type" outside NODE_TYPES); validateDefinitionStructure then catches
    // graph-level problems (duplicate ids, edges to nowhere) it doesn't.
    const dto = plainToInstance(WorkflowDefinitionDto, definition);
    const classErrors = await validate(dto);
    if (classErrors.length > 0) {
      return {
        ok: false,
        structural: true,
        reason: 'The definition did not match the required node/edge shape.',
      };
    }
    try {
      validateDefinitionStructure(definition);
    } catch (err) {
      return {
        ok: false,
        structural: true,
        reason: err instanceof Error ? err.message : 'Invalid graph structure.',
      };
    }

    const skillMap = new Map(skills.map((s) => [s.skillKey, s.tools]));
    const employeeIds = new Set(employees.map((e) => e.id));
    const problems: UnresolvedWorkflowNodeDto[] = [];
    for (const node of definition.nodes) {
      if (node.type === 'TOOL_ACTION') {
        const skillKey = typeof node.config.skillKey === 'string' ? node.config.skillKey : '';
        const tool = typeof node.config.tool === 'string' ? node.config.tool : '';
        const tools = skillMap.get(skillKey);
        if (!tools || !tools.includes(tool)) {
          problems.push({
            nodeId: node.id,
            reason: `Step "${node.id}" referenced ${skillKey || '(none)'}/${tool || '(none)'}, which isn't an installed skill+tool for this company.`,
          });
        }
      }
      if (node.type === 'AI_STEP') {
        const employeeId =
          typeof node.config.employeeId === 'string' ? node.config.employeeId : '';
        // Safe to silently drop: AI_STEP already runs fine with no employeeId
        // (WorkflowEngine.execAiStep falls back to a generic persona), so an
        // unrecognized employee reference never needs to block the draft or
        // appear in unresolvedNodes.
        if (employeeId && !employeeIds.has(employeeId)) {
          node.config = { ...node.config, employeeId: '' };
        }
      }
    }
    return problems.length === 0 ? { ok: true } : { ok: false, structural: false, problems };
  }

  private degradeToPlaceholders(
    definition: WorkflowDefinition,
    problems: UnresolvedWorkflowNodeDto[],
  ): WorkflowDefinition {
    const badIds = new Set(problems.map((p) => p.nodeId));
    for (const node of definition.nodes) {
      if (badIds.has(node.id) && node.type === 'TOOL_ACTION') {
        node.config = { ...node.config, skillKey: '', tool: '' };
      }
    }
    return definition;
  }
}
