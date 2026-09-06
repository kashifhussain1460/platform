# WhatsApp Sales Agent Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the WhatsApp Sales Agent — a new `whatsapp` engine (Twilio-backed) that receives inbound
WhatsApp leads, qualifies them via an AI Employee, and hands hot leads to the sales team, following the
exact `EngineAdapter`/webhook/skill/workflow-template patterns this codebase already uses for Chatwoot.

**Architecture:** New `modules/engines/whatsapp/` (per-company Twilio credentials, Chatwoot's tenancy
shape, not Postiz's shared-instance shape) + a new shared `Lead` entity (reused later by the Real Estate
Lead Agent) + a new `whatsapp` skill (3 tools) + one new workflow template (`sales.whatsapp-lead-qualify`)
+ a new `NEW_LEAD` canonical-event mapper (the type already exists in `@vaep/types`, unused until now) +
a Leads frontend feature.

**Tech Stack:** NestJS/Prisma (existing `apps/api`), `twilio` npm SDK (new dependency), existing
`ResilientClientBase`/`CryptoService`/`CanonicalIngestService`/workflow-templates infrastructure.

**Spec:** `docs/plans/2026-09-06-whatsapp-sales-engine-plan.md` (the design this implements — read it
first for the tenancy-model and Lead-entity-sharing rationale, both already approved).

## Global Constraints

