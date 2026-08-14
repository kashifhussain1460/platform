import { Inject, Injectable } from '@nestjs/common';
import { PrismaService } from '../../../../common/prisma/prisma.service';
import {
  LLM_PROVIDER_TOKEN,
  type LlmProvider,
} from '../../../employees/llm/llm.provider';
import {
  UsageService,
  startOfCurrentMonthUtc,
} from '../../../usage/usage.service';
import { resolveTemplate } from '../template';
import type {
  NodeExecContext,
  NodeHandler,
  NodeResult,
} from './node-handler';

/**
 * AI_STEP: LLM completion of a templated prompt → context[outputKey].
 *
 * Ported verbatim from WorkflowEngine.execAiStep (P1-03), including the monthly
 * budget check — an AI_STEP scoped to an employee must respect that employee's
 * `budgetLimit` exactly as the chat runtime does, or a workflow becomes a way
 * to spend past a limit the customer set.
 */
@Injectable()
export class AiStepNodeHandler implements NodeHandler {
  readonly type = 'AI_STEP' as const;

  constructor(
    private readonly prisma: PrismaService,
    @Inject(LLM_PROVIDER_TOKEN) private readonly llm: LlmProvider,
    private readonly usage: UsageService,
  ) {}

  async execute({
    companyId,
    node,
    context,
    signal,
  }: NodeExecContext): Promise<NodeResult> {
    const cfg = node.config ?? {};
    const prompt = resolveTemplate(cfg.prompt, context);
    const employeeId =
      typeof cfg.employeeId === 'string' ? cfg.employeeId.trim() : '';

    let persona = '';
    let name = 'the workflow assistant';
    if (employeeId) {
      const employee = await this.prisma.aiEmployee.findFirst({
        where: { id: employeeId, companyId },
      });
      if (employee) {
        persona = employee.persona ?? '';
        name = employee.name;
        // Same monthly budget enforcement as chat (agent-runtime.service.ts).
        if (employee.budgetLimit != null) {
          const spent = await this.usage.totalCostForEmployee(
            companyId,
            employeeId,
            startOfCurrentMonthUtc(),
          );
          if (spent >= employee.budgetLimit) {
            throw new Error(
              `${employee.name} has reached its monthly budget limit`,
            );
          }
        }
      }
    }

    const systemLines = [
      `You are ${name}, executing a step in an automated workflow.`,
    ];
    if (persona) {
      systemLines.push(`Persona and guidelines: ${persona}`);
    }
    systemLines.push(
      'Follow the instruction below and respond with a concise, useful result.',
    );

    // Reuse the shared LlmProvider singleton (no tools → plain completion).
    // `signal` is the node's timeout: when the step's budget expires the model
    // request is cancelled, rather than left running to spend tokens on an
    // answer this step has already stopped waiting for.
    const result = await this.llm.complete({
      system: systemLines.join('\n'),
      messages: [{ role: 'user', content: prompt || 'Proceed.' }],
      temperature: 0.2,
      ...(signal ? { signal } : {}),
    });
    if (result.usage) {
      await this.usage.record({
        companyId,
        employeeId: employeeId || null,
        source: 'workflow_ai_step',
        promptTokens: result.usage.promptTokens,
        completionTokens: result.usage.completionTokens,
      });
    }
    const text = (result.content ?? '').trim();
    return { output: { prompt, text }, contextValue: text };
  }
}
