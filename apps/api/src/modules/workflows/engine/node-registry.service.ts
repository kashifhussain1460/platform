import { Inject, Injectable, Logger, type OnModuleInit } from '@nestjs/common';
import type { NodeType } from '@vaep/types';
import {
  NODE_HANDLERS,
  type NodeHandler,
} from './nodes/node-handler';

/** Thrown when a graph references a node type nothing has registered. */
export class UnknownNodeTypeError extends Error {
  constructor(type: string) {
    super(`Unknown node type: ${type}`);
    this.name = 'UnknownNodeTypeError';
  }
}

/**
 * P1-03 — the node registry (doc 26 §9).
 *
 * The engine resolves a handler here instead of branching on `node.type`.
 * That is the whole point: adding a node type becomes one new file plus one
 * entry in the providers array — no engine change, no migration, no API change.
 *
 * The invariant that keeps this true: **the engine may only read `NodeHandler`,
 * never the concrete type.** Any `if (node.type === …)` in the runtime is a
 * review rejection.
 */
@Injectable()
export class NodeRegistry implements OnModuleInit {
  private readonly logger = new Logger(NodeRegistry.name);
  private readonly byType = new Map<NodeType, NodeHandler>();

  constructor(
    @Inject(NODE_HANDLERS) private readonly handlers: NodeHandler[],
  ) {}

  onModuleInit(): void {
    for (const handler of this.handlers) {
      this.register(handler);
    }
    this.logger.log(
      `node registry ready: ${this.byType.size} types [${[...this.byType.keys()].sort().join(', ')}]`,
    );
  }

  /** Duplicate registration is a wiring bug, so it throws rather than shadows. */
  register(handler: NodeHandler): void {
    if (this.byType.has(handler.type)) {
      throw new Error(
        `Duplicate node handler registered for "${handler.type}"`,
      );
    }
    this.byType.set(handler.type, handler);
  }

  get(type: NodeType): NodeHandler {
    const handler = this.byType.get(type);
    if (!handler) {
      // A typed error so the engine can classify this as a VALIDATION_ERROR
      // (never retryable) rather than an opaque crash.
      throw new UnknownNodeTypeError(type);
    }
    return handler;
  }

  has(type: NodeType): boolean {
    return this.byType.has(type);
  }

  /** Backs `GET /workflow-nodes` — the palette is generated, never hand-listed. */
  list(): NodeType[] {
    return [...this.byType.keys()].sort();
  }
}