- Twilio signature verification (`X-Twilio-Signature`, via the `twilio` SDK's own `validateRequest` —
  **never a hand-rolled HMAC check**, per Twilio's own guidance: "Twilio may add parameters without
  notice, and the exact algorithm has edge cases the SDK handles") must complete BEFORE any
  `Lead`/`Conversation`/`Message` row is read or written — the exact ordering discipline
  `support-webhook.controller.ts` already documents as a lesson learned from Postiz's webhook shipping
  unauthenticated.
- Per-company Twilio credentials (Chatwoot's per-account resource-key shape), never a shared global key
  (Postiz's shape) — confirmed design decision.
- `whatsapp.send_message` must refuse to send outside the 24-hour customer-service window (a WhatsApp
  platform rule, not an Orlixa approval gate) rather than attempting a send Twilio would silently fail.
- AI_EMPLOYEE_STEP nodes already run with `disableTools: true` unconditionally (`ai-employee-step.handler.ts:125`)
  — no template-level configuration needed for this; side effects stay in explicit TOOL_ACTION nodes.
- `Lead` is a shared, source-discriminated entity (`source: 'WHATSAPP' | ...`) — not `WhatsAppLead` —
  confirmed design decision, do not narrow it back down.
- TypeScript strict, no `any`, no disabled lint rules.

---

## Task 1: Prisma schema — `WhatsAppAccount`, `Lead`, `Conversation.leadId`

**Files:**
- Modify: `apps/api/prisma/schema.prisma`
- Create: a new migration via `prisma:migrate:new`

**Interfaces:**
- Produces: `WhatsAppAccount` (id, companyId, employeeId?, twilioAccountSid, twilioAuthToken (encrypted),
  whatsappSenderNumber, status: SkillConnectionStatus), `Lead` (id, companyId, source: LeadSource, phone,
  name?, email?, status: LeadStatus, qualificationData: Json?, conversationId?, assignedToUserId?,
  createdAt, lastContactedAt), `Conversation.leadId` (nullable FK).

- [ ] **Step 1: Add the new models and enums**

In `apps/api/prisma/schema.prisma`, add near the existing `ChatwootAccount` model (around line 2068):

```prisma
enum LeadSource {
  WHATSAPP
}

enum LeadStatus {
  NEW
  QUALIFIED
  HOT
  NURTURE
  DISQUALIFIED
  CONVERTED
}

model WhatsAppAccount {
  id                   String                @id @default(cuid())
  companyId            String
  company              Company               @relation(fields: [companyId], references: [id], onDelete: Cascade)
  /// Per-employee-skill-connections shape (nullable = company-wide, matches
  /// the existing Gmail per-employee pattern) — see whatsapp-webhook.controller.ts
  /// for how an inbound message resolves which employee owns the conversation.
  employeeId           String?
  employee             AiEmployee?           @relation(fields: [employeeId], references: [id], onDelete: SetNull)
  twilioAccountSid     String
  twilioAuthToken      String // CryptoService-encrypted at rest
  whatsappSenderNumber String // E.164, no "whatsapp:" prefix stored (added at call time)
  status               SkillConnectionStatus @default(NOT_CONNECTED)
  createdAt            DateTime              @default(now())

  @@unique([companyId, whatsappSenderNumber])
  @@index([companyId])
}

model Lead {
  id                String       @id @default(cuid())
  companyId         String
  company           Company      @relation(fields: [companyId], references: [id], onDelete: Cascade)
  source            LeadSource
  phone             String
  name              String?
  email             String?
  status            LeadStatus   @default(NEW)
  qualificationData Json?
  conversationId    String?      @unique
  conversation      Conversation? @relation(fields: [conversationId], references: [id], onDelete: SetNull)
  assignedToUserId  String?
  assignedToUser    User?        @relation(fields: [assignedToUserId], references: [id], onDelete: SetNull)
  createdAt         DateTime     @default(now())
  lastContactedAt   DateTime?

  @@unique([companyId, source, phone])
  @@index([companyId, status])
}
```

Then modify the existing `Conversation` model (around line 742) to add the reverse side:

```prisma
model Conversation {
  id         String     @id @default(cuid())
  companyId  String
  employeeId String
  employee   AiEmployee @relation(fields: [employeeId], references: [id], onDelete: Cascade)
  title      String?
  createdAt  DateTime   @default(now())

  messages Message[]
  lead     Lead?

  @@index([companyId])
}
```

Also add the reverse relations Prisma requires: `WhatsAppAccount[]` on `AiEmployee`, `Lead[]` on
`Company`, `Lead[]` on `User` (find each model's existing relation list and append, following the exact
style already used for `ChatwootAccount`/`SupportConversation` on `Company`).

- [ ] **Step 2: Author the migration**

```bash
cd apps/api && pnpm run prisma:migrate:new --name whatsapp_lead_entities
```

Per `platform/CLAUDE.md`'s pgvector GOTCHA: review the generated SQL — this migration only adds new
tables/columns (no `Unsupported("vector")` column involved), so no `DROP INDEX ..._embedding_idx` line
should appear; if one does, something else drifted and needs investigation before proceeding.

- [ ] **Step 3: Apply the migration and regenerate the client**

```bash
pnpm --filter @vaep/api run prisma:migrate
```

Expected: migration applies cleanly, Prisma Client regenerates with `prisma.whatsAppAccount` and
`prisma.lead` available.

- [ ] **Step 4: Verify with a throwaway script**

```bash
node -e "
const { PrismaClient } = require('@prisma/client');
const p = new PrismaClient();
p.lead.count().then(c => { console.log('Lead table reachable, count:', c); return p.\$disconnect(); });
"
```

Expected: prints `Lead table reachable, count: 0` with no error.

- [ ] **Step 5: Commit**

```bash
git add apps/api/prisma/schema.prisma apps/api/prisma/migrations
git commit -m "feat(whatsapp): add WhatsAppAccount and Lead Prisma models"
```

---

## Task 2: Add the `twilio` dependency

**Files:**
- Modify: `apps/api/package.json`

- [ ] **Step 1: Install**

```bash
cd apps/api && pnpm add twilio
```

- [ ] **Step 2: Verify the import resolves**

```bash
node -e "const twilio = require('twilio'); console.log(typeof twilio, typeof twilio.validateRequest);"
```

Expected: `function function` (the package default export is callable — `twilio(sid, token)` — and
carries `validateRequest` as a static).

- [ ] **Step 3: Commit**

```bash
git add apps/api/package.json apps/api/pnpm-lock.yaml
git commit -m "chore(whatsapp): add twilio SDK dependency"
```

(Run from the repo root if `pnpm-lock.yaml` lives there instead of `apps/api` — check with `git status`
after Step 1 and adjust the path.)

---

## Task 3: `whatsapp.constants.ts`

**Files:**
- Create: `apps/api/src/modules/engines/whatsapp/whatsapp.constants.ts`

**Interfaces:**
- Produces: `WHATSAPP_PROVIDER`, `whatsappResourceKey(companyId)`, header name constants — consumed by
  Tasks 4, 6, 7.

- [ ] **Step 1: Write the file**

```typescript
/** CanonicalEvent/RawEvent provider discriminator (event-mapper.ts's switch, ingestVerified's `provider`). */
export const WHATSAPP_PROVIDER = 'whatsapp';

/**
 * C-07 shape: PER-COMPANY resource key (Chatwoot's shape, not Postiz's global
 * one) — each Orlixa company has its own Twilio account/number, so one
 * tenant's broken credentials must never trip the circuit breaker for another
 * tenant's independent WhatsApp number.
 */
export function whatsappResourceKey(companyId: string): string {
  return `engine:whatsapp:${companyId}`;
}

export const TWILIO_SIGNATURE_HEADER = 'x-twilio-signature';

/** WhatsApp's own platform rule (not an Orlixa policy) — free-form replies only within this window. */
export const WHATSAPP_SESSION_WINDOW_MS = 24 * 60 * 60_000;
```

- [ ] **Step 2: Commit**

```bash
git add apps/api/src/modules/engines/whatsapp/whatsapp.constants.ts
git commit -m "feat(whatsapp): add engine constants"
```

---

## Task 4: `TwilioWhatsappClientService`

**Files:**
- Create: `apps/api/src/modules/engines/whatsapp/twilio-whatsapp-client.service.ts`
- Test: `apps/api/src/modules/engines/whatsapp/twilio-whatsapp-client.service.spec.ts`

**Interfaces:**
- Consumes: `whatsappResourceKey` (Task 3), `ResilientClientBase`/`CircuitBreakerRegistry`/`RateLimiter`
  (existing, see `postiz-client.service.ts` for the exact base-class usage pattern).
- Produces: `sendFreeform({ accountSid, authToken, from, to, body }): Promise<{ sid: string; status: string }>`,
  `sendTemplate({ accountSid, authToken, from, to, contentSid, contentVariables }): Promise<{ sid: string; status: string }>`,
  `verifyWebhookSignature(authToken, signatureHeader, url, params): boolean` — all consumed by Task 5
  (engine adapter), Task 7 (webhook controller), and Task 10 (RealSkillExecutor tools).

- [ ] **Step 1: Write the failing test**

```typescript
import twilio from 'twilio';
import { ConfigService } from '@nestjs/config';
import { CircuitBreakerRegistry } from '../../../common/resilience/circuit-breaker.registry';
import { RateLimiter } from '../../../common/resilience/rate-limiter';
import { TwilioWhatsappClientService } from './twilio-whatsapp-client.service';

describe('TwilioWhatsappClientService', () => {
  const config = new ConfigService({});
  const breakers = new CircuitBreakerRegistry(null, config);
  const rateLimiter = new RateLimiter(null, config);
  const service = new TwilioWhatsappClientService(breakers, rateLimiter);

  it('sends a free-form message via the Twilio SDK', async () => {
    const create = jest.fn().mockResolvedValue({ sid: 'MM123', status: 'queued' });
    jest.spyOn(service as any, 'clientFor').mockReturnValue({ messages: { create } });

    const result = await service.sendFreeform({
      accountSid: 'ACxxx',
      authToken: 'secret',
      from: '+15550001111',
      to: '+15550002222',
      body: 'Hi there',
    });

    expect(create).toHaveBeenCalledWith({
      from: 'whatsapp:+15550001111',
      to: 'whatsapp:+15550002222',
      body: 'Hi there',
    });
    expect(result).toEqual({ sid: 'MM123', status: 'queued' });
  });

  it('sends a template message via the Twilio SDK', async () => {
    const create = jest.fn().mockResolvedValue({ sid: 'MM456', status: 'queued' });
    jest.spyOn(service as any, 'clientFor').mockReturnValue({ messages: { create } });

    const result = await service.sendTemplate({
      accountSid: 'ACxxx',
      authToken: 'secret',
      from: '+15550001111',
      to: '+15550002222',
      contentSid: 'HXabc',
      contentVariables: { '1': 'March 25' },
    });

    expect(create).toHaveBeenCalledWith({
      from: 'whatsapp:+15550001111',
      to: 'whatsapp:+15550002222',
      contentSid: 'HXabc',
      contentVariables: JSON.stringify({ '1': 'March 25' }),
    });
    expect(result).toEqual({ sid: 'MM456', status: 'queued' });
  });

  it('verifies a real Twilio-signed request via the SDK validator', () => {
    const authToken = 'test-auth-token';
    const url = 'https://example.com/engines/whatsapp/webhook';
    const params = { MessageSid: 'MM1', From: 'whatsapp:+15550002222', Body: 'hi' };
    const signature = twilio.getExpectedTwilioSignature(
      { authToken } as any,
      url,
      params,
    );

    expect(service.verifyWebhookSignature(authToken, signature, url, params)).toBe(true);
    expect(service.verifyWebhookSignature(authToken, 'wrong-signature', url, params)).toBe(false);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx jest --config ./test/jest-unit.json twilio-whatsapp-client.service.spec.ts` (from `apps/api`)
Expected: FAIL — `TwilioWhatsappClientService` module not found.

- [ ] **Step 3: Write the implementation**

```typescript
import { Injectable } from '@nestjs/common';
import twilio from 'twilio';
import { CircuitBreakerRegistry } from '../../../common/resilience/circuit-breaker.registry';
import { RateLimiter } from '../../../common/resilience/rate-limiter';
import { ResilientClientBase } from '../../../common/resilience/resilient-client.base';
import { whatsappResourceKey } from './whatsapp.constants';

export interface SendFreeformInput {
  accountSid: string;
  authToken: string;
  from: string; // E.164, no "whatsapp:" prefix
  to: string;
  body: string;
}

export interface SendTemplateInput {
  accountSid: string;
  authToken: string;
  from: string;
  to: string;
  contentSid: string;
  contentVariables: Record<string, string>;
}

export interface TwilioSendResult {
  sid: string;
  status: string;
}

const waPrefix = (e164: string): string => `whatsapp:${e164}`;

/**
 * Thin, typed wrapper around the Twilio Programmable Messaging API for
 * WhatsApp (docs/plans/2026-09-06-whatsapp-sales-engine-plan.md §4/§5).
 *
 * PER-COMPANY resource key (whatsappResourceKey), unlike PostizClientService's
 * single global key — each Orlixa company holds its own Twilio Account
 * SID/Auth Token for its own WhatsApp Business number, so one tenant's
 * revoked/invalid credentials must never trip the circuit breaker for another
 * tenant's independent number. Mirrors ChatwootClientService's per-account
 * resource-key reasoning exactly.
 *
 * Credentials are never held on `this` — every call takes them as arguments
 * (already decrypted by the caller, same pattern RealSkillExecutor uses for
 * Chatwoot's agentBotToken) because a new Twilio Client must be constructed
 * per distinct account/token pair; there is no single shared client.
 */
@Injectable()
export class TwilioWhatsappClientService extends ResilientClientBase {
  constructor(breakers: CircuitBreakerRegistry, rateLimiter: RateLimiter) {
    super(breakers, rateLimiter);
  }

  /** Isolated for testing — jest.spyOn(service, 'clientFor') stubs the network boundary. */
  protected clientFor(accountSid: string, authToken: string) {
    return twilio(accountSid, authToken);
  }

  async sendFreeform(input: SendFreeformInput): Promise<TwilioSendResult> {
    await this.breakers.guard(whatsappResourceKey(input.accountSid));
    const client = this.clientFor(input.accountSid, input.authToken);
    const message = await client.messages.create({
      from: waPrefix(input.from),
      to: waPrefix(input.to),
      body: input.body,
    });
    return { sid: message.sid, status: message.status };
  }

  async sendTemplate(input: SendTemplateInput): Promise<TwilioSendResult> {
    await this.breakers.guard(whatsappResourceKey(input.accountSid));
    const client = this.clientFor(input.accountSid, input.authToken);
    const message = await client.messages.create({
      from: waPrefix(input.from),
      to: waPrefix(input.to),
      contentSid: input.contentSid,
      contentVariables: JSON.stringify(input.contentVariables),
    });
    return { sid: message.sid, status: message.status };
  }

  /**
   * Twilio's own guidance, not a style preference: "Use the SDK validator.
   * Do not implement your own — Twilio may add parameters without notice, and
   * the exact algorithm (including port handling) has edge cases the SDK
   * handles." `params` is the PARSED form-encoded body (Twilio signs
   * form fields, not raw JSON bytes, for inbound-message webhooks — unlike
   * Chatwoot's JSON+HMAC-SHA256 scheme).
   */
  verifyWebhookSignature(
    authToken: string,
    signatureHeader: string | undefined,
    url: string,
    params: Record<string, unknown>,
  ): boolean {
    if (!signatureHeader) return false;
    return twilio.validateRequest(authToken, signatureHeader, url, params as Record<string, string>);
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx jest --config ./test/jest-unit.json twilio-whatsapp-client.service.spec.ts -v`
Expected: PASS, 3/3.

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/modules/engines/whatsapp/twilio-whatsapp-client.service.ts apps/api/src/modules/engines/whatsapp/twilio-whatsapp-client.service.spec.ts
git commit -m "feat(whatsapp): add TwilioWhatsappClientService"
```

---

## Task 5: `WhatsappEngineAdapter`

**Files:**
- Create: `apps/api/src/modules/engines/whatsapp/whatsapp-engine.adapter.ts`
- Test: `apps/api/src/modules/engines/whatsapp/whatsapp-engine.adapter.spec.ts`

**Interfaces:**
- Consumes: `TwilioWhatsappClientService` (Task 4), `PrismaService`, `CryptoService`, the `EngineAdapter`
  interface (`apps/api/src/modules/engines/engine-adapter.ts` — exact contract, do not deviate from its
  method names).
- Produces: `WhatsappEngineAdapter implements EngineAdapter`, `engineKey = 'whatsapp'` — registered in
  Task 8's module.

- [ ] **Step 1: Write the failing test**

```typescript
import { WhatsappEngineAdapter } from './whatsapp-engine.adapter';
import { ENGINE_ADAPTER_METHODS } from '../engine-adapter';

describe('WhatsappEngineAdapter', () => {
  const prisma = {
    whatsAppAccount: {
      findFirst: jest.fn(),
      deleteMany: jest.fn(),
    },
  };
  const crypto = { decrypt: jest.fn((v: string) => v) } as any;
  const client = {} as any;
  const adapter = new WhatsappEngineAdapter(client, prisma as any, crypto);

  it('implements every method the contract requires', () => {
    for (const method of ENGINE_ADAPTER_METHODS) {
      expect(typeof (adapter as any)[method]).toBe('function');
    }
  });

  it('declares its real capabilities and tools', () => {
    expect(adapter.engineKey).toBe('whatsapp');
    expect(adapter.tools()).toEqual([
      'whatsapp.send_message',
      'whatsapp.send_template',
      'whatsapp.get_conversation',
    ]);
    expect(adapter.capabilities()).toContain('disconnect');
    expect(adapter.capabilities()).toContain('healthCheck');
  });

  it('healthCheck reports ok when an account is registered for the company', async () => {
    prisma.whatsAppAccount.findFirst.mockResolvedValue({ id: 'wa_1' });
    const result = await adapter.healthCheck('c_1');
    expect(result).toEqual({ ok: true });
  });

  it('healthCheck reports not-ok when no account is registered', async () => {
    prisma.whatsAppAccount.findFirst.mockResolvedValue(null);
    const result = await adapter.healthCheck('c_1');
    expect(result.ok).toBe(false);
  });

  it('disconnect removes the company\'s WhatsAppAccount row', async () => {
    await adapter.disconnect('c_1');
    expect(prisma.whatsAppAccount.deleteMany).toHaveBeenCalledWith({ where: { companyId: 'c_1' } });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx jest --config ./test/jest-unit.json whatsapp-engine.adapter.spec.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Write the implementation**

```typescript
import { Injectable } from '@nestjs/common';
import { CryptoService } from '../../../common/crypto/crypto.service';
import { PrismaService } from '../../../common/prisma/prisma.service';
import {
  EngineCapabilityUnsupportedError,
  type EngineAdapter,
  type EngineCapability,
  type EngineHealth,
  type EngineWebhookResult,
} from '../engine-adapter';
import { TwilioWhatsappClientService } from './twilio-whatsapp-client.service';

/**
 * §39 — WhatsApp (via Twilio), behind the shared connector contract.
 *
 * Thin delegation to TwilioWhatsappClientService, mirroring
 * ChatwootEngineAdapter exactly: no credential decryption beyond the one
 * lookup verification needs, no audit, no retry — those belong to the
 * platform layers.
 *
 * `connect` is unsupported here for the same reason as Chatwoot's: account
 * provisioning is a manual "paste your Twilio SID/token/sender number" form
 * on the frontend (Task 12), not a browser OAuth redirect, so there is no
 * server-side handshake for this method to perform.
 */
@Injectable()
export class WhatsappEngineAdapter implements EngineAdapter {
  readonly engineKey = 'whatsapp';

  constructor(
    private readonly client: TwilioWhatsappClientService,
    private readonly prisma: PrismaService,
    private readonly crypto: CryptoService,
  ) {}

  capabilities(): readonly EngineCapability[] {
    return ['disconnect', 'healthCheck', 'refresh', 'handleWebhook'];
  }

  tools(): readonly string[] {
    return ['whatsapp.send_message', 'whatsapp.send_template', 'whatsapp.get_conversation'];
  }

  connect(): Promise<never> {
    return Promise.reject(
      new EngineCapabilityUnsupportedError(
        this.engineKey,
        'connect',
        'account connection is a direct Twilio-credentials form (frontend), not a server-side OAuth handshake',
      ),
    );
  }

  async disconnect(companyId: string): Promise<void> {
    await this.prisma.whatsAppAccount.deleteMany({ where: { companyId } });
  }

  async healthCheck(companyId: string): Promise<EngineHealth> {
    const account = await this.prisma.whatsAppAccount.findFirst({
      where: { companyId },
      select: { id: true },
    });
    return account
      ? { ok: true }
      : { ok: false, detail: 'no WhatsApp account is registered for this company' };
  }

  refresh(): Promise<void> {
    // A Twilio Account SID/Auth Token pair does not expire, so there is nothing to refresh.
    return Promise.resolve();
  }

  reconcile(): Promise<{ checked: number; updated: number }> {
    return Promise.reject(
      new EngineCapabilityUnsupportedError(
        this.engineKey,
        'reconcile',
        'conversations are event-driven via the inbound webhook; no local state mirrors a remote poll',
      ),
    );
  }

  /**
   * Signature verification only — ingestion stays in WhatsappWebhookController
   * (Task 7), which resolves the tenant and calls the canonical pipeline. A
   * second ingress path is what this codebase's §37 forbids (see
   * ChatwootEngineAdapter's identical doc comment).
   */
  async handleWebhook(input: {
    rawBody: Buffer;
    headers: Record<string, string | undefined>;
  }): Promise<EngineWebhookResult> {
    void input;
    // Twilio's signature covers the URL + parsed form params, not the raw
    // body bytes alone — verification needs the resolved account's auth
    // token AND the exact request URL, both of which only the controller
    // has. This method exists to satisfy the EngineAdapter contract's
    // capability declaration; the real check happens in the controller,
    // matching the note in engine-adapter.ts that ingestion stays out of
    // the adapter.
    return { verified: false };
  }
}
```

**Note for the implementer:** unlike Chatwoot's `handleWebhook` (which CAN do the full signature check
because Chatwoot's HMAC only needs a secret + timestamp + body, all resolvable from the payload alone),
Twilio's signature needs the full reconstructed request URL, which is only cleanly available in the
controller (`req.protocol`/`req.get('host')`/`req.originalUrl`). If code review disagrees with this
split, an alternative is passing the reconstructed URL into `handleWebhook`'s input — raise this as a
finding during Task 5's review rather than silently picking one, since it's a real design choice with
the contract's own doc comment as the tie-breaker text to argue from.

- [ ] **Step 4: Run test to verify it passes**

Run: `npx jest --config ./test/jest-unit.json whatsapp-engine.adapter.spec.ts -v`
Expected: PASS, 5/5.

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/modules/engines/whatsapp/whatsapp-engine.adapter.ts apps/api/src/modules/engines/whatsapp/whatsapp-engine.adapter.spec.ts
git commit -m "feat(whatsapp): add WhatsappEngineAdapter"
```

---

## Task 6: WhatsApp event mapper (`NEW_LEAD`)

**Files:**
- Modify: `apps/api/src/modules/events/normalization/event-mapper.ts`
- Test: find and extend the existing spec for this file (e.g. `event-mapper.spec.ts` in the same
  directory — check for it first; if none exists, create one following the file's own test conventions).

**Interfaces:**
- Consumes: `RawEventInput`, `CanonicalMapping` (existing types in this file).
- Produces: `mapWhatsapp(raw: RawEventInput): CanonicalMapping`, wired into `mapRawEvent`'s switch —
  consumed automatically by `EventNormalizeProcessor` (no change needed there).

- [ ] **Step 1: Write the failing test**

Add to the existing spec file (or create one) alongside this file's other mapper tests:

```typescript
import { mapRawEvent } from './event-mapper';

describe('mapWhatsapp', () => {
  it('maps an inbound WhatsApp message to NEW_LEAD', () => {
    const result = mapRawEvent({
      provider: 'whatsapp',
      externalId: 'MM123',
      headers: null,
      payload: {
        MessageSid: 'MM123',
        From: 'whatsapp:+15550002222',
        To: 'whatsapp:+15550001111',
        Body: 'Hi, I am interested in your product',
      },
    });

    expect(result.type).toBe('NEW_LEAD');
    expect(result.dedupeKey).toBe('whatsapp:MM123');
    expect(result.data).toMatchObject({
      phone: '+15550002222',
      body: 'Hi, I am interested in your product',
    });
  });

  it('falls back to UNKNOWN when MessageSid is missing', () => {
    const result = mapRawEvent({
      provider: 'whatsapp',
      externalId: null,
      headers: null,
      payload: { From: 'whatsapp:+15550002222' },
    });
    expect(result.type).toBe('UNKNOWN');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx jest --config ./test/jest-unit.json event-mapper.spec.ts -t "mapWhatsapp"` (from `apps/api`)
Expected: FAIL — `provider: 'whatsapp'` falls through to `mapGeneric`, producing `UNKNOWN` for the first
test too (assertion on `result.type === 'NEW_LEAD'` fails).

- [ ] **Step 3: Add the mapper**

In `event-mapper.ts`, add a new function near the other provider mappers (`mapChatwoot`, `mapPlane`) and
wire it into `mapRawEvent`'s switch:

```typescript
function mapWhatsapp(raw: RawEventInput): CanonicalMapping {
  const p = obj(raw.payload);
  const messageSid = str(p?.MessageSid);
  const fromRaw = str(p?.From);
  const body = str(p?.Body);
  if (!messageSid || !fromRaw) {
    return { type: 'UNKNOWN', dedupeKey: `whatsapp:${raw.externalId ?? 'no-id'}`, occurredAt: null, subject: null, data: null };
  }
  // Twilio prefixes WhatsApp numbers "whatsapp:+E164" on both From/To.
  const phone = fromRaw.replace(/^whatsapp:/, '');
  return {
    type: 'NEW_LEAD',
    dedupeKey: `whatsapp:${messageSid}`,
    occurredAt: null,
    subject: { phone },
    data: { phone, body: body ?? null, messageSid },
  };
}
```

Add `case 'whatsapp': return mapWhatsapp(raw);` to `mapRawEvent`'s switch (`event-mapper.ts:385-399`),
alongside the existing `case 'chatwoot'`/`case 'plane'` lines.

- [ ] **Step 4: Run test to verify it passes**

Run: `npx jest --config ./test/jest-unit.json event-mapper.spec.ts -t "mapWhatsapp" -v`
Expected: PASS, 2/2.

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/modules/events/normalization/event-mapper.ts apps/api/src/modules/events/normalization/event-mapper.spec.ts
git commit -m "feat(whatsapp): map inbound WhatsApp messages to NEW_LEAD canonical events"
```

---

## Task 7: `whatsapp-webhook.controller.ts`

**Files:**
- Create: `apps/api/src/modules/engines/whatsapp/whatsapp-webhook.controller.ts`
- Test: `apps/api/src/modules/engines/whatsapp/whatsapp-webhook.controller.spec.ts`

**Interfaces:**
- Consumes: `TwilioWhatsappClientService.verifyWebhookSignature` (Task 4), `CanonicalIngestService.ingestVerified`
  (existing, `apps/api/src/modules/events/ingestion/canonical-ingest.service.ts:76`), `WHATSAPP_PROVIDER`/
  `TWILIO_SIGNATURE_HEADER` (Task 3).
- Produces: `POST /engines/whatsapp/webhook` — public route, no `JwtAuthGuard`.

- [ ] **Step 1: Write the failing test**

```typescript
import { Test, TestingModule } from '@nestjs/testing';
import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import twilio from 'twilio';
import { WhatsappWebhookController } from './whatsapp-webhook.controller';
import { TwilioWhatsappClientService } from './twilio-whatsapp-client.service';
import { PrismaService } from '../../../common/prisma/prisma.service';
import { CryptoService } from '../../../common/crypto/crypto.service';
import { CanonicalIngestService } from '../../events/ingestion/canonical-ingest.service';
import { AuditLogService } from '../../audit/audit-log.service';

describe('WhatsappWebhookController', () => {
  let app: INestApplication;
  const prisma = { whatsAppAccount: { findFirst: jest.fn() }, lead: { upsert: jest.fn() } };
  const crypto = { decrypt: jest.fn((v: string) => v) };
  const ingest = { ingestVerified: jest.fn().mockResolvedValue({ deduped: false, rawEventId: 'evt_1' }) };
  const audit = { record: jest.fn() };
  const AUTH_TOKEN = 'test-auth-token';

  beforeAll(async () => {
    const moduleRef: TestingModule = await Test.createTestingModule({
      controllers: [WhatsappWebhookController],
      providers: [
        { provide: TwilioWhatsappClientService, useValue: new TwilioWhatsappClientService({} as any, {} as any) },
        { provide: PrismaService, useValue: prisma },
        { provide: CryptoService, useValue: crypto },
        { provide: CanonicalIngestService, useValue: ingest },
        { provide: AuditLogService, useValue: audit },
      ],
    }).compile();
    app = moduleRef.createNestApplication({ rawBody: true } as any);
    await app.init();
  });

  afterAll(async () => app.close());

  it('rejects a request with no signature header before touching the database', async () => {
    await request(app.getHttpServer())
      .post('/engines/whatsapp/webhook')
      .send({ MessageSid: 'MM1', From: 'whatsapp:+15550002222', Body: 'hi' })
      .expect(401);
    expect(prisma.whatsAppAccount.findFirst).not.toHaveBeenCalled();
  });

  it('rejects a request for an unknown sender number', async () => {
    prisma.whatsAppAccount.findFirst.mockResolvedValue(null);
    const params = { MessageSid: 'MM1', From: 'whatsapp:+15550002222', To: 'whatsapp:+19990000000', Body: 'hi' };
    const url = `${app.getHttpServer().address ? 'http://127.0.0.1' : ''}/engines/whatsapp/webhook`;
    const signature = twilio.getExpectedTwilioSignature({ authToken: AUTH_TOKEN } as any, url, params);
    await request(app.getHttpServer())
      .post('/engines/whatsapp/webhook')
      .set('x-twilio-signature', signature)
      .send(params)
      .expect(401);
  });

  it('accepts a validly-signed request for a known account and ingests it', async () => {
    prisma.whatsAppAccount.findFirst.mockResolvedValue({
      id: 'wa_1',
      companyId: 'c_1',
      twilioAuthToken: AUTH_TOKEN,
      whatsappSenderNumber: '+19990000000',
    });
    const params = { MessageSid: 'MM2', From: 'whatsapp:+15550002222', To: 'whatsapp:+19990000000', Body: 'hi again' };
    const url = 'http://127.0.0.1/engines/whatsapp/webhook';
    const signature = twilio.getExpectedTwilioSignature({ authToken: AUTH_TOKEN } as any, url, params);
    await request(app.getHttpServer())
      .post('/engines/whatsapp/webhook')
      .set('x-twilio-signature', signature)
      .send(params)
      .expect(200);
    expect(ingest.ingestVerified).toHaveBeenCalled();
  });
});
```

**Note for the implementer:** the exact reconstructed URL Twilio signs must match byte-for-byte what the
controller passes to `verifyWebhookSignature` — Supertest's `app.getHttpServer()` binds to an ephemeral
port, so the test's URL construction may need adjusting to match whatever the controller actually builds
from `req` (e.g. if the controller uses `req.protocol + '://' + req.get('host') + req.originalUrl`, the
test must sign against that exact string). If the first attempt doesn't produce a matching signature,
log the controller's constructed URL and the test's signed URL side by side to find the mismatch rather
than guessing — this is a common Twilio-signature gotcha the `twilio-webhook-architecture` skill flags
("edge cases the SDK handles" cuts both ways: your URL construction must also be exact).

- [ ] **Step 2: Run test to verify it fails**

Run: `npx jest --config ./test/jest-unit.json whatsapp-webhook.controller.spec.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Write the implementation**

```typescript
import {
  Controller,
  Headers,
  HttpCode,
  Logger,
  Post,
  Req,
  UnauthorizedException,
  type RawBodyRequest,
} from '@nestjs/common';
import type { Request } from 'express';
import { PrismaService } from '../../../common/prisma/prisma.service';
import { CryptoService } from '../../../common/crypto/crypto.service';
import { AuditLogService } from '../../audit/audit-log.service';
import { CanonicalIngestService } from '../../events/ingestion/canonical-ingest.service';
import { TwilioWhatsappClientService } from './twilio-whatsapp-client.service';
import { TWILIO_SIGNATURE_HEADER, WHATSAPP_PROVIDER } from './whatsapp.constants';

interface TwilioInboundPayload {
  MessageSid?: string;
  From?: string;
  To?: string;
  Body?: string;
}

/**
 * PUBLIC Twilio inbound-message webhook (docs/plans/2026-09-06-whatsapp-sales-engine-plan.md §4).
 * Deliberately NOT behind JwtAuthGuard/tenant guard — Twilio POSTs here
 * form-encoded, signed with X-Twilio-Signature, not a JWT.
 *
 * NON-NEGOTIABLE ORDERING (the same discipline support-webhook.controller.ts
 * documents, learned from Postiz's webhook shipping unauthenticated and
 * needing a final-review fix): signature verification MUST complete
 * successfully BEFORE any Lead/Conversation/Message row is read or written.
 * The one pre-verification read is the WhatsAppAccount lookup by the
 * (untrusted) `To` number — required to know which auth token to verify
 * against — read-only, yields nothing but a 401 either way.
 */
@Controller('engines/whatsapp/webhook')
export class WhatsappWebhookController {
  private readonly logger = new Logger(WhatsappWebhookController.name);

  constructor(
    private readonly twilioClient: TwilioWhatsappClientService,
    private readonly prisma: PrismaService,
    private readonly crypto: CryptoService,
    private readonly ingest: CanonicalIngestService,
    private readonly audit: AuditLogService,
  ) {}

  @Post()
  @HttpCode(200)
  async receive(
    @Req() req: RawBodyRequest<Request>,
    @Headers(TWILIO_SIGNATURE_HEADER) signature?: string,
  ): Promise<{ ok: boolean }> {
    if (!signature) {
      throw new UnauthorizedException('Missing X-Twilio-Signature header');
    }
    const params = req.body as TwilioInboundPayload;
    const toNumber = params.To?.replace(/^whatsapp:/, '');
    if (!toNumber) {
      throw new UnauthorizedException('Missing To number');
    }

    const account = await this.prisma.whatsAppAccount.findFirst({
      where: { whatsappSenderNumber: toNumber },
    });
    if (!account) {
      throw new UnauthorizedException('Unknown WhatsApp sender number');
    }

    const url = `${req.protocol}://${req.get('host')}${req.originalUrl}`;
    const authToken = this.crypto.decrypt(account.twilioAuthToken);
    const verified = this.twilioClient.verifyWebhookSignature(
      authToken,
      signature,
      url,
      params as unknown as Record<string, unknown>,
    );
    if (!verified) {
      this.logger.warn(`Rejected WhatsApp webhook: signature mismatch for account=${account.id}`);
      throw new UnauthorizedException('Invalid webhook signature');
    }

    // ---- Signature verified. Only past this line may Lead/Conversation/Message tables be written. ----

    const rawBody = req.rawBody ?? Buffer.from(new URLSearchParams(params as Record<string, string>).toString());
    const ingestResult = await this.ingest.ingestVerified({
      companyId: account.companyId,
      connectorId: account.id,
      provider: WHATSAPP_PROVIDER,
      rawBody,
      headers: { [TWILIO_SIGNATURE_HEADER]: signature },
      payload: params,
    });

    if (ingestResult.deduped) {
      this.logger.log(`Duplicate WhatsApp delivery ignored (sid=${params.MessageSid})`);
      return { ok: true };
    }

    await this.audit.record({
      companyId: account.companyId,
      action: 'whatsapp.webhook.received',
      entityType: 'RawEvent',
      entityId: ingestResult.rawEventId ?? undefined,
      metadata: { provider: WHATSAPP_PROVIDER, from: params.From ?? null, messageSid: params.MessageSid ?? null },
    });
    return { ok: true };
  }
}
```

**Note for the implementer:** this task deliberately does NOT write `Lead`/`Conversation`/`Message` rows
directly — that responsibility belongs to whatever consumes the `NEW_LEAD` canonical event fired by
`EventNormalizeProcessor` after Task 6's mapper runs (mirrors how Chatwoot's canonical pipeline and its
own `applyPayload` are two separate concerns). If Task 9's workflow-template EVENT trigger needs a
richer `Lead` row to already exist by the time the workflow runs (not just the CanonicalEvent's `data`
payload), add that Lead-upsert step here in a follow-up round — but write it first without that
assumption and let the reviewer confirm whether it's actually needed, per YAGNI.

- [ ] **Step 4: Run test to verify it passes**

Run: `npx jest --config ./test/jest-unit.json whatsapp-webhook.controller.spec.ts -v`
Expected: PASS, 3/3.

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/modules/engines/whatsapp/whatsapp-webhook.controller.ts apps/api/src/modules/engines/whatsapp/whatsapp-webhook.controller.spec.ts
git commit -m "feat(whatsapp): add signature-verified inbound webhook controller"
```

---

## Task 8: `whatsapp.module.ts` — wire it all together

**Files:**
- Create: `apps/api/src/modules/engines/whatsapp/whatsapp.module.ts`
- Modify: `apps/api/src/modules/skills/skills.module.ts` (import the new module, per Task 10/11's needs)

**Interfaces:**
- Consumes: everything from Tasks 3-7.
- Produces: `WhatsappModule`, exporting `TwilioWhatsappClientService` for `SkillsModule`'s
  `RealSkillExecutor` (Task 10) — mirrors `SupportModule` exporting `ChatwootClientService` exactly.

- [ ] **Step 1: Write the module**

```typescript
import { Module } from '@nestjs/common';
import { CanonicalIngestModule } from '../../events/ingestion/canonical-ingest.module';
import { TwilioWhatsappClientService } from './twilio-whatsapp-client.service';
import { WhatsappEngineAdapter } from './whatsapp-engine.adapter';
import { WhatsappWebhookController } from './whatsapp-webhook.controller';

/**
 * WhatsApp engine module (docs/plans/2026-09-06-whatsapp-sales-engine-plan.md §4):
 * the Twilio REST client and the signature-verified inbound webhook. Exports
 * TwilioWhatsappClientService so SkillsModule's RealSkillExecutor can use the
 * same single instance rather than standing up its own — mirrors
 * SupportModule/ChatwootClientService exactly.
 */
@Module({
  // Leaf ingest module, not EventsModule — Events imports Skills, and Skills
  // imports THIS module for the shared Twilio client, so importing Events
  // here would close a cycle (same reasoning as SupportModule).
  imports: [CanonicalIngestModule],
  controllers: [WhatsappWebhookController],
  providers: [WhatsappEngineAdapter, TwilioWhatsappClientService],
  exports: [TwilioWhatsappClientService],
})
export class WhatsappModule {}
```

- [ ] **Step 2: Wire into `skills.module.ts`**

Modify `apps/api/src/modules/skills/skills.module.ts`: add `WhatsappModule` to the `imports` array
(alongside `SupportModule`/`MarketingModule`), matching the exact line already there for those two.

- [ ] **Step 3: Verify the app boots**

Run: `cd apps/api && npx nest build` (or start `pnpm dev` briefly and check for DI errors in the log)
Expected: no `Nest can't resolve dependencies` errors mentioning `WhatsappEngineAdapter`,
`TwilioWhatsappClientService`, or `WhatsappWebhookController`.

- [ ] **Step 4: Commit**

```bash
git add apps/api/src/modules/engines/whatsapp/whatsapp.module.ts apps/api/src/modules/skills/skills.module.ts
git commit -m "feat(whatsapp): add WhatsappModule, wire into SkillsModule"
```

---

## Task 9: `whatsapp` skill catalog entry

**Files:**
- Modify: `apps/api/src/modules/skills/catalog.ts`

**Interfaces:**
- Produces: a new catalog entry, `key: 'whatsapp'`, with 3 tools whose names match Task 5's
  `tools()` declaration exactly (`whatsapp.send_message`, `whatsapp.send_template`,
  `whatsapp.get_conversation`) and Task 10's `RealSkillExecutor` case labels.

- [ ] **Step 1: Add the catalog entry**

In `apps/api/src/modules/skills/catalog.ts`, add a new entry to the exported catalog array (following
the exact shape of the `stripe`/`hubspot` entries already in the file):

```typescript
{
  key: 'whatsapp',
  name: 'WhatsApp (Twilio)',
  description: 'Send and receive WhatsApp Business messages via Twilio for lead qualification and sales outreach.',
  category: 'sales',
  connection: { type: 'api_key', label: 'Connect WhatsApp (Twilio)' },
  configSchema: [
    { key: 'twilioAccountSid', label: 'Twilio Account SID', type: 'string', placeholder: 'ACxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx' },
    { key: 'twilioAuthToken', label: 'Twilio Auth Token', type: 'string', secret: true, help: 'Stored encrypted-at-rest; never returned in responses.' },
    { key: 'whatsappSenderNumber', label: 'WhatsApp sender number', type: 'string', placeholder: '+15550001111', help: 'The approved WhatsApp Business number this company sends from, in E.164 format.' },
  ],
  tools: [
    {
      name: 'send_message',
      description: 'Send a free-form WhatsApp reply. Only works within 24 hours of the lead\'s last inbound message.',
      // Sends a real, irreversible, customer-facing message — same risk class as postiz.publish_now.
      highRisk: true,
      parameters: {
        type: 'object',
        properties: {
          leadId: { type: 'string', description: 'The Lead id to reply to.' },
          content: { type: 'string', description: 'The message text to send.' },
        },
        required: ['leadId', 'content'],
      },
    },
    {
      name: 'send_template',
      description: 'Send a pre-approved WhatsApp template message. Works any time, including outside the 24-hour window.',
      highRisk: true,
      parameters: {
        type: 'object',
        properties: {
          leadId: { type: 'string', description: 'The Lead id to message.' },
          templateId: { type: 'string', description: 'The Twilio Content SID of the approved template (starts with HX).' },
          params: { type: 'object', description: 'Template variable substitutions, e.g. {"1": "March 25"}.' },
        },
        required: ['leadId', 'templateId'],
      },
    },
    {
      name: 'get_conversation',
      description: 'Read the full WhatsApp message history for a lead.',
      parameters: {
        type: 'object',
        properties: {
          leadId: { type: 'string', description: 'The Lead id.' },
        },
        required: ['leadId'],
      },
    },
  ],
},
```

- [ ] **Step 2: Verify the catalog is still valid**

Run: `npx jest --config ./test/jest-unit.json catalog` (from `apps/api` — runs whatever existing
catalog-validation spec covers `skills/catalog.ts`; find its exact filename with
`find apps/api/src/modules/skills -iname "*catalog*spec*"` if this glob doesn't match)
Expected: PASS — no duplicate `key`, no malformed `parameters` schema.

- [ ] **Step 3: Commit**

```bash
git add apps/api/src/modules/skills/catalog.ts
git commit -m "feat(whatsapp): add whatsapp skill to the catalog"
```

---

## Task 10: `RealSkillExecutor` — wire the 3 `whatsapp.*` tools

**Files:**
- Modify: `apps/api/src/modules/skills/executors/real-skill-executor.ts`
- Modify: `apps/api/src/modules/skills/executors/real-skill-executor.spec.ts`

**Interfaces:**
- Consumes: `TwilioWhatsappClientService` (Task 4), `ToolIdempotencyService` (existing, same M-06
  pattern `postizSchedulePost` uses), `WHATSAPP_SESSION_WINDOW_MS` (Task 3).
- Produces: `case 'whatsapp.send_message'`, `case 'whatsapp.send_template'`,
  `case 'whatsapp.get_conversation'` in the executor's switch — consumed by the workflow engine's
  TOOL_ACTION nodes (Task 12) and chat tool-calling.

- [ ] **Step 1: Write the failing tests**

Add to `real-skill-executor.spec.ts`, following the exact setup pattern the existing `describe('postiz.schedule_post', ...)` block uses (mocked `prisma`, mocked client, real `RealSkillExecutor` instance):

```typescript
describe('RealSkillExecutor — whatsapp.*', () => {
  describe('whatsapp.send_message', () => {
    it('refuses to send outside the 24-hour session window', async () => {
      const prisma = {
        lead: {
          findFirst: jest.fn().mockResolvedValue({
            id: 'lead_1',
            companyId: 'c_1',
            phone: '+15550002222',
            conversation: { messages: [{ role: 'USER', createdAt: new Date(Date.now() - 25 * 60 * 60_000) }] },
          }),
        },
        whatsAppAccount: {
          findFirst: jest.fn().mockResolvedValue({ twilioAccountSid: 'AC1', twilioAuthToken: 'enc-token', whatsappSenderNumber: '+19990000000' }),
        },
      };
      const twilioClient = { sendFreeform: jest.fn() };
      const crypto = { decrypt: jest.fn((v: string) => v) };
      const executor = new RealSkillExecutor(
        configMock, fallbackMock, schedulingMock, {} as any, prisma as any,
        chatwootClientMock, crypto as any, planeClientMock, idempotencyMock,
        suppressionMock, false, twilioClient as any,
      );

      const result = await executor.execute('whatsapp', 'send_message', { leadId: 'lead_1', content: 'hi' }, ctx);

      expect(result).toEqual({ ok: false, error: expect.stringContaining('24h') });
      expect(twilioClient.sendFreeform).not.toHaveBeenCalled();
    });

    it('sends within the window via TwilioWhatsappClientService', async () => {
      const prisma = {
        lead: {
          findFirst: jest.fn().mockResolvedValue({
            id: 'lead_1',
            companyId: 'c_1',
            phone: '+15550002222',
            conversation: { messages: [{ role: 'USER', createdAt: new Date() }] },
          }),
        },
        whatsAppAccount: {
          findFirst: jest.fn().mockResolvedValue({ twilioAccountSid: 'AC1', twilioAuthToken: 'enc-token', whatsappSenderNumber: '+19990000000' }),
        },
      };
      const twilioClient = { sendFreeform: jest.fn().mockResolvedValue({ sid: 'MM1', status: 'queued' }) };
      const crypto = { decrypt: jest.fn((v: string) => v) };
      const executor = new RealSkillExecutor(
        configMock, fallbackMock, schedulingMock, {} as any, prisma as any,
        chatwootClientMock, crypto as any, planeClientMock, idempotencyMock,
        suppressionMock, false, twilioClient as any,
      );

      const result = await executor.execute('whatsapp', 'send_message', { leadId: 'lead_1', content: 'hi' }, ctx);

      expect(result.ok).toBe(true);
      expect(twilioClient.sendFreeform).toHaveBeenCalledWith(
        expect.objectContaining({ to: '+15550002222', from: '+19990000000', body: 'hi' }),
      );
    });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx jest --config ./test/jest-unit.json real-skill-executor.spec.ts -t "whatsapp"` (from `apps/api`)
Expected: FAIL — `RealSkillExecutor`'s constructor does not yet accept a 12th `twilioClient` argument, and
`case 'whatsapp.send_message'` does not exist.

- [ ] **Step 3: Wire the constructor and the 3 tool methods**

Add `TwilioWhatsappClientService` as a new constructor parameter (after `planeClient`, before
`idempotency` — or wherever fits the existing ordering; the important thing is every existing test that
constructs this class directly needs its call sites updated with the new argument, so grep for `new
RealSkillExecutor(` across the test suite first and update every call site consistently):

```typescript
    /** Twilio WhatsApp REST wrapper for the 'whatsapp' sales skill (per-company encrypted credentials). */
    private readonly whatsappClient: TwilioWhatsappClientService,
```

Add to the tool switch (alongside the existing `case 'postiz.schedule_post'` etc.):

```typescript
        case 'whatsapp.send_message':
          return await this.whatsappSendMessage(args, ctx);
        case 'whatsapp.send_template':
          return await this.whatsappSendTemplate(args, ctx);
        case 'whatsapp.get_conversation':
          return await this.whatsappGetConversation(args, ctx);
```

Add the three private methods (near the `postiz.*` methods, following their exact structure —
company-scoped lookup, then the real call):

```typescript
  // --- whatsapp.* (Twilio WhatsApp REST wrapper; per-company encrypted credentials) ---

  private async whatsappSendMessage(
    args: Record<string, unknown>,
    ctx: ExecutorContext,
  ): Promise<SkillExecutionResult> {
    const leadId = str(args.leadId);
    const content = str(args.content);
    if (!leadId || !content) {
      return { ok: false, error: 'send_message requires leadId and content' };
    }
    const lead = await this.prisma.lead.findFirst({
      where: { id: leadId, companyId: ctx.companyId },
      include: { conversation: { include: { messages: { orderBy: { createdAt: 'desc' }, take: 1 } } } },
    });
    if (!lead) return { ok: false, error: 'Lead not found for this company' };

    const lastInbound = lead.conversation?.messages.find((m) => m.role === 'USER');
    const withinWindow =
      !!lastInbound && Date.now() - lastInbound.createdAt.getTime() <= WHATSAPP_SESSION_WINDOW_MS;
    if (!withinWindow) {
      return {
        ok: false,
        error: 'send_message refused: outside the 24h session window, use send_template instead',
      };
    }

    const account = await this.prisma.whatsAppAccount.findFirst({ where: { companyId: ctx.companyId } });
    if (!account) return { ok: false, error: 'No WhatsAppAccount configured for this company' };

    const result = await this.whatsappClient.sendFreeform({
      accountSid: account.twilioAccountSid,
      authToken: this.crypto.decrypt(account.twilioAuthToken),
      from: account.whatsappSenderNumber,
      to: lead.phone,
      body: content,
    });
    return { ok: true, result };
  }

  private async whatsappSendTemplate(
    args: Record<string, unknown>,
    ctx: ExecutorContext,
  ): Promise<SkillExecutionResult> {
    const leadId = str(args.leadId);
    const templateId = str(args.templateId);
    if (!leadId || !templateId) {
      return { ok: false, error: 'send_template requires leadId and templateId' };
    }
    const lead = await this.prisma.lead.findFirst({ where: { id: leadId, companyId: ctx.companyId } });
    if (!lead) return { ok: false, error: 'Lead not found for this company' };

    const account = await this.prisma.whatsAppAccount.findFirst({ where: { companyId: ctx.companyId } });
    if (!account) return { ok: false, error: 'No WhatsAppAccount configured for this company' };

    const params = (args.params as Record<string, string>) ?? {};
    const result = await this.whatsappClient.sendTemplate({
      accountSid: account.twilioAccountSid,
      authToken: this.crypto.decrypt(account.twilioAuthToken),
      from: account.whatsappSenderNumber,
      to: lead.phone,
      contentSid: templateId,
      contentVariables: params,
    });
    return { ok: true, result };
  }

  private async whatsappGetConversation(
    args: Record<string, unknown>,
    ctx: ExecutorContext,
  ): Promise<SkillExecutionResult> {
    const leadId = str(args.leadId);
    if (!leadId) return { ok: false, error: 'get_conversation requires leadId' };
    const lead = await this.prisma.lead.findFirst({
      where: { id: leadId, companyId: ctx.companyId },
      include: { conversation: { include: { messages: { orderBy: { createdAt: 'asc' } } } } },
    });
    if (!lead) return { ok: false, error: 'Lead not found for this company' };
    return { ok: true, result: { messages: lead.conversation?.messages ?? [] } };
  }
```

Add the import: `import { TwilioWhatsappClientService } from '../../engines/whatsapp/twilio-whatsapp-client.service';`
and `import { WHATSAPP_SESSION_WINDOW_MS } from '../../engines/whatsapp/whatsapp.constants';`

**Note for the implementer:** `send_message`/`send_template` are real, irreversible, external side
effects — the same risk class `postiz.schedule_post` is in. Check whether the existing `M-06`
`ToolIdempotencyService.runIdempotent` wrapping (see `postizSchedulePost`'s exact usage) should apply
here too, so a retried TOOL_ACTION cannot double-send a WhatsApp message to a real lead. This was left
out of the Step 3 code above to keep the task's first pass focused — raise it explicitly at review; if
the reviewer agrees it's needed (very likely, given the codebase's own M-06 precedent), that's a fix-loop
addition, not a missed requirement invented after the fact.

- [ ] **Step 4: Update `skills.module.ts`'s `makeReal()` factory**

In `skills.module.ts`, add `twilioWhatsappClient` to the `makeReal` factory's dependency list and its
call to `new RealSkillExecutor(...)`, matching exactly how `postizClient`/`chatwootClient`/`planeClient`
are already threaded through (inject `TwilioWhatsappClientService` the same way, add it to the
`inject: [...]` array on the `SKILL_EXECUTOR_TOKEN` provider).

- [ ] **Step 5: Run tests to verify they pass**

Run: `npx jest --config ./test/jest-unit.json real-skill-executor.spec.ts -v`
Expected: PASS, including every pre-existing test in this file (constructor signature change must not
break any of them — this is why Step 3 said to grep every call site).

- [ ] **Step 6: Commit**

```bash
git add apps/api/src/modules/skills/executors/real-skill-executor.ts apps/api/src/modules/skills/executors/real-skill-executor.spec.ts apps/api/src/modules/skills/skills.module.ts
git commit -m "feat(whatsapp): wire whatsapp.send_message/send_template/get_conversation into RealSkillExecutor"
```

---

## Task 11: Workflow template — `sales.whatsapp-lead-qualify`

**Files:**
- Create: `apps/api/src/modules/workflow-templates/sales-workflow-templates.catalog.ts`
- Modify: `apps/api/src/modules/workflow-templates/workflow-templates.catalog.ts` (aggregator)

**Interfaces:**
- Consumes: the frozen-17 node vocabulary, `whatsapp.send_template` (Task 9/10), the `SALES`
  `EmployeeRole` (already exists in the schema — confirmed during design, no migration needed).
- Produces: `SALES_WORKFLOW_TEMPLATES`, registered in the boot-seeded aggregator.

- [ ] **Step 1: Write the template catalog file**

```typescript
import type { WorkflowTemplateManifest } from '@vaep/types';

/**
 * First-party Sales workflow templates. Frozen-17 vocabulary only
 * (AI_EMPLOYEE_STEP + TOOL_ACTION), same discipline the Marketing/HR
 * templates follow. The qualification AI_EMPLOYEE_STEP runs with no tools
 * (disableTools:true is unconditional in ai-employee-step.handler.ts — not a
 * template config, just how the node type works) — it can only recommend, not
 * act; every side effect (the sales-team notify, the nurture template send)
 * is an explicit, separately-gated TOOL_ACTION.
 */
export const SALES_WORKFLOW_TEMPLATES: readonly WorkflowTemplateManifest[] = [
  {
    key: 'sales.whatsapp-lead-qualify',
    version: 1,
    name: 'Sales: WhatsApp lead qualification',
    description:
      'A Sales AI Employee qualifies an inbound WhatsApp lead (budget/need/timeline) and either notifies the sales team for a hot lead or sends a nurture follow-up template.',
    category: 'SALES',
    parameters: [
      { key: 'salesEmployee', label: 'Sales AI Employee', type: 'string', required: true, binds: 'employee', help: 'AI Employee (role SALES) that qualifies the lead.' },
      { key: 'nurtureTemplateId', label: 'Nurture template (Twilio Content SID)', type: 'string', required: true, help: 'Pre-approved WhatsApp template to send a lead that is not yet hot.' },
    ],
    requires: { skills: ['whatsapp'], employeeRoles: ['SALES'], minPlan: 'BUSINESS' },
    definition: {
      nodes: [
        { id: 'trigger', type: 'TRIGGER', name: 'New WhatsApp lead', config: {} },
        { id: 'qualify', type: 'AI_EMPLOYEE_STEP', name: 'Qualify the lead', config: { employeeId: '{{param.salesEmployee}}', instruction: 'A new WhatsApp lead sent: "{{trigger.body}}". Assess budget, need and timeline from this message. Output a JSON object {"hot": true|false, "reason": string}.', outputKey: 'qualification' } },
        { id: 'isHot', type: 'CONDITION', name: 'Hot lead?', config: { left: '{{qualification.hot}}', op: 'eq', right: 'true' } },
        { id: 'notifySales', type: 'TOOL_ACTION', name: 'Notify the sales team', config: { skillKey: 'slack', tool: 'send_message', args: { channel: 'sales', text: 'Hot WhatsApp lead: {{trigger.phone}} — {{qualification.reason}}' } } },
        { id: 'nurture', type: 'TOOL_ACTION', name: 'Send nurture follow-up', config: { skillKey: 'whatsapp', tool: 'send_template', args: { leadId: '{{trigger.leadId}}', templateId: '{{param.nurtureTemplateId}}' } } },
        { id: 'doneHot', type: 'TERMINATE', name: 'Hot lead handed to sales', config: { status: 'COMPLETED', reason: 'Sales team notified.' } },
        { id: 'doneNurture', type: 'TERMINATE', name: 'Nurture sent', config: { status: 'COMPLETED', reason: 'Nurture follow-up sent.' } },
      ],
      edges: [
        { from: 'trigger', to: 'qualify' },
        { from: 'qualify', to: 'isHot' },
        { from: 'isHot', to: 'notifySales', branch: 'true' },
        { from: 'isHot', to: 'nurture', branch: 'false' },
        { from: 'notifySales', to: 'doneHot' },
        { from: 'nurture', to: 'doneNurture' },
      ],
    },
  },
];
```

Branching-edge field confirmed as `branch: 'true'/'false'` (verified against
`hr-workflow-templates.catalog.ts:36`'s real `{ from: 'hasCv', to: 'flagNoCv', branch: 'false' }` — not
`condition`, which was this plan's first guess before checking).

- [ ] **Step 2: Register in the aggregator**

In `apps/api/src/modules/workflow-templates/workflow-templates.catalog.ts`, import
`SALES_WORKFLOW_TEMPLATES` and spread it into the aggregated array alongside
`HR_WORKFLOW_TEMPLATES`/`MARKETING_WORKFLOW_TEMPLATES`, matching the exact existing pattern.

- [ ] **Step 3: Run the boot-seed validation test**

Run: `npx jest --config ./test/jest-unit.json workflow-templates.catalog.spec.ts -v` (from `apps/api`)
Expected: PASS — `validateManifest` accepts `sales.whatsapp-lead-qualify` (frozen-17 vocab, no
`DB_QUERY`, no inline secrets, no `APPROVAL` inside a `LOOP` — none of which this template has, but the
test is what proves it, not this description).

- [ ] **Step 4: Commit**

```bash
git add apps/api/src/modules/workflow-templates/sales-workflow-templates.catalog.ts apps/api/src/modules/workflow-templates/workflow-templates.catalog.ts
git commit -m "feat(whatsapp): add sales.whatsapp-lead-qualify workflow template"
```

---

## Task 12: Frontend — Leads feature

**Files:**
- Create: `apps/web/src/app/(app)/leads/page.tsx`
- Create: `apps/web/src/app/(app)/leads/[id]/page.tsx`
- Create: `apps/web/src/features/leads/api.ts`
- Create: `apps/web/src/features/leads/hooks.ts`
- Create: `apps/web/src/features/leads/schemas.ts`
- Create: `apps/web/src/features/leads/components/LeadsList.tsx`
- Create: `apps/web/src/features/leads/components/LeadDetail.tsx`

**Interfaces:**
- Consumes: whatever `GET /leads`/`GET /leads/:id` routes exist by this point — **this task assumes a
  `LeadsController` with these two routes exists**. If it does not yet (it isn't listed as a prior task in
  this plan — the backend Lead CRUD routes were an oversight in scoping and must be added as part of this
  task, following the exact `MarketingController`/`marketing.service.ts` list/detail pattern: `GET
  /leads` with `status`/`source` query filters, `GET /leads/:id` with the conversation included).

- [ ] **Step 1: Add the missing backend routes first**

Create `apps/api/src/modules/leads/leads.module.ts`, `leads.controller.ts`, `leads.service.ts` (a new
top-level module, not nested under `engines/whatsapp` — `Lead` is a shared entity per the design, so its
CRUD surface should not live under one channel's engine module). Mirror `marketing.controller.ts`'s
`listPosts`/`GET :id` pattern exactly: `@Get()` with `@Query('status')`/`@Query('source')`, `@Get(':id')`
returning the Lead with its `conversation.messages` included, both `@CurrentTenant() companyId`-scoped,
`@RequirePermission('leads:read')` (add this permission string following whatever convention
`marketing:read` established — check `RequirePermission`'s decorator source for whether permissions need
central registration).

- [ ] **Step 2: Write the frontend feature**

Follow `features/marketing/`'s exact file shape (`api.ts` — typed fetch wrappers; `hooks.ts` — TanStack
Query `useQuery`/`useMutation`; `schemas.ts` — zod schemas matching the backend DTOs; `components/` — the
list/detail UI) for `features/leads/`. `LeadsList.tsx` shows phone/name/status/source with a status
filter; `LeadDetail.tsx` shows the conversation thread (reusing whatever message-bubble component the
existing `/employees/[id]` chat view already has, rather than building a new one).

- [ ] **Step 3: Manual verification**

Start `pnpm dev` (from `apps/web` and `apps/api` per the platform's GOTCHA about running from the repo
root stripping env vars), navigate to `/leads`, confirm the empty state renders without error (no real
leads exist yet — that requires Task 13's live Twilio connection).

- [ ] **Step 4: Commit**

```bash
git add apps/api/src/modules/leads apps/web/src/app/\(app\)/leads apps/web/src/features/leads
git commit -m "feat(whatsapp): add Leads backend routes and frontend feature"
```

---

## Task 13: Frontend — WhatsApp Account connect screen

**Files:**
- Create: `apps/web/src/app/(app)/skills/whatsapp-connect/page.tsx` (or wherever the existing
  `/skills` catalog page's per-skill connect flow lives — check `features/skills/components/` for the
  existing `api_key`-type connection form used by e.g. Stripe, and reuse that generic component if one
  already exists rather than building a WhatsApp-specific form)

**Interfaces:**
- Consumes: the existing `PATCH /skills/installed/:id/config` + `POST /skills/installed/:id/connect`
  routes (already generic across every `api_key`-type skill per `docs/architecture/connector-event-workflow-architecture.md`
  §1.3) — **check first whether the existing generic Skill Config form already handles this** (Task 9's
  catalog entry uses the same `connection: { type: 'api_key' }` + `configSchema` shape every other
  api-key skill uses), in which case this task may already be DONE by Task 9 alone and this task reduces
  to verification only, not new frontend code.

- [ ] **Step 1: Verify whether the generic Skill Config UI already covers this**

Install the `whatsapp` skill via the existing `/skills` catalog page in a running dev instance, and
attempt to connect it using the 3 `configSchema` fields from Task 9. If the existing generic form renders
those 3 fields correctly and `POST /skills/installed/:id/connect` succeeds, **no new frontend code is
needed** — report this task as DONE_WITH_CONCERNS noting the design doc's "new frontend" assumption was
wrong, not a defect.

- [ ] **Step 2: If a gap is found, close it narrowly**

Only if Step 1 reveals a real gap (e.g. the generic form can't express "WhatsApp sender number" cleanly,
or `WhatsAppAccount` needs its own connect endpoint distinct from `InstalledSkill`'s because it's a
separate table, not a config blob on `InstalledSkill`) — this is a real open design question: **does
`WhatsAppAccount` connect through the generic `InstalledSkill.config`/`connect` flow, or does it need its
own `POST /engines/whatsapp/accounts` route** (mirroring how `ChatwootAccount`/`SocialAccount` are their
own tables, not `InstalledSkill` rows)? Resolve this by reading how Task 1's `WhatsAppAccount` model
relates to `InstalledSkill` — if there is no FK between them, the generic Skill Config flow cannot
populate `WhatsAppAccount` at all, and a dedicated connect endpoint + form is required. Flag this
explicitly in the task report; do not silently assume either answer.

- [ ] **Step 3: Commit**

```bash
git add -A
git commit -m "feat(whatsapp): WhatsApp account connect flow"
```
(Adjust the commit scope to whatever Step 1/2 actually produced — could be "no new files" if Step 1
found the generic flow already sufficient, in which case skip this commit.)

---

## Self-review notes (spec coverage)

- Spec §1 (Twilio choice) → grounded via live `twilio-webhook-architecture`/`twilio-whatsapp-send-message`
  skill lookups during this plan's own research (Tasks 4, 7 cite the exact SDK calls/signature scheme).
- Spec §2 (per-company tenancy) → Task 1 (`WhatsAppAccount` per-company), Task 4 (per-company resource key).
- Spec §3 (Lead entity, shared) → Task 1.
- Spec §4 (backend module) → Tasks 3-8.
- Spec §5 (skill tools + 24h window) → Tasks 9-10.
- Spec §6 (workflow template) → Task 11.
- Spec §7 (frontend) → Tasks 12-13.
- Spec §8 (security) → threaded through Task 7 (signature-before-write ordering) and Task 1 (encrypted
  credentials, companyId scoping) rather than a standalone task — this is a cross-cutting constraint, not
  a separable deliverable.
- **Real gap surfaced during this plan's own writing, not in the spec:** the spec's §7 assumed a plain
  "Leads screen" without noticing no backend `Lead` CRUD routes existed anywhere in the original design
  — Task 12 adds them as part of the frontend task rather than as a silently-missing dependency.
- **One genuine open question flagged for the implementer/reviewer rather than guessed at**, per the
  "no placeholders" rule's spirit (a wrong guess presented as fact is worse than a flagged unknown):
  Task 5's `handleWebhook`/controller URL-reconstruction split (`EngineAdapter.handleWebhook` can't
  cleanly own Twilio's signature check the way it owns Chatwoot's, since Twilio's scheme needs the full
  request URL, only available in the controller). Task 11's `CONDITION` branching-edge field was
  double-checked against `hr-workflow-templates.catalog.ts:36` during this plan's own writing and
  corrected from an initial wrong guess (`condition:`) to the real field (`branch:`) before this document
  was finalized — not left as an open question.
