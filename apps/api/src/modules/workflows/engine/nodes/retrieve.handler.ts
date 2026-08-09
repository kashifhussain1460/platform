import { Injectable } from '@nestjs/common';
import { KnowledgeService } from '../../../knowledge/knowledge.service';
import { resolveTemplate } from '../template';
import type {
  NodeExecContext,
  NodeHandler,
  NodeResult,
} from './node-handler';

/**
 * RETRIEVE: knowledge search of a templated query → context[outputKey].
 *
 * Ported verbatim from WorkflowEngine.execRetrieve (P1-03). Note it is
 * deliberately UNSCOPED by employee role — the workflow RETRIEVE node searches
 * the whole company knowledge base, unlike chat retrieval which is role-scoped.
 */
@Injectable()
export class RetrieveNodeHandler implements NodeHandler {
  readonly type = 'RETRIEVE' as const;

  constructor(private readonly knowledge: KnowledgeService) {}

  async execute({
    companyId,
    node,
    context,
  }: NodeExecContext): Promise<NodeResult> {
    const cfg = node.config ?? {};
    const query = resolveTemplate(cfg.query, context).trim();
    const rawK = Number(cfg.k);
    const k = Number.isFinite(rawK) && rawK > 0 ? Math.min(rawK, 50) : 5;
    const results = query
      ? await this.knowledge.retrieve(companyId, query, k)
      : [];
    return {
      output: { query, k, count: results.length, results },
      contextValue: results,
    };
  }
}
