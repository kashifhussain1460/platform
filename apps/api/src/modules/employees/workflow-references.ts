import type { PrismaService } from '../../common/prisma/prisma.service';

/**
 * Workflows whose graph names this employee (the reverse of `employeeIdsInGraph`
 * in `workflows/engine/employee-references.ts`, which goes workflow → employees).
 *
 * `Workflow` has no FK/relation to `AiEmployee` at all — an employee's
 * involvement lives only inside `definition` (JSON), so this is a substring
 * match, not a join. Confirmed by the 2026-09-09 hiring audit
 * (`docs/audit/2026-09-08-kill-critic-audit/verify-08-hiring-backend.md`).
 *
 * ## 🔴 Real bug found and fixed while extracting this
 *
 * The original (`EmployeesService.workflowsReferencing`, private, used only by
 * `dependencies()`) filtered with Prisma's `definition: { string_contains:
 * employeeId }`. That is silently a no-op: Prisma's JSON `string_contains`
 * only matches when the column's value IS a JSON *string* scalar (or you give
 * it a `path` down to one, the way `gmail-inbound.service.ts` correctly does
 * for `{ path: ['from'], string_contains }`). `Workflow.definition` is a JSON
 * *object*, with no `path` given, so every call returned `[]` — proven by
 * comparing it against a raw-SQL text-cast query against the SAME row in
 * `employee-readiness.e2e-spec.ts` (the Prisma filter found nothing; the raw
 * query found the row).
 *
 * The consequence was real, not cosmetic: `dependencies()` derives
 * `inFlightRuns` FROM this list, and that count is what
 * `EmployeesService.remove()`/hard-delete refuse on ("Cannot delete... workflow
 * run(s) that use it are still in flight"). With `referencing` always empty,
 * **that safety block could never fire** — an employee could be
 * archived/hard-deleted while a workflow that genuinely names it still had a
 * run PENDING/RUNNING/WAITING, silently orphaning it.
 *
 * Fixed with a raw query casting the JSON column to text — Postgres has no
 * built-in "does this jsonb contain this substring anywhere" operator, and a
 * cast+`LIKE` is the standard way to get one. Extracted so
 * `EmployeeReadinessService` shares the exact same (now correct) query rather
 * than a hand-copied second version that could quietly diverge.
 */
export async function workflowsReferencingEmployee(
  prisma: PrismaService,
  companyId: string,
  employeeId: string,
): Promise<string[]> {
  const rows = await prisma.$queryRaw<{ id: string }[]>`
    SELECT "id" FROM "Workflow"
     WHERE "companyId" = ${companyId}
       AND "archivedAt" IS NULL
       AND "definition"::text LIKE ${'%' + employeeId + '%'}
  `;
  return rows.map((r) => r.id);
}
