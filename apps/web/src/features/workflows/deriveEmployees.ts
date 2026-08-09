import type { AiEmployeeDto, WorkflowDefinition } from '@vaep/types';

/**
 * The signature AI-Employee-OS reading of a workflow (doc 29 §1): who the
 * workflow delegates work to, resolved to real people. Derived from the graph —
 * every node that binds an AI Employee (`AI_EMPLOYEE_STEP`, and the legacy
 * `AI_STEP`) carries the employee id under `config.employeeId`. Templates carry
 * a `{{param.*}}` placeholder there until installed; those are ignored.
 */
export interface DerivedEmployee {
  /** The bound employee id (kept even when unresolved, for keys). */
  employeeId: string;
  name: string;
  /** Employee role (e.g. 'HR', 'MARKETING'); '' when unresolved. */
  role: string;
  /** True when the id no longer resolves to a hired employee (removed). */
  unresolved: boolean;
}

/** Node types that bind a single AI Employee via `config.employeeId`. */
const EMPLOYEE_BINDING_NODE_TYPES = new Set(['AI_EMPLOYEE_STEP', 'AI_STEP']);

/** A real, resolved id — not empty and not an un-substituted `{{param.*}}`. */
function isRealEmployeeId(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && !value.includes('{{');
}

function readEmployeeId(config: unknown): unknown {
  return config && typeof config === 'object'
    ? (config as Record<string, unknown>).employeeId
    : undefined;
}

/**
 * The distinct AI Employees a workflow runs, in first-seen graph order,
 * resolved against the employee roster. An id that no longer resolves comes
 * back as `unresolved` (the employee was removed) so the row can flag it rather
 * than silently dropping a step's owner.
 */
export function deriveEmployees(
  definition: WorkflowDefinition | null | undefined,
  employeesById: Map<string, AiEmployeeDto>,
): DerivedEmployee[] {
  const seen = new Set<string>();
  const derived: DerivedEmployee[] = [];

  for (const node of definition?.nodes ?? []) {
    if (!EMPLOYEE_BINDING_NODE_TYPES.has(node.type)) continue;
    const id = readEmployeeId(node.config);
    if (!isRealEmployeeId(id) || seen.has(id)) continue;
    seen.add(id);

    const employee = employeesById.get(id);
    derived.push(
      employee
        ? { employeeId: employee.id, name: employee.name, role: employee.role, unresolved: false }
        : { employeeId: id, name: 'Removed employee', role: '', unresolved: true },
    );
  }

  return derived;
}

/**
 * True when the workflow has an AI Employee step that hasn't been assigned a
 * person yet (empty `employeeId`) — the row can nudge "needs an employee"
 * instead of showing an empty roster.
 */
export function hasUnassignedEmployeeStep(
  definition: WorkflowDefinition | null | undefined,
): boolean {
  return (definition?.nodes ?? []).some(
    (n) => n.type === 'AI_EMPLOYEE_STEP' && !isRealEmployeeId(readEmployeeId(n.config)),
  );
}
