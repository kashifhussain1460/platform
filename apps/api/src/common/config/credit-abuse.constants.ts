/**
 * Credit system Phase 10, Task 10.6 (§26) — the remaining Option-A
 * conservative, fixed, env-overridable abuse-prevention constants: the
 * signup domain-velocity window (extends Task 4.2's counter, which had this
 * inline as a magic number) and a knowledge-upload size ceiling (closes the
 * confirmed gap that `FileInterceptor('file')` had no `limits.fileSize` at
 * all — an unbounded upload is buffered fully in memory before any other
 * check runs).
 */

/** How long a domain's free-grant count accumulates before resetting (Task 4.2). */
export function signupDomainVelocityWindowMs(): number {
  const raw = Number(process.env.SIGNUP_DOMAIN_VELOCITY_WINDOW_MS);
  return Number.isFinite(raw) && raw > 0 ? raw : 24 * 60 * 60 * 1000; // 24h
}

/** Max bytes for one knowledge-document upload, checked BEFORE ingestion — independent of credit balance. */
export function knowledgeUploadMaxBytes(): number {
  const raw = Number(process.env.KNOWLEDGE_UPLOAD_MAX_BYTES);
  return Number.isFinite(raw) && raw > 0 ? raw : 20 * 1024 * 1024; // 20 MB
}
