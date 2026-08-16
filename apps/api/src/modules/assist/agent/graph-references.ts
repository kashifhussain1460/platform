import type { AssistUnresolvedNodeDto, WorkflowDefinition } from '@vaep/types';
import type { PrismaService } from '../../../common/prisma/prisma.service';
import { SkillCatalog } from '../../skills/catalog';

/**
 * Check a draft graph's references against what the tenant ACTUALLY has, and
 * report anything that doesn't resolve.
 *
 * This is the "degrade honestly" layer. Structural validity (
 * `collectDefinitionIssues`) says the graph is well-formed; this says whether it
 * can actually run *here*. A step pointing at a skill nobody connected, or an
 * employee nobody hired, is not a validation error to be rejected — it is an
 * unresolved item to be shown to the user as "needs your input", because that is
 * usually the honest state of a freshly-designed workflow.
 *
 * The alternative — silently dropping such a step, or pretending it works — is
 * how a generated workflow becomes a lie the user discovers in production.
 */
export async function resolveReferences(
  prisma: PrismaService,
  companyId: string,
  definition: WorkflowDefinition,
): Promise<AssistUnresolvedNodeDto[]> {
  const unresolved: AssistUnresolvedNodeDto[] = [];

  const needsSkills = definition.nodes.some((n) => n.type === 'TOOL_ACTION');
  const needsEmployees = definition.nodes.some(
    (n) => n.type === 'AI_EMPLOYEE_STEP',
  );

  const [installedSkillKeys, activeEmployeeIds] = await Promise.all([
    needsSkills
      ? prisma.installedSkill
          .findMany({
            where: { companyId },
            select: { skillKey: true },
            distinct: ['skillKey'],
          })
          .then((rows) => new Set(rows.map((r) => r.skillKey)))
      : Promise.resolve(new Set<string>()),
    needsEmployees
      ? prisma.aiEmployee
          .findMany({
            // ACTIVE only — a paused employee cannot run the step (G37).
            where: { companyId, status: 'ACTIVE' },
            select: { id: true },
          })
          .then((rows) => new Set(rows.map((r) => r.id)))
      : Promise.resolve(new Set<string>()),
  ]);

  for (const node of definition.nodes) {
    const label = node.name ? `"${node.name}"` : `"${node.id}"`;

    if (node.type === 'TOOL_ACTION') {
      const skillKey = str(node.config, 'skillKey');
      const tool = str(node.config, 'tool');

      if (!skillKey || !tool) {
        unresolved.push({
          nodeId: node.id,
          reason: `Step ${label} doesn't say which app and action to use yet.`,
        });
        continue;
      }
      // Check the ACTION before the connection.
      //
      // The other order hid a permanent error behind a temporary one: asked for
      // a workflow with no skills connected, the assistant wrote
      // `gmail/send_message` — a tool Gmail does not have (it has `send_email`;
      // `send_message` is Slack's) — and the only thing reported was "gmail
      // isn't connected yet". Connect Gmail, publish, run, and only then does
      // the step fail on a name that was wrong from the start. A wrong action
      // never becomes right, so it is the more useful thing to say first.
      const def = SkillCatalog.getTool(skillKey, tool);
      if (!def) {
        unresolved.push({
          nodeId: node.id,
          reason: `Step ${label} refers to "${tool}" on ${skillKey}, which isn't one of its actions.`,
        });
        continue;
      }
      if (!installedSkillKeys.has(skillKey)) {
        unresolved.push({
          nodeId: node.id,
          reason: `Step ${label} wants to use ${skillKey}, which isn't connected yet.`,
        });
        continue;
      }
      // G34: required arguments are checked here rather than discovered at run
      // time. `{{templates}}` count as filled — they resolve during the run.
      const args = (node.config.args ?? {}) as Record<string, unknown>;
      const missing = def.parameters.required.filter(
        (key) => args[key] === undefined || args[key] === '',
      );
      if (missing.length > 0) {
        unresolved.push({
          nodeId: node.id,
          reason: `Step ${label} is missing ${missing.join(', ')} for ${skillKey}/${tool}.`,
        });
      }
      continue;
    }

    if (node.type === 'AI_EMPLOYEE_STEP') {
      // An instruction that references nothing from the run gets nothing from
      // the run. Seen twice in one QA pass: a CV screening step that replied
      // "Could you please provide the candidate's CV", and a leave-conflict
      // step that replied "I do not have access to specific leave request
      // details" — and then a CONDITION branched on that answer. Surfaced as a
      // "needs your input" item rather than a rejection, because a step that
      // genuinely needs no input (drafting boilerplate) is a real design.
      const instruction = str(node.config, 'instruction');
      if (instruction && !/\{\{\s*[\w.$]+\s*\}\}/.test(instruction)) {
        unresolved.push({
          nodeId: node.id,
          reason: `Step ${label} is not given anything from the request — it will answer without the details it is being asked about.`,
        });
      }

      const employeeId = str(node.config, 'employeeId');
      if (!employeeId) {
        unresolved.push({
          nodeId: node.id,
          reason: `Step ${label} needs an AI Employee assigned to it.`,
        });
        continue;
      }
      if (!activeEmployeeIds.has(employeeId)) {
        unresolved.push({
          nodeId: node.id,
          reason: `Step ${label} points at an employee who isn't hired and active here.`,
        });
      }
    }
  }

  return unresolved;
}

function str(config: Record<string, unknown>, key: string): string {
  const v = config?.[key];
  return typeof v === 'string' ? v.trim() : '';
}
