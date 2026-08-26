import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { EMBEDDING_DIM, type EmbeddingProvider, type EmbedResult } from './embedding.provider';

/**
 * Opt-in OpenAI provider (`EMBEDDINGS_PROVIDER=openai`). Uses
 * text-embedding-3-small with `dimensions: 384` so vectors stay compatible with
 * the pgvector column. `openai` is imported lazily (not a hard dependency) and
 * the client is created once. Requires OPENAI_API_KEY.
 */
@Injectable()
export class OpenAIEmbeddingProvider implements EmbeddingProvider {
  readonly dim = EMBEDDING_DIM;
  private client: {
    embeddings: {
      create(args: {
        model: string;
        input: string[];
        dimensions: number;
      }): Promise<{
        data: Array<{ embedding: number[] }>;
        usage?: { total_tokens: number };
      }>;
    };
  } | null = null;

  constructor(private readonly config: ConfigService) {}

  async embed(texts: string[]): Promise<EmbedResult> {
    const client = await this.getClient();
    const res = await client.embeddings.create({
      model: 'text-embedding-3-small',
      input: texts,
      dimensions: this.dim,
    });
    return {
      vectors: res.data.map((d) => d.embedding),
      // Credit-system prerequisite (Task 1.4) — captured only, not yet
      // metered. See EmbeddingUsage's doc comment.
      usage: res.usage ? { totalTokens: res.usage.total_tokens } : undefined,
    };
  }

  private async getClient() {
    if (!this.client) {
      // eslint-disable-next-line @typescript-eslint/ban-ts-comment
      // @ts-ignore optional dep — installed only when EMBEDDINGS_PROVIDER=openai
      const { default: OpenAI } = await import('openai');
      this.client = new OpenAI({
        apiKey: this.config.getOrThrow<string>('OPENAI_API_KEY'),
      }) as unknown as NonNullable<typeof this.client>;
    }
    return this.client;
  }
}
