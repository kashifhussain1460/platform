import { Injectable, Logger } from '@nestjs/common';
import type { ConditionOp } from '@vaep/types';
import { MAX_WAIT_MS } from '../../workflows.constants';
import { resolveTemplate } from '../template';
import {
  compare,
  sleep,
  type NodeExecContext,
  type NodeHandler,
  type NodeResult,
} from './node-handler';

/**
 * The dependency-free node handlers, ported verbatim from WorkflowEngine's
 * private `exec*` methods (P1-03). Grouped in one file because each is a few
 * lines and none has injected dependencies — splitting them further would add
 * files without adding clarity.
 */

/** TRIGGER: the entry node. Seeds the run's trigger payload into the output. */
@Injectable()
export class TriggerNodeHandler implements NodeHandler {
  readonly type = 'TRIGGER' as const;

  execute({ context }: NodeExecContext): NodeResult {
    return { output: { trigger: context.trigger ?? {} } };
  }
}

/** WAIT: bounded sleep (durable/resumable waits arrive with P1-05 timers). */
@Injectable()
export class WaitNodeHandler implements NodeHandler {
  readonly type = 'WAIT' as const;

  async execute({ node }: NodeExecContext): Promise<NodeResult> {
    const cfg = node.config ?? {};
    const requested = Number(cfg.durationMs);
    // MAX_WAIT_MS (10s) bounds this for BOTH execution modes. Under inline
    // execution a WAIT spends the HTTP request's own budget rather than a
    // worker's, and 10s sits comfortably inside any serverless timeout — so no
    // mode-specific cap is needed (one was tried and did nothing, being looser
    // than this). Revisit if WAIT ever becomes durable/resumable.
    const durationMs = Number.isFinite(requested)
      ? Math.min(Math.max(0, requested), MAX_WAIT_MS)
      : 0;
    if (durationMs > 0) {
      await sleep(durationMs);
    }
    return {
      output: {
        requestedMs: Number.isFinite(requested) ? requested : 0,
        waitedMs: durationMs,
        capMs: MAX_WAIT_MS,
      },
    };
  }
}

/** CONDITION: op(leftResolved, right) → boolean used to pick the branch edge. */
@Injectable()
export class ConditionNodeHandler implements NodeHandler {
  readonly type = 'CONDITION' as const;

  execute({ node, context }: NodeExecContext): NodeResult {
    const cfg = node.config ?? {};
    const left = resolveTemplate(cfg.left, context);
    const op = (typeof cfg.op === 'string' ? cfg.op : 'eq') as ConditionOp;
    const right = cfg.right == null ? '' : String(cfg.right);
    const result = compare(left, op, right);
    return { output: { left, op, right, result }, conditionResult: result };
  }
}

/**
 * APPROVAL, but only ever reached when `config.autoApprove === true`.
 *
 * A gated approval never gets here: the engine's run loop pauses the run
 * BEFORE dispatching to a handler, so this path resolves immediately with no
 * ApprovalRequest and no pause — while still leaving an auditable step in the
 * run log.
 */
@Injectable()
export class ApprovalNodeHandler implements NodeHandler {
  readonly type = 'APPROVAL' as const;

  execute({ node, context }: NodeExecContext): NodeResult {
    const cfg = node.config ?? {};
    const message = resolveTemplate(cfg.message, context);
    return { output: { approved: true, auto: true, message } };
  }
}

/**
 * NOTIFY: records a templated message in the step output (log-style).
 *
 * This does NOT send anything. A real notification is a TOOL_ACTION against
 * gmail/slack — see doc 27 §0.4, where mistaking NOTIFY for a real message is
 * called out as a recurring trap.
 */
@Injectable()
export class NotifyNodeHandler implements NodeHandler {
  readonly type = 'NOTIFY' as const;
  private readonly logger = new Logger(NotifyNodeHandler.name);

  execute({ node, context }: NodeExecContext): NodeResult {
    const cfg = node.config ?? {};
    const message = resolveTemplate(cfg.message, context);
    this.logger.log(`NOTIFY[${node.id}]: ${message}`);
    return { output: { message, notified: true } };
  }
}
