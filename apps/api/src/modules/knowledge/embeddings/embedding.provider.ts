/**
 * Credit-system prerequisite (docs/architecture/orlixa-ai-credit-usage-billing-plan.md
 * Phase 1, Task 1.4): captured only, not yet metered. `RETRIEVE`/embedding
 * calls stay free until a later, explicitly-deferred workstream wires this
 * to billing.
 */
export interface EmbeddingUsage {
  totalTokens: number;
}

/** One vector per input text (order-preserved), plus optional token usage. */
export interface EmbedResult {
  vectors: number[][];
  /** Undefined for providers with no token concept (hash/local). */
  usage?: EmbeddingUsage;
}

/**
 * Swappable embedding backend (mirrors the auth AuthProvider pattern). The
 * active implementation is chosen by the `EMBEDDINGS_PROVIDER` env var and
 * provided as a singleton under the EMBEDDING_PROVIDER DI token.
 */
export interface EmbeddingProvider {
  /** Output dimensionality — must match the pgvector column (384). */
  readonly dim: number;
  /** Embed a batch of texts, returning one vector per input (order-preserved). */
  embed(texts: string[]): Promise<EmbedResult>;
}

/** DI token for the active EmbeddingProvider implementation. */
export const EMBEDDING_PROVIDER = Symbol('EMBEDDING_PROVIDER');

/** Fixed embedding size across all providers (all-MiniLM-L6-v2 / OpenAI-384). */
export const EMBEDDING_DIM = 384;
