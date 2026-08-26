import { Injectable } from '@nestjs/common';
import { EMBEDDING_DIM, type EmbeddingProvider, type EmbedResult } from './embedding.provider';

/**
 * DEFAULT embedding provider: fully offline, zero-dependency and deterministic
 * (so tests need no model download or network). Tokens are hashed into signed
 * buckets of a 384-dim vector which is then L2-normalized — a "hashing trick"
 * bag-of-words embedding. Documents/queries sharing tokens land in the same
 * buckets, giving high cosine similarity; good enough for local dev + e2e.
 */
@Injectable()
export class HashEmbeddingProvider implements EmbeddingProvider {
  readonly dim = EMBEDDING_DIM;

  async embed(texts: string[]): Promise<EmbedResult> {
    return { vectors: texts.map((text) => this.embedOne(text)), usage: undefined };
  }

  private embedOne(text: string): number[] {
    const vec = new Array<number>(this.dim).fill(0);
    const tokens = text.toLowerCase().match(/[a-z0-9]+/g) ?? [];
    for (const token of tokens) {
      const bucket = this.hash(token) % this.dim;
      // A second hash bit gives a stable sign so distinct tokens can cancel,
      // improving discrimination between unrelated texts.
      const sign = (this.hash(`${token}#`) & 1) === 0 ? 1 : -1;
      vec[bucket] += sign;
    }
    let norm = Math.sqrt(vec.reduce((sum, v) => sum + v * v, 0));
    if (norm === 0) {
      norm = 1;
    }
    return vec.map((v) => v / norm);
  }

  /** FNV-1a 32-bit hash — deterministic across processes/platforms. */
  private hash(input: string): number {
    let h = 0x811c9dc5;
    for (let i = 0; i < input.length; i += 1) {
      h ^= input.charCodeAt(i);
      h = Math.imul(h, 0x01000193);
    }
    return h >>> 0;
  }
}
