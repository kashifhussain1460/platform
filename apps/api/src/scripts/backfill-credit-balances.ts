/**
 * Credit system Phase 11, Task 11.1 (§35.3 Option B / §35.7) — one-time
 * migration backfill: a `CompanyCreditBalance` row for every existing
 * company, plus a one-time "welcome to metering" grant sized at one
 * period's `includedCreditsPerMonth` for that company's current plan
 * (STARTER/ENTERPRISE have no recurring allotment — §7.9's "no recurring
 * free tier" rule — so those companies get a balance row with zero grant).
 *
 * Batched by companyId (500-row batches, matching Migration-05's
 * convention). Idempotent: the ledger append keys on
 * `migration-welcome:<companyId>`, so re-running is a safe no-op. Reuses
 * the REAL `CreditLedgerService.append()` (via a Nest application context,
 * not raw `psql`) rather than reimplementing its balance-math/locking
 * invariants here — this is financial data, and drift between two
 * implementations of the same math is exactly the risk to avoid.
 *
 * Run (from `apps/api`): `npx ts-node src/scripts/backfill-credit-balances.ts`
 *
 * ⚠️ Per this migration's own required rehearsal step (§35.7 verification
 * (c)): run this against a RESTORED STAGING/PRODUCTION SNAPSHOT first, never
 * directly against a live production database on the first attempt.
 */
import { NestFactory } from '@nestjs/core';
import { AppModule } from '../app.module';
import { PrismaService } from '../common/prisma/prisma.service';
import { CreditLedgerService } from '../modules/credits/credit-ledger.service';
import { PLAN_CATALOG } from '../modules/billing/billing.plans';

const BATCH_SIZE = 500;

async function main(): Promise<void> {
  const app = await NestFactory.createApplicationContext(AppModule, {
    logger: ['error', 'warn'],
  });
  const prisma = app.get(PrismaService);
  const ledger = app.get(CreditLedgerService);

  let cursor: string | undefined;
  let processed = 0;
  let granted = 0;
  let zeroGrant = 0;
  const errors: { companyId: string; message: string }[] = [];

  for (;;) {
    const subscriptions = await prisma.subscription.findMany({
      take: BATCH_SIZE,
      ...(cursor ? { skip: 1, cursor: { id: cursor } } : {}),
      orderBy: { id: 'asc' },
    });
    if (subscriptions.length === 0) break;

    for (const sub of subscriptions) {
      try {
        const amount = PLAN_CATALOG[sub.plan]?.includedCreditsPerMonth ?? 0;
        if (amount > 0) {
          await ledger.append({
            companyId: sub.companyId,
            transactionType: 'CREDIT',
            grantKind: 'PLAN_ALLOTMENT',
            amount,
            reason: `Migration welcome grant (§35.3 Option B) — one period's included credits for ${sub.plan}`,
            source: 'SYSTEM',
            idempotencyKey: `migration-welcome:${sub.companyId}`,
          });
          granted++;
        } else {
          // No recurring allotment for this plan (STARTER/ENTERPRISE) — still
          // create the balance row (self-heals to zero) so the row-count
          // invariant (Task 11.2) holds immediately, not only on first spend.
          await prisma.companyCreditBalance.upsert({
            where: { companyId: sub.companyId },
            create: { companyId: sub.companyId, balance: 0, reservedBalance: 0, updatedAt: new Date() },
            update: {},
          });
          zeroGrant++;
        }
        processed++;
      } catch (err) {
        errors.push({
          companyId: sub.companyId,
          message: err instanceof Error ? err.message : String(err),
        });
      }
    }
    cursor = subscriptions[subscriptions.length - 1].id;
  }

  console.log(
    `Backfill complete: ${processed} companies processed (${granted} granted, ${zeroGrant} zero-grant balance-only), ${errors.length} error(s).`,
  );
  for (const e of errors) {
    console.error(`  ERROR company ${e.companyId}: ${e.message}`);
  }

  await app.close();
  if (errors.length > 0) process.exit(1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
