import { del, get, put } from '@vercel/blob';
import { ConfigService } from '@nestjs/config';
import type { StorageProvider } from './storage.provider';

/**
 * Native Vercel Blob storage provider (`STORAGE_PROVIDER=vercel-blob`). Blobs are
 * uploaded `private` (reads require this app's own token, not a guessable public
 * URL) with `addRandomSuffix: false` + `allowOverwrite: true` so an object key
 * behaves like a stable key-value slot, matching Local/S3StorageProvider semantics.
 * `BLOB_READ_WRITE_TOKEN` is auto-injected by Vercel once a Blob store is
 * connected to the project — no manual credential wiring needed in production.
 */
export class VercelBlobStorageProvider implements StorageProvider {
  constructor(private readonly config: ConfigService) {}

  async put(key: string, buf: Buffer, mime: string): Promise<void> {
    await put(key, buf, {
      access: 'private',
      contentType: mime,
      addRandomSuffix: false,
      allowOverwrite: true,
      token: this.token(),
    });
  }

  async get(key: string): Promise<Buffer> {
    const result = await get(key, { access: 'private', token: this.token() });
    if (!result) {
      throw new Error(`Vercel Blob not found: ${key}`);
    }
    const chunks: Buffer[] = [];
    for await (const chunk of result.stream as AsyncIterable<Buffer>) {
      chunks.push(chunk);
    }
    return Buffer.concat(chunks);
  }

  async delete(key: string): Promise<void> {
    await del(key, { token: this.token() });
  }

  private token(): string | undefined {
    return this.config.get<string>('BLOB_READ_WRITE_TOKEN');
  }
}
