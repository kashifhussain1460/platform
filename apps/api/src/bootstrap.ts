import { INestApplication, ValidationPipe } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import cookieParser from 'cookie-parser';

/**
 * Shared app config (middleware/pipes/CORS) applied by both the long-running
 * process (main.ts, app.listen) and the Vercel serverless entry (api/index.ts,
 * no listen) so the two entrypoints can't drift apart.
 */
export function configureApp(app: INestApplication): void {
  const config = app.get(ConfigService);

  // Trust the proxy that terminated TLS in front of us.
  //
  // Without this, Express reports `req.protocol === 'http'` for EVERY request,
  // because it only reads `X-Forwarded-Proto` when it has been told the header
  // is trustworthy. That breaks any webhook whose signature covers the public
  // request URL: Twilio signs `https://api.example.com/engines/whatsapp/webhook`,
  // `WhatsappWebhookController` would reconstruct `http://…`, the HMAC would not
  // match, and every genuine delivery would be rejected with a false 401. Local
  // development never sees it (no proxy, really http), so it only appears once
  // the thing is deployed.
  //
  // `1` = trust exactly ONE hop, the immediate proxy — not an arbitrary chain.
  // Vercel (and comparable PaaS edges) overwrite `X-Forwarded-Proto`/`-Host` on
  // the way in, so an external client cannot forge them; a larger number would
  // start trusting hops a client could inject. If this API is ever deployed
  // behind two proxies (e.g. a CDN in front of a load balancer) this number has
  // to grow to match, and if it is ever exposed DIRECTLY to the internet with no
  // proxy at all it should be removed — trusting a forwarded header from a
  // direct client is how a spoofed protocol/host gets in.
  const httpInstance = app.getHttpAdapter().getInstance() as {
    set?: (setting: string, value: unknown) => void;
  };
  // Optional-call: only Express has `set`. A Fastify adapter reads the same
  // headers through its own `trustProxy` option and has no `set()` to call.
  httpInstance.set?.('trust proxy', 1);

  app.use(cookieParser());
  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      transform: true,
      forbidNonWhitelisted: false,
    }),
  );

  app.enableCors({
    origin: config.get<string>('WEB_ORIGIN') ?? 'http://localhost:3000',
    credentials: true,
  });
}
