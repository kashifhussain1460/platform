import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../../../../common/prisma/prisma.service';
import type { TransformOp, VariableScope, VariableType } from '@vaep/types';
import { lookup, resolveTemplate } from '../template';
import { assertWritableScope, coerceVariable } from '../variables';
import type {
  NodeExecContext,
  NodeHandler,
  NodeResult,
} from './node-handler';

/**
 * P2-02/P2-01 — data nodes.
 *
 * TRANSFORM implements a CLOSED operation set. There is no expression language
 * and no `eval`: an arbitrary-expression node would be remote code execution
 * inside a multi-tenant runtime. If authors need more, the set gets extended —
 * an evaluator is never added.
 */

/** SET_VARIABLE: store a value into a writable scope. */
@Injectable()
export class SetVariableNodeHandler implements NodeHandler {
  readonly type = 'SET_VARIABLE' as const;
  private readonly logger = new Logger(SetVariableNodeHandler.name);

  constructor(private readonly prisma: PrismaService) {}

  async execute({
    companyId,
    workflowId,
    node,
    context,
  }: NodeExecContext): Promise<NodeResult> {
    const cfg = node.config ?? {};
    const name = typeof cfg.name === 'string' ? cfg.name.trim() : '';
    if (!name) {
      throw new Error(`SET_VARIABLE node "${node.id}" has no variable name`);
    }

    const scope = (
      typeof cfg.scope === 'string' ? cfg.scope : 'RUNTIME'
    ) as VariableScope;
    // Throws for SECRET / ENVIRONMENT / INPUT / GLOBAL. A graph that could write
    // a secret would persist it into the immutable version JSON, which is
    // surfaced in run history and DLQ dumps.
    assertWritableScope(scope);

    const rawValue =
      typeof cfg.value === 'string'
        ? resolveTemplate(cfg.value, context)
        : cfg.value;
    const type = (
      typeof cfg.type === 'string' ? cfg.type : 'string'
    ) as VariableType;
    const value = coerceVariable(rawValue, type);

    // RUNTIME lives only for this run, so the context is its home. WORKFLOW and
    // OUTPUT scope outlive the run, so they are persisted — otherwise a
    // "workflow variable" would silently vanish the moment the run ended.
    let persisted = false;
    if (scope === 'WORKFLOW' || scope === 'OUTPUT') {
      await this.prisma.workflowVariable.upsert({
        where: { workflowId_scope_key: { workflowId, scope, key: name } },
        create: {
          companyId,
          workflowId,
          key: name,
          scope,
          type,
          value: value as never,
        },
        update: { value: value as never, type },
      });
      persisted = true;
      this.logger.log(
        `variable.set workflow=${workflowId} company=${companyId} scope=${scope} key=${name}`,
      );
    }

    return {
      output: { name, scope, type, value, persisted },
      // Threaded into the run context under the variable's own name, so
      // `{{name}}` works downstream via the existing resolver.
      contextValue: value,
      contextKey: name,
    };
  }
}

/** TRANSFORM: reshape a value with a fixed set of operations. */
@Injectable()
export class TransformNodeHandler implements NodeHandler {
  readonly type = 'TRANSFORM' as const;

  execute({ node, context }: NodeExecContext): NodeResult {
    const cfg = node.config ?? {};
    const inputPath = typeof cfg.input === 'string' ? cfg.input : '';
    // A `{{path}}` template resolves to a STRING; a bare path keeps the real
    // value (arrays stay arrays), which matters for map/filter/join.
    let value: unknown = inputPath.includes('{{')
      ? resolveTemplate(inputPath, context)
      : lookup(context, inputPath);

    const operations = Array.isArray(cfg.operations) ? cfg.operations : [];
    const applied: string[] = [];

    for (const raw of operations) {
      if (!raw || typeof raw !== 'object') continue;
      const step = raw as Record<string, unknown>;
      const op = step.op as TransformOp;
      value = this.apply(op, value, step, node.id);
      applied.push(op);
    }

    return { output: { applied, value }, contextValue: value };
  }

  private apply(
    op: TransformOp,
    value: unknown,
    step: Record<string, unknown>,
    nodeId: string,
  ): unknown {
    switch (op) {
      case 'jsonPath': {
        const path = typeof step.path === 'string' ? step.path : '';
        if (value == null || typeof value !== 'object') return undefined;
        return lookup(value as Record<string, unknown>, path);
      }
      case 'map': {
        const field = typeof step.field === 'string' ? step.field : '';
        this.assertArray(value, op, nodeId);
        return (value as unknown[]).map((item) =>
          item && typeof item === 'object'
            ? lookup(item as Record<string, unknown>, field)
            : item,
        );
      }
      case 'filter': {
        const field = typeof step.field === 'string' ? step.field : '';
        const equals = step.equals;
        this.assertArray(value, op, nodeId);
        return (value as unknown[]).filter((item) => {
          const actual =
            item && typeof item === 'object'
              ? lookup(item as Record<string, unknown>, field)
              : item;
          return String(actual ?? '') === String(equals ?? '');
        });
      }
      case 'join': {
        const separator =
          typeof step.separator === 'string' ? step.separator : ', ';
        this.assertArray(value, op, nodeId);
        return (value as unknown[])
          .map((v) => (v == null ? '' : String(v)))
          .join(separator);
      }
      case 'split': {
        const separator =
          typeof step.separator === 'string' ? step.separator : ',';
        return String(value ?? '')
          .split(separator)
          .map((s) => s.trim())
          .filter(Boolean);
      }
      case 'toNumber': {
        const n = Number(String(value ?? '').trim());
        if (!Number.isFinite(n)) {
          throw new Error(
            `TRANSFORM node "${nodeId}": toNumber expected a number but got ${JSON.stringify(value)}`,
          );
        }
        return n;
      }
      case 'toString':
        return value == null ? '' : String(value);
      case 'default':
        return value == null || value === '' ? step.value : value;
      default:
        // A config referencing an operation outside the closed set is a
        // misconfiguration, not something to guess at.
        throw new Error(
          `TRANSFORM node "${nodeId}": unsupported operation "${String(op)}"`,
        );
    }
  }

  private assertArray(value: unknown, op: string, nodeId: string): void {
    if (!Array.isArray(value)) {
      throw new Error(
        `TRANSFORM node "${nodeId}": ${op} expected an array but got ${typeof value}`,
      );
    }
  }
}
