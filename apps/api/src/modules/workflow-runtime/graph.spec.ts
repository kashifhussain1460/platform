import type { WorkflowDefinition } from '@vaep/types';
import {
  GraphRoutingError,
  branchOf,
  entryNode,
  nextRunnableNode,
  successorOf,
  type RoutingStep,
} from './graph';

const node = (id: string, type = 'NOOP') =>
  ({ id, type, config: {} }) as WorkflowDefinition['nodes'][number];

const step = (
  nodeId: string,
  status: string,
  branch: string | null = null,
  finishedAt: Date | null = new Date(),
): RoutingStep => ({ nodeId, status, branch, finishedAt, createdAt: finishedAt });

/**
 * The gap this file exists for: the durable advance worker used to pick the
 * next node with `nodes.find((n) => !doneIds.has(n.id))` — declaration order,
 * with `edges` never read. On a CONDITION that runs BOTH branches, silently.
 */
describe('durable graph traversal', () => {
  const linear: WorkflowDefinition = {
    nodes: [node('t', 'TRIGGER'), node('a'), node('b')],
    edges: [
      { from: 't', to: 'a' },
      { from: 'a', to: 'b' },
    ],
  } as WorkflowDefinition;

  const branching: WorkflowDefinition = {
    nodes: [
      node('t', 'TRIGGER'),
      node('c', 'CONDITION'),
      node('yes'),
      node('no'),
      node('end'),
    ],
    // Declared deliberately so that DECLARATION order ('yes' before 'no')
    // disagrees with the routing a false result demands.
    edges: [
      { from: 't', to: 'c' },
      { from: 'c', to: 'yes', branch: 'true' },
      { from: 'c', to: 'no', branch: 'false' },
      { from: 'yes', to: 'end' },
      { from: 'no', to: 'end' },
    ],
  } as WorkflowDefinition;

  describe('entryNode', () => {
    it('starts at the TRIGGER', () => {
      expect(entryNode(linear)?.id).toBe('t');
    });

    it('falls back to the first node when there is no TRIGGER', () => {
      const def = { nodes: [node('x'), node('y')], edges: [] } as WorkflowDefinition;
      expect(entryNode(def)?.id).toBe('x');
    });
  });

  describe('successorOf', () => {
    it('follows the only outgoing edge', () => {
      expect(successorOf(linear, 'a', null)?.id).toBe('b');
    });

    it('returns undefined at the end of the graph', () => {
      expect(successorOf(linear, 'b', null)).toBeUndefined();
    });

    it('follows the branch edge, not the first-declared one', () => {
      expect(successorOf(branching, 'c', 'false')?.id).toBe('no');
    });

    it('throws when a selected branch matches no edge', () => {
      // Silently taking outgoing[0] here would run the `true` path for a
      // `maybe` result — wrong steps, no error, nothing in the log.
      expect(() => successorOf(branching, 'c', 'maybe')).toThrow(
        GraphRoutingError,
      );
    });

    it('ignores the selector when NO edge is branch-tagged (pass-through)', () => {
      const def = {
        nodes: [node('c', 'CONDITION'), node('next')],
        edges: [{ from: 'c', to: 'next' }],
      } as WorkflowDefinition;
      expect(successorOf(def, 'c', 'true')?.id).toBe('next');
    });

    it('throws on a dangling edge rather than ending the run', () => {
      const def = {
        nodes: [node('a')],
        edges: [{ from: 'a', to: 'ghost' }],
      } as WorkflowDefinition;
      expect(() => successorOf(def, 'a', null)).toThrow(/unknown node "ghost"/);
    });
  });

  describe('nextRunnableNode', () => {
    it('starts a fresh run at the entry node', () => {
      expect(nextRunnableNode({ definition: linear, steps: [] })?.id).toBe('t');
    });

    it('advances one hop from the node that just finished', () => {
      const next = nextRunnableNode({
        definition: linear,
        steps: [step('t', 'COMPLETED')],
        fromNodeId: 't',
      });
      expect(next?.id).toBe('a');
    });

    it('reports completion at the end of the chain', () => {
      const next = nextRunnableNode({
        definition: linear,
        steps: [step('t', 'COMPLETED'), step('a', 'COMPLETED'), step('b', 'COMPLETED')],
        fromNodeId: 'b',
      });
      expect(next).toBeUndefined();
    });

    it('takes the FALSE branch and never touches the true one', () => {
      const next = nextRunnableNode({
        definition: branching,
        steps: [step('t', 'COMPLETED'), step('c', 'COMPLETED', 'false')],
        fromNodeId: 'c',
      });
      // The old declaration-order walk returned 'yes' here.
      expect(next?.id).toBe('no');
    });

    it('is idempotent for a duplicate advance — it walks PAST settled nodes', () => {
      // A redelivered advance job carries the same hint. It must land where the
      // first one did, not re-run the node.
      const steps = [
        step('t', 'COMPLETED'),
        step('c', 'COMPLETED', 'false'),
        step('no', 'COMPLETED'),
      ];
      expect(nextRunnableNode({ definition: branching, steps, fromNodeId: 'c' })?.id).toBe(
        'end',
      );
    });

    it('recovers without a hint by resuming from the latest finished step', () => {
      // The reaper path: Redis was flushed, no job payload survives.
      const steps = [
        step('t', 'COMPLETED', null, new Date(1_000)),
        step('c', 'COMPLETED', 'true', new Date(2_000)),
      ];
      expect(nextRunnableNode({ definition: branching, steps })?.id).toBe('yes');
    });

    it('returns the node itself when its step is still running', () => {
      const next = nextRunnableNode({
        definition: linear,
        steps: [step('t', 'COMPLETED'), step('a', 'WAITING')],
        fromNodeId: 'a',
      });
      // A WAITING (approval) step is re-entered, which is how a resumed run
      // picks up the approved result instead of skipping the gated work.
      expect(next?.id).toBe('a');
    });

    it('treats a SKIPPED step as settled', () => {
      const next = nextRunnableNode({
        definition: linear,
        steps: [step('t', 'COMPLETED'), step('a', 'SKIPPED')],
        fromNodeId: 'a',
      });
      expect(next?.id).toBe('b');
    });

    it('refuses to loop forever on a cyclic graph', () => {
      const cyclic = {
        nodes: [node('a'), node('b')],
        edges: [
          { from: 'a', to: 'b' },
          { from: 'b', to: 'a' },
        ],
      } as WorkflowDefinition;
      const steps = [step('a', 'COMPLETED'), step('b', 'COMPLETED')];
      expect(() =>
        nextRunnableNode({ definition: cyclic, steps, fromNodeId: 'a', maxHops: 5 }),
      ).toThrow(/exceeded 5 hops/);
    });

    it('throws when the hint names a node absent from the pinned version', () => {
      expect(() =>
        nextRunnableNode({ definition: linear, steps: [], fromNodeId: 'gone' }),
      ).toThrow(GraphRoutingError);
    });
  });

  describe('branchOf', () => {
    it('maps a boolean conditionResult onto the edge label', () => {
      expect(branchOf({ conditionResult: true })).toBe('true');
      expect(branchOf({ conditionResult: false })).toBe('false');
    });

    it('passes a named branch through', () => {
      expect(branchOf({ branch: 'refund' })).toBe('refund');
    });

    it('is null for a node that does not branch', () => {
      expect(branchOf({})).toBeNull();
    });
  });
});
