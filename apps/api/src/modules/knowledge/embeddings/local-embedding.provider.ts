import { Injectable } from '@nestjs/common';
import { EMBEDDING_DIM, type EmbeddingProvider } from './embedding.provider';

/**
 * Opt-in local model provider (`EMBEDDINGS_PROVIDER=local`). Runs
 * all-MiniLM-L6-v2 in-process via @xenova/transformers. That package is NOT a
 * hard dependency — it is imported lazily so the default zero-dep path never
 * needs it. The pipeline is created once and reused (singleton).
 */
@Injectable()
export class LocalEmbeddingProvider implements EmbeddingProvider {
  readonly dim = EMBEDDING_DIM;
  private pipe: ((text: string, opts: unknown) => Promise<{ data: Float32Array }>) | null =
    null;

  async embed(texts: string[]): Promise<number[][]> {
    const pipe = await this.getPipe();
    const out: number[][] = [];
    for (const text of texts) {
      const res = await pipe(text, { pooling: 'mean', normalize: true });
      out.push(Array.from(res.data));
    }
    return out;
  }

  private async getPipe(): Promise<
    (text: string, opts: unknown) => Promise<{ data: Float32Array }>
  > {
    if (!this.pipe) {
       
      // @ts-expect-error optional dep — installed only when EMBEDDINGS_PROVIDER=local
      const { pipeline } = await import('@xenova/transformers');
      this.pipe = (await pipeline(
        'feature-extraction',
        'Xenova/all-MiniLM-L6-v2',
      )) as unknown as (
        text: string,
        opts: unknown,
      ) => Promise<{ data: Float32Array }>;
    }
    return this.pipe;
  }
}
