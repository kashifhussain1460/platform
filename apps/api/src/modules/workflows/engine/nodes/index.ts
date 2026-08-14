import type { Type } from '@nestjs/common';
import type { NodeHandler } from './node-handler';
import { AiStepNodeHandler } from './ai-step.handler';
import {
  SetVariableNodeHandler,
  TransformNodeHandler,
} from './data.handlers';
import {
  JoinNodeHandler,
  LoopNodeHandler,
  NoopNodeHandler,
  ParallelNodeHandler,
  SwitchNodeHandler,
  TerminateNodeHandler,
} from './logic.handlers';
import {
  MemoryReadNodeHandler,
  MemoryWriteNodeHandler,
} from './memory.handlers';
import { RetrieveNodeHandler } from './retrieve.handler';
import {
  ApprovalNodeHandler,
  ConditionNodeHandler,
  TriggerNodeHandler,
  WaitNodeHandler,
} from './simple.handlers';
// Its own file, not simple.handlers.ts: NOTIFY now injects NotificationsService,
// and that file's whole premise is handlers with no dependencies.
import { NotifyNodeHandler } from './notify.handler';
import { ToolActionNodeHandler } from './tool-action.handler';

export * from './node-handler';
export { AiStepNodeHandler } from './ai-step.handler';
export { RetrieveNodeHandler } from './retrieve.handler';
export {
  SetVariableNodeHandler,
  TransformNodeHandler,
} from './data.handlers';
export {
  JoinNodeHandler,
  LoopNodeHandler,
  NoopNodeHandler,
  ParallelNodeHandler,
  SwitchNodeHandler,
  TerminateNodeHandler,
} from './logic.handlers';
export {
  MemoryReadNodeHandler,
  MemoryWriteNodeHandler,
} from './memory.handlers';
export { ToolActionNodeHandler } from './tool-action.handler';
export {
  ApprovalNodeHandler,
  ConditionNodeHandler,
  TriggerNodeHandler,
  WaitNodeHandler,
} from './simple.handlers';
export { NotifyNodeHandler } from './notify.handler';

/**
 * THE registration point for node handlers (P1-03).
 *
 * Adding a node type is: write a handler implementing `NodeHandler`, then add
 * it to this array. `WorkflowEngine` does not change — it resolves handlers
 * from `NodeRegistry` and never branches on `node.type` (doc 26 §9).
 *
 * These 8 are the existing types, ported behaviour-for-behaviour from the
 * engine's old `switch`. The 18 NEW types in doc 17 slot in here the same way.
 */
// Typed as classes, not `Provider[]`: they are used BOTH as providers and as
// injection tokens for the NODE_HANDLERS factory below.
export const NODE_HANDLER_PROVIDERS: Type<NodeHandler>[] = [
  TriggerNodeHandler,
  RetrieveNodeHandler,
  AiStepNodeHandler,
  ToolActionNodeHandler,
  WaitNodeHandler,
  ConditionNodeHandler,
  NotifyNodeHandler,
  ApprovalNodeHandler,

  // P2-02 logic + data.
  SwitchNodeHandler,
  TerminateNodeHandler,
  NoopNodeHandler,
  SetVariableNodeHandler,
  TransformNodeHandler,
  // Registered so the registry is complete, but publish validation rejects
  // graphs containing them until the engine implements traversal (V13).
  ParallelNodeHandler,
  JoinNodeHandler,
  LoopNodeHandler,

  // P2-03 memory.
  MemoryReadNodeHandler,
  MemoryWriteNodeHandler,

  // NOTE: AI_EMPLOYEE_STEP is deliberately NOT here. It needs
  // AgentRuntimeService, and WorkflowsModule importing EmployeesModule would
  // close the Approvals→Workflows→Employees→Approvals cycle. EmployeesModule
  // provides it and registers it into the exported NodeRegistry instead.
];
