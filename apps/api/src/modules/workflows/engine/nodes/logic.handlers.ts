import { Injectable, Logger } from '@nestjs/common';
import { lookup as lookupPath, resolveTemplate } from '../template';
import type {
  NodeExecContext,
  NodeHandler,
  NodeResult,
} from './node-handler';

/**
 * P2-02 — logic nodes.
 *
 * SWITCH, TERMINATE and NOOP execute fully today. PARALLEL, JOIN and LOOP need
 * graph TRAVERSAL (lane fan-out, iteration state) which neither the legacy
 * sequential walk nor the P1 advance worker provides yet, so publish-time
 * validation rejects them (see `definition-validator.ts` V13). Their handlers
 * exist so the registry stays complete and so wiring traversal later is purely
 * additive — but they throw rather than pretend to work.
 */

/** SWITCH: pick a named case from a templated value. */
@Injectable()
export class SwitchNodeHandler implements NodeHandler {
  readonly type = 'SWITCH' as const;

  execute({ node, context }: NodeExecContext): NodeResult {
    const cfg = node.config ?? {};
    const on = resolveTemplate(cfg.on, context);
    const cases = Array.isArray(cfg.cases) ? cfg.cases : [];

    // Compared as STRINGS after explicit coercion: an author writing `1` and a
    // context value of `'1'` must match, or the behaviour is baffling.
    const matched = cases.find(
      (c): c is { value: unknown; branch: string } =>
        !!c &&
        typeof c === 'object' &&
        typeof (c as { branch?: unknown }).branch === 'string' &&
        String((c as { value?: unknown }).value ?? '') === on,
    );

    const fallback =
      typeof cfg.default === 'string' && cfg.default ? cfg.default : undefined;
    const branch = matched?.branch ?? fallback;

    if (!branch) {
      throw new Error(
        `SWITCH node "${node.id}" resolved "${on}" but no case matched and no default branch is configured`,
      );
    }
    return { output: { on, branch, matched: Boolean(matched) }, branch };
  }
}

/** TERMINATE: end the run immediately with a chosen outcome. */
@Injectable()
export class TerminateNodeHandler implements NodeHandler {
  readonly type = 'TERMINATE' as const;

  execute({ node, context }: NodeExecContext): NodeResult {
    const cfg = node.config ?? {};
    const status = cfg.status === 'FAILED' ? 'FAILED' : 'COMPLETED';
    const reason = resolveTemplate(cfg.reason, context) || undefined;
    return {
      output: { terminated: true, status, reason: reason ?? null },
      terminate: { status, reason },
    };
  }
}

/** NOOP: does nothing. A placeholder and a merge target. */
@Injectable()
export class NoopNodeHandler implements NodeHandler {
  readonly type = 'NOOP' as const;

  // Takes the context it ignores, so every handler is callable identically.
  execute(_ctx: NodeExecContext): NodeResult {
    return { output: { noop: true } };
  }
}

/**
 * PARALLEL: fan out to every outgoing edge as a lane, converging on a JOIN.
 *
 * Lanes execute SEQUENTIALLY, one to completion before the next starts. That is
 * a real limitation of the current single-threaded walk, but it is not a
 * semantic compromise: fan-out/fan-in produces the same final state either way.
 * What an author does NOT get is wall-clock speed-up or interleaving, so nothing
 * may depend on two lanes running at the same instant. Publish-time validation
 * rejects a nested PARALLEL so lane accounting stays analysable.
 */
@Injectable()
export class ParallelNodeHandler implements NodeHandler {
  readonly type = 'PARALLEL' as const;

  execute({ node }: NodeExecContext): NodeResult {
    const cfg = node.config ?? {};
    const lanes = Array.isArray(cfg.lanes)
      ? cfg.lanes.filter((l): l is string => typeof l === 'string' && !!l)
      : [];
    const joinNodeId = typeof cfg.joinNodeId === 'string' ? cfg.joinNodeId : '';
    const mode = cfg.mode === 'ANY' ? 'ANY' : 'ALL';

    if (lanes.length === 0) {
      throw new Error(`PARALLEL node "${node.id}" declares no lanes`);
    }
    if (!joinNodeId) {
      throw new Error(
        `PARALLEL node "${node.id}" has no joinNodeId — lanes would never converge`,
      );
    }

    return {
      output: { lanes, joinNodeId, mode, concurrent: false },
      fanOut: { lanes, joinNodeId, mode },
    };
  }
}

/**
 * JOIN: the convergence point for a PARALLEL.
 *
 * Under sequential lane execution the "wait" is trivially satisfied by the time
 * the engine arrives here, so this node's job is to expose the collected lane
 * outputs to downstream steps.
 */
@Injectable()
export class JoinNodeHandler implements NodeHandler {
  readonly type = 'JOIN' as const;

  execute({ node, context }: NodeExecContext): NodeResult {
    const cfg = node.config ?? {};
    const key = typeof cfg.laneOutputKey === 'string' ? cfg.laneOutputKey : '__lanes';
    const lanes = (context[key] ?? {}) as Record<string, unknown>;
    const arrived = Object.keys(lanes);

    return {
      output: { arrived: arrived.length, lanes: arrived, laneOutputs: lanes },
      contextValue: lanes,
    };
  }
}

/**
 * LOOP: run a body subgraph once per item.
 *
 * Iterations are SEQUENTIAL by design (doc 17 §7.4) — a parallel loop is
 * PARALLEL + JOIN, deliberately not folded in here. `maxIterations` is required
 * at publish time and the engine additionally enforces the run-wide step budget,
 * so a runaway loop cannot burn the queue.
 */
@Injectable()
export class LoopNodeHandler implements NodeHandler {
  readonly type = 'LOOP' as const;
  private readonly logger = new Logger(LoopNodeHandler.name);

  execute({ node, context }: NodeExecContext): NodeResult {
    const cfg = node.config ?? {};
    const overPath = typeof cfg.over === 'string' ? cfg.over : '';
    const itemVar = typeof cfg.itemVar === 'string' && cfg.itemVar ? cfg.itemVar : 'item';
    const bodyNodeId = typeof cfg.body === 'string' ? cfg.body : '';
    const requested = Number(cfg.maxIterations);
    const maxIterations =
      Number.isFinite(requested) && requested > 0 ? Math.floor(requested) : 0;

    if (!bodyNodeId) {
      throw new Error(`LOOP node "${node.id}" has no body node id`);
    }
    if (maxIterations <= 0) {
      throw new Error(
        `LOOP node "${node.id}" needs a positive maxIterations — an unbounded loop is never valid`,
      );
    }

    // A bare path keeps the real value (arrays stay arrays); a {{template}}
    // would stringify it, which is never what a loop wants.
    const raw = overPath.includes('{{')
      ? undefined
      : lookupPath(context, overPath);

    if (!Array.isArray(raw)) {
      throw new Error(
        `LOOP node "${node.id}": "${overPath}" is ${
          raw === undefined ? 'missing' : typeof raw
        }, not an array`,
      );
    }

    const items = raw.slice(0, maxIterations);
    if (raw.length > maxIterations) {
      this.logger.warn(
        `LOOP node=${node.id} truncated ${raw.length} items to maxIterations=${maxIterations}`,
      );
    }

    const doneNodeId =
      typeof cfg.done === 'string' && cfg.done ? cfg.done : undefined;

    return {
      output: {
        itemCount: items.length,
        totalAvailable: raw.length,
        truncated: raw.length > maxIterations,
        itemVar,
      },
      iterate: { items, itemVar, bodyNodeId, maxIterations, doneNodeId },
    };
  }
}
