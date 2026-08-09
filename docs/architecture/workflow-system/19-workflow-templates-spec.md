# 19 — Workflow Templates Specification (L2)

> **Level:** L2.
> **Extends:** the `WorkflowTemplate` model (`12-database.md`), its routes (`13-api.md`), and the
> marketplace concept referenced in `01`, `03`, `15`. Those establish that templates exist; **no L1
> document specifies how installing one actually works.** That is this document.
> **Depends on:** `00 §0.7.1` (`WorkflowCategory`), doc 01 (versioning), doc 06 (variables).

---

## 1. Purpose

Specify template authoring, parameterisation, installation, and upgrade — the mechanics that turn a
catalog entry into a working, tenant-owned workflow.

## 2. Scope · 3. Responsibilities

Template shape, parameter binding, the install transaction, provenance, and upgrade policy.

## 4. Non-responsibilities

Not the marketplace UI, not billing/commission, not the workflow engine.

---

## 6. Runtime behaviour

### 6.1 [AMBIGUITY T1] Copy or reference?

L1 never decides whether an installed template stays linked to its source.

**Resolution: install performs a deep COPY into the tenant, with provenance recorded but no live link.**
A reference model means a template author can change a customer's running automation — unacceptable in
a multi-tenant product where the author may be a third party. Provenance
(`sourceTemplateId`, `sourceTemplateVersion`) is stored so upgrades can be *offered*, never applied.

```prisma
// Fields on Workflow — additive.
sourceTemplateId      String?
sourceTemplateVersion Int?
```

### 6.2 Install flow

```
POST /workflow-templates/:id/install { name?, parameters }
  1. Load template + its pinned definition
  2. Validate every REQUIRED parameter is supplied and type-correct
  3. Resolve placeholders → concrete config
  4. Verify tenant prerequisites (skills installed, employees exist, plan allows)
  5. In ONE transaction: create Workflow (status DRAFT) + WorkflowVersion v1 (PUBLISHED)
     + WorkflowVariable rows + audit row
  6. Return the new workflow — never auto-ACTIVATE
```

Step 6 is deliberate: activating on install would start firing triggers against a tenant that has not
reviewed the graph. Installed templates land as `DRAFT`.

Step 4 is what prevents the common failure — a template referencing `stripe` installing cleanly into a
tenant with no Stripe connector, then failing at 3am on first run. Missing prerequisites return `422`
with the exact list.

### 6.3 Parameterisation

```ts
export interface TemplateParameter {
  key: string;
  label: string;
  type: VariableType;              // 00 §0.7.1
  required: boolean;
  default?: unknown;
  /** Bind to a tenant resource rather than a literal. */
  binds?: 'skill' | 'employee' | 'knowledgeCategory' | 'channel';
  help?: string;
}
```

Placeholders in the template definition use the existing `{{param.<key>}}` syntax — the same resolver
as doc 06, not a second templating system.

`binds` is the important field: a template does not hardcode an employee id (meaningless across
tenants); it declares "I need an HR employee" and install resolves it.

## 7. State transitions

Template: `DRAFT → PUBLISHED → DEPRECATED → ARCHIVED` (mirrors `WorkflowVersionStatus`, §0.7.1).
Installed workflows are unaffected by later template transitions — that is the point of §6.1.

## 8–9. Contracts

```ts
export interface WorkflowTemplateManifest {
  key: string;                       // stable, e.g. 'hr.cv-screening'
  version: number;
  name: string;
  description: string;
  category: WorkflowCategory;        // 00 §0.7.1
  parameters: TemplateParameter[];
  requires: {
    skills: string[];                // skillKeys that must be installed
    employeeRoles: EmployeeRole[];
    minPlan?: Plan;
  };
  definition: WorkflowDefinition;    // doc 14 contract, with {{param.*}} placeholders
}
```

## 10. Validation

At **publish** of a template: definition passes normal graph validation with parameters substituted by
their declared types; every `{{param.x}}` referenced is declared; every declared parameter is used;
`requires.skills` all exist in `SkillCatalog`.

At **install**: required parameters present and type-correct; prerequisites satisfied; name unique per
tenant.

## 11–14. Errors · Retry · Idempotency · Concurrency

Install is a single transaction — it either produces a complete workflow or nothing. Idempotency:
`POST …/install` accepts `Idempotency-Key`; a repeat returns the original workflow rather than a
duplicate. Without this, a double-click creates two workflows and the tenant activates the wrong one.

## 15–18. DB · API · Events · Queues

Routes exist in doc 13 (`GET /workflow-templates`, `DELETE /workflow-templates/:id`); this spec adds
`POST /workflow-templates/:id/install` and `GET /workflow-templates/:id/parameters`. No queue use —
install is synchronous and fast.

## 19–22. Security · Tenancy · Permissions · Audit

First-party templates are code-defined (like `SkillCatalog`) and trusted. **Third-party templates are
untrusted input**: their definitions must pass the same publish validation as a user-authored graph,
and may not contain `DB_QUERY` or inline credentials. Install requires `OWNER`/`ADMIN`. Every install
writes an audit row with template key + version.

## 23–24. Observability · Performance

Metrics: installs per template, install failures by reason (missing prerequisite is the one to watch).
Install p95 < 1s.

## 25–26. Edge cases

| Case | Behaviour |
|---|---|
| Template updated after install | Installed copy unchanged; upgrade **offered** |
| Required skill not installed | `422` listing exactly what is missing |
| Parameter type mismatch | `422`, per-parameter errors |
| Same template installed twice | Allowed; names disambiguated |
| Template references a deprecated node type | Publish-time rejection |

## 27–28. Testing · Acceptance

1. Install with all parameters ⇒ `DRAFT` workflow + v1 `PUBLISHED` version.
2. Missing prerequisite ⇒ `422` naming it; nothing persisted.
3. Duplicate `Idempotency-Key` ⇒ one workflow.
4. Template change after install ⇒ installed workflow byte-identical.
5. Third-party template containing `DB_QUERY` ⇒ rejected at publish.

## 29–30. Notes · Definition of Done

Seed the catalog from the workflows already running on the live tenant — they are proven, and reverse-
engineering them into templates validates the parameter model against reality rather than a guess.

- [ ] Manifest type + validator shipped
- [ ] Install is transactional, idempotent, and lands `DRAFT`
- [ ] Prerequisite check returns actionable errors
- [ ] Provenance fields recorded; no live link
- [ ] Third-party validation path enforced
- [ ] Acceptance tests green

---

**Next:** `23-implementation-roadmap.md`.
