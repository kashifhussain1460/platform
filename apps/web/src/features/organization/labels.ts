/** Short words that read wrong under plain Title Case ("HR" → "Hr"). */
const ACRONYMS = new Set(['HR']);

/**
 * `PROJECT_MANAGER` → `Project Manager`; `HR` stays `HR`.
 *
 * A department's `scopes` are NOT employee roles, even though the two lists
 * overlap. They are scope NAMES drawn from three different enums that happen to
 * share values — `EmployeeRole`, `WorkflowCategory` and
 * `KnowledgeDocument.category` — and the authorization policy compares them as
 * normalised strings, not as any one enum.
 *
 * So this deliberately takes a `string` rather than reusing
 * `features/employees/labels.formatRole`, which is typed to `EmployeeRole`.
 * Casting a scope to `EmployeeRole` to borrow that function would claim a type
 * the value does not have, and would quietly break the first time a scope names
 * a workflow category with no role equivalent.
 */
export function formatScope(scope: string): string {
  return scope
    .split(/[_\s-]+/)
    .filter(Boolean)
    .map((word) =>
      ACRONYMS.has(word.toUpperCase())
        ? word.toUpperCase()
        : word.charAt(0).toUpperCase() + word.slice(1).toLowerCase(),
    )
    .join(' ');
}
