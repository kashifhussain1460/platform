import { ConfigService } from '@nestjs/config';
import type { StorageProvider } from './storage.provider';

/**
 * Opt-in S3/MinIO storage provider (`STORAGE_PROVIDER=s3`). `@aws-sdk/client-s3`
 * is imported lazily (not a hard dependency). Configured for MinIO compatibility
 * via a custom endpoint + path-style addressing. The client is created once.
 */
export class S3StorageProvider implements StorageProvider {
  private client: {
    send(command: unknown): Promise<{
      Body?: { transformToByteArray(): Promise<Uint8Array> };
    }>;
  } | null = null;

  constructor(private readonly config: ConfigService) {}

  async put(key: string, buf: Buffer, mime: string): Promise<void> {
    const { PutObjectCommand } = await this.sdk();
    const client = await this.getClient();
    await client.send(
      new PutObjectCommand({
        Bucket: this.bucket(),
        Key: key,
        Body: buf,
        ContentType: mime,
      }),
    );
  }

  async get(key: string): Promise<Buffer> {
    const { GetObjectCommand } = await this.sdk();
    const client = await this.getClient();
    const res = await client.send(
      new GetObjectCommand({ Bucket: this.bucket(), Key: key }),
    );
    if (!res.Body) {
      throw new Error(`S3 object not found: ${key}`);
    }
    return Buffer.from(await res.Body.transformToByteArray());
  }

  async delete(key: string): Promise<void> {
    const { DeleteObjectCommand } = await this.sdk();
    const client = await this.getClient();
    await client.send(
      new DeleteObjectCommand({ Bucket: this.bucket(), Key: key }),
    );
  }

  private bucket(): string {
    return this.config.getOrThrow<string>('S3_BUCKET');
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private async sdk(): Promise<any> {
     
    // @ts-expect-error optional dep — installed only when STORAGE_PROVIDER=s3
    return import('@aws-sdk/client-s3');
  }

  private async getClient() {
    if (!this.client) {
      const { S3Client } = await this.sdk();
      this.client = new S3Client({
        endpoint: this.config.get<string>('S3_ENDPOINT'),
        forcePathStyle: true,
        region: this.config.get<string>('S3_REGION') ?? 'us-east-1',
        credentials: {
          accessKeyId: this.config.getOrThrow<string>('S3_ACCESS_KEY'),
          secretAccessKey: this.config.getOrThrow<string>('S3_SECRET_KEY'),
        },
      }) as unknown as NonNullable<typeof this.client>;
    }
    return this.client;
  }
}
