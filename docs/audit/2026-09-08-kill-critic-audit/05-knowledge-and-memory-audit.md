# Cluster 5 — Knowledge (RAG) + Memory Audit

Source: direct code read, this pass, 2026-09-09. Evidence hierarchy: executable code > tests > docs. All paths relative to `d:/Vertical AI/platform` unless noted. CLAUDE.md's Knowledge/RAG claims were treated as hypotheses, not fact — one of them (§F below) turned out stale.

---

## A. Full chain trace: Upload → Storage → Index → Retrieval → Scope → Runtime → Workflow

| Stage | File:line | Verdict | Evidence |
|---|---|---|---|
| Upload | `knowledge.service.ts:57-99` | FULLY IMPLEMENTED | `POST /knowledge/documents` (`knowledge.controller.ts:44-52`) buffers via Multer, writes bytes through the configured `StorageProvider`, creates a `PENDING` row, enqueues `INGEST_JOB`, audit-logs `knowledge.uploaded`. |
| Storage | `knowledge/storage/{local,s3}-storage.provider.ts`, factory `knowledge.module.ts:55-62` | FULLY IMPLEMENTED (both backends real) | `STORAGE_PROVIDER=local` (default) writes under `STORAGE_DIR`; `=s3` constructs a real MinIO/S3 client. Selection is a plain `useFactory` on `ConfigService`, not a stub swap. |
| Indexing | `knowledge/ingestion/ingestion.processor.ts:44-109` | FULLY IMPLEMENTED | Real BullMQ worker: `PROCESSING` → `extractText` (txt/md verbatim, PDF via lazy `pdf-parse`, DOCX via lazy `mammoth` — `knowledge.util.ts:43-70`) → `chunkText` (1000 char / 150 overlap, `knowledge.util.ts:16-33`) → batched `embed()` (16/batch) → raw-SQL insert with `::vector` cast (Prisma can't write `Unsupported("vector")`) → `READY` with `chunkCount`. Any exception flips the doc `FAILED` with the message and rethrows to the DLQ (`toQueueError`). |
| Retrieval (search) | `knowledge.service.ts:226-257` | FULLY IMPLEMENTED | Embeds the query, tenant-scoped (`companyId`) raw-SQL cosine search (`embedding <=> literal`), optional `category` filter (`OR category IS NULL`) or `sharedOnly` (`AND category IS NULL`). |
| Employee-scope (chat) | `runtime/retrieval.service.ts:24-45` | FULLY IMPLEMENTED | `AgentRuntimeService.completeTurn` (`agent-runtime.service.ts:310-319`) calls this on every turn with `employee.role` as `category` and `employee.knowledgeAccess`/`permissions` gating (`employee-permission-policy.ts:162-168`, ANDs the enum with the `accessKnowledge` flag — real enforcement, not decorative: see §16 of CLAUDE.md's own note that these flags used to be pure decoration for tools; the knowledge flag was wired from day one here). |
| AI Runtime injection | `agent-runtime.service.ts:798-866` | FULLY IMPLEMENTED | `buildSystemPrompt` injects retrieved `sources` (delimited, numbered for citation) AND `memory.memories` (§E) into the same system prompt. Both are real inputs to the completion, not decorative. |
| Workflow RETRIEVE node | `workflows/engine/nodes/retrieve.handler.ts:1-161` | FULLY IMPLEMENTED, role-scoped (see §F — contradicts platform CLAUDE.md) | Resolves scope most-specific-first: node's `employeeId` → that employee's role + `knowledgeAccess`/permission gate; else workflow's `category` mapped through `CATEGORY_TO_ROLE` (`:57-66`); else company-wide with `scope:null` recorded in the run output. An unresolvable `employeeId` **denies**, never widens (`:146-148`). 7 unit tests (`retrieve.handler.spec.ts`) pin every branch. |
| Retention | `retention/data-retention.service.ts:111-115,294-298` | FULLY IMPLEMENTED | Retention sweep deletes `KnowledgeDocument` rows AND their storage blobs together ("a row and its bytes go together" — rule 3), closing what would otherwise be a fake-erasure gap. |

**Net verdict for the chain as a whole: FULLY IMPLEMENTED, PRODUCTION READY as an architecture** — every stage has a real implementation with no mocked link, provided the operator picks a semantically real `EMBEDDINGS_PROVIDER` (see §B, this is not true of the default).

---

## B. Is `EMBEDDINGS_PROVIDER=hash` (the default) real or a mock?

Read in full: `apps/api/src/modules/knowledge/embeddings/hash-embedding.provider.ts:1-45`.

**Verdict: neither "real semantic embedding" nor "meaningless noise" — it is a genuine, deterministic *lexical* (bag-of-words hashing-trick) embedding with zero semantic generalization.** Classify as **PARTIALLY IMPLEMENTED** for the purpose "Knowledge search returns semantically relevant results."

Mechanism (`:19-34`): lower-cases + tokenizes on `[a-z0-9]+`, hashes each token (FNV-1a) into one of 384 signed buckets, sums, L2-normalizes. This is the same "hashing trick" used by classic bag-of-words/Vowpal-Wabbit style models — it is **not random**: two texts sharing literal tokens land in the same buckets and score high cosine similarity, so exact/overlapping-keyword search genuinely works and is deterministic (comment at `:8-9` is accurate: "good enough for local dev + e2e").

What it **cannot** do, by construction: any synonym, paraphrase, or semantic generalization. "car" vs "automobile", "terminate an employee" vs "fire someone", or a question phrased differently from the source document's wording will NOT match, because there is no learned token relationship — only literal string-hash collision. A real transformer/OpenAI embedding would catch all of these; `hash` catches none of them.

**Production-readiness consequence:** `EMBEDDINGS_PROVIDER=hash` is the **documented default** (`platform/CLAUDE.md`'s "Provider knobs" section, `knowledge.module.ts:36,42-44`). A company that never sets `EMBEDDINGS_PROVIDER=local|openai` gets Knowledge/RAG search that only surfaces a document when the user's query happens to share literal vocabulary with it. This is materially different from "semantic search" as sold — it is closer to a crude keyword search with a vector-shaped API. **Knowledge/RAG is NOT production-ready by default; it becomes production-ready only once `local` or `openai` is explicitly configured.** `local` (`local-embedding.provider.ts:1-43`, all-MiniLM-L6-v2 via lazily-imported `@xenova/transformers`) and `openai` (`openai-embedding.provider.ts:1-55`, `text-embedding-3-small` truncated to 384 dims) are both real, non-mock implementations — the gap is purely the *default*, not the alternatives.

Minor separate note: `openai-embedding.provider.ts:32` hardcodes `model: 'text-embedding-3-small'` inline rather than reading a config knob — inconsistent with the platform's own stated LLM convention ("Never hardcode a model in calling code" — CLAUDE.md, Provider knobs) though a model swap here is a code change, not a runtime deprecation risk on the same scale as the chat LLM.

---

## C. Unused knowledge — differentiated

| Scenario | Classification | Evidence |
|---|---|---|
| Uploaded doc, category = a role no `AiEmployee` at the company holds | **UNUSED — no consumer (by design, not a bug)** | `KnowledgeDocument.category` is a bare nullable `EmployeeRole` string with no FK/existence check against `AiEmployee.role` (`schema.prisma` Knowledge/RAG section, `knowledge.service.ts` has no such check anywhere). A document tagged `ACCOUNTANT` at a company with no Accountant employee is invisible to every chat/RETRIEVE path (both scope by the acting employee's actual `role`) and visible only on the global `/knowledge` admin page. Structural risk, not proven against live data (no DB access this pass) — the code permits it, retention/cleanup does not detect it. |
| Global `/knowledge` page manual search | **UNUSED-SCOPE-BYPASS by design, not a defect** | `SearchPanel.tsx:21-23` calls `search.mutate({ query: values.query })` — **never passes `category`** — so `POST /knowledge/search` runs with `dto.category` undefined → `knowledge.service.ts:234-238` applies `Prisma.empty` (no category filter at all). The admin-facing global search always searches every document in the company regardless of role-scoping, while the exact same backend enforces strict role-scoping for chat and RETRIEVE. `DocumentList.tsx:41-45`'s own comment confirms this is intentional ("global page — shows every document"), but it means the manual search surface is the one place in the whole chain where the scoping rule doesn't apply — worth flagging as an asymmetry even though the code comments call it deliberate. |
| Document uploaded, ingestion `FAILED` | **UNUSED-because-broken (per-doc, visible)** | `ingestion.processor.ts:97-107` flips status to `FAILED` with the real error message; `KnowledgeDocument.status`/`.error` are shown in `DocumentList.tsx` (`detail` line, `:70-74`). Not silent — a failed doc is visibly dead, not silently invisible. |
| Retention-expired documents | **UNUSED-by-design (time-based deletion)** | `data-retention.service.ts:294-298` — a document past `SecurityPolicy.dataRetentionDays` is deleted (row + blob) by the daily sweep. Working as intended, not a defect. |
| Seed/demo knowledge content | **NONE FOUND** | Grepped `apps/api/prisma` for any `KnowledgeDocument` seed/fixture writer beyond the schema/migrations themselves — zero hits (`seed-credit-packs.ts`/`seed-platform-operator.ts` don't touch it). There is no demo knowledge base masquerading as real content. |

---

## D. Mock/fake knowledge — essentially clean

No hardcoded document arrays, no fake search-result generator, no static "demo answer" path found anywhere in `knowledge.service.ts`, `ingestion.processor.ts`, `retrieve.handler.ts`, or the frontend `features/knowledge/*`. The search endpoint always executes the real pgvector query (`knowledge.service.ts:240-249`); there is no short-circuit that returns canned results. **The only thing that could make search results feel "fake" is the hash-embedding default (§B) — a real deterministic computation with weak semantics, not a mock.** This matches Cluster 6's finding that the frontend generally has zero hardcoded-data patterns.

---

## E. `EmployeeMemory` — genuinely used, and the crowd-out gap is real and reproducible from the code

**Verdict: FULLY IMPLEMENTED as a mechanism, but PARTIALLY IMPLEMENTED as a durable-learning feature** — it is real (not mocked) and genuinely fed into the agent loop, but the "semantic recall" gap CLAUDE.md lists as deferred is confirmed real by the exact interaction of two constants plus one unconditional write.

1. **It is real, not decorative.** `MemoryService.load` (`memory.service.ts:26-48`) is called on every chat turn (`agent-runtime.service.ts:320-324`) and its output — both `FACT` (from feedback/manual teach) and `SUMMARY` (from prior turns) — is injected verbatim into the system prompt under "What you remember from earlier:" (`agent-runtime.service.ts:848-851`). This is a genuine input to the completion call, confirmed end to end.
2. **The crowd-out mechanism, with exact evidence:**
   - `RECENT_MEMORY_LIMIT = 5` (`employees.constants.ts:47`).
   - `MemoryService.load` queries `employeeMemory.findMany({ where: { companyId, employeeId }, orderBy: { createdAt: 'desc' }, take: RECENT_MEMORY_LIMIT })` with **no `kind` filter** (`memory.service.ts:37-44`, comment explicitly notes "No `kind` filter" is deliberate so FEEDBACK-derived FACTs are recalled).
   - `AgentRuntimeService.completeTurn` calls `this.memory.appendSummary(...)` **unconditionally after every single turn** (`agent-runtime.service.ts:643-650`), writing a new `SUMMARY` row every time.
   - Net effect: a `FACT` taught once (via `LearningService.teachMemory`, `learning.service.ts:94-111`, or promoted from a 👎+correction, `:50-63`) is recalled by the runtime only until 5 more turns (of ANY kind) have produced newer rows — after that it silently drops out of the top-5 `createdAt DESC` window and is never seen by the model again, with no ranking by importance or relevance, purely recency.
   - **This gap is directly visible as a UI/backend mismatch**: `LearningService.listMemories` (`learning.service.ts:82-92`) has **no `take` limit** — the Learning panel (`LearningPanel.tsx:84-113`) shows **every** memory the employee has ever been taught, with a live "Memories" count tile. A user teaching a 6th fact will see all 6 in the UI, correctly implying the employee "knows" them — but the runtime only ever recalls the most recent 5 (mixed with SUMMARY noise), so older taught facts are invisibly non-functional. The UI does not warn about this.
3. **No embeddings on `EmployeeMemory`, confirmed at the schema level.** `schema.prisma:781-794` — the model has `id`/`companyId`/`employeeId`/`kind`/`content`/`source`/`createdAt` and `@@index([companyId])` only; no vector column, no HNSW index, unlike `KnowledgeChunk`. `memory.service.ts:19` states this outright in a comment: "recalled by recency, no vectors here." Confirms CLAUDE.md's own "semantic memory recall... NOT started" claim, and confirms the separate hardening-plan audit's independent verdict: `docs/implementation/workflow-system/orlixa-cto-architecture-hardening-engine-freeze-plan.md:2344` — **"J — Memory (§45) | [DEFERRED by the plan] | §45 says explicitly: do not prioritise before execution reliability."** Three independent sources (schema comment, code comment, separate audit doc) agree — this is a well-documented, deliberately-deferred gap, not a hidden one.

---

## F. CLAUDE.md drift found: the RETRIEVE node claim is stale

`d:/Vertical AI/platform/CLAUDE.md` (Knowledge/RAG module-status bullet) states: *"The workflow `RETRIEVE` node stays intentionally unscoped (company-wide)."*

**This is now false and should be corrected.** The actual code (`retrieve.handler.ts:1-161`, read in full this pass) implements exactly the opposite: role-based scoping most-specific-first (employee → workflow category → company-wide-with-recorded-null), closing what its own doc comment calls a real "knowledge leak" (§44: *"a Marketing workflow could read HR documents by adding a RETRIEVE node"*). This is independently confirmed by:
- `retrieve.handler.spec.ts` — 7 passing unit tests titled `RetrieveNodeHandler (§44 scoping)`, each pinning one branch of the scope resolution.
- A **separate, independent audit document** — `docs/implementation/workflow-system/orlixa-cto-architecture-hardening-engine-freeze-plan.md:2343` — verdict `[VERIFIED — closed]` for the identical item.

So three sources (code, tests, a prior independent audit) all agree the node is scoped; only the top-level `platform/CLAUDE.md` module-status bullet is out of date, most likely because it was written before the §44 hardening pass landed and never updated afterward. **This is a doc-drift finding, not a product defect** — the actual behavior is the more secure one — but it means anyone reading CLAUDE.md today would materially misjudge this system's security posture (in the safe direction, but still wrong).

---

## Top 5 most severe findings

1. **The default embedding provider (`EMBEDDINGS_PROVIDER=hash`) is lexical, not semantic.** It is real and deterministic (not noise, not a mock — hashing-trick bag-of-words), but it only matches literal shared vocabulary between query and document. A production deployment that never explicitly sets `local` or `openai` gets Knowledge/RAG search that looks like semantic search in the UI but functions as crude keyword matching underneath — the single biggest gap between "what this looks like it does" and "what it actually does" in this cluster.
2. **Memory crowd-out is real and independently confirmed three times over** (`memory.service.ts:19,37-44`, `employees.constants.ts:47`, and the separate hardening-plan audit at `:2344`), and it is invisible to the user: the Learning panel UI shows every fact ever taught with no limit (`learning.service.ts:82-92`), while the runtime silently recalls only the 5 most-recent memory rows of any kind — an employee can look like it "knows" 10 facts while functionally remembering at most 5, whichever are newest, with SUMMARY noise from ordinary chat turns actively pushing FACTs out.
3. **`platform/CLAUDE.md`'s Knowledge/RAG bullet is stale and states the opposite of the current, tested, security-hardened behavior** of the workflow RETRIEVE node — it says "intentionally unscoped (company-wide)" when the code has enforced strict role-based scoping (with 7 pinned tests and its own prior audit sign-off) since the §44 hardening pass. Low severity as a product risk (the real behavior is safer than the documented one), but a real instance of "don't trust CLAUDE.md as ground truth" playing out concretely.
4. **The global `/knowledge` admin page's manual search bypasses the role/category scoping that every other retrieval path in the system enforces** (`SearchPanel.tsx` never sends `category`) — arguably intentional per the surrounding code comments (it's the company-wide management surface), but it means "Knowledge search" behaves differently depending on which of the three UI entry points (chat, employee Knowledge tab, global admin search) a user is on, with no visible indicator of which scoping rule is in effect.
5. **Nothing enforces that a `KnowledgeDocument.category` corresponds to a role any hired `AiEmployee` actually has** — the column is a bare nullable string with no existence check. A document tagged to an unhired role is invisible to every chat/workflow retrieval path and silently orphaned, discoverable only by an admin manually browsing the unfiltered global list. Structural risk inferred from the code; not confirmed against live tenant data this pass (no DB access).
