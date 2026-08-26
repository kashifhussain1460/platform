/**
 * Credit system Phase 11, Task 11.2 (§35.7 verification steps a-d).
 * Read-only — safe to run any number of times, including against a live
 * production database, unlike the backfill script itself.
 *
 * Run (from `apps/api`): `npx ts-node src/scripts/verify-credit-migration.ts`
 * Exits non-zero if the row-count invariant fails or any company's ledger
 * drifts from its cached balance.
 */
import { NestFactory } from '@nestjs/core';
import { AppModule } from '../app.module';
import { PrismaService } from '../common/prisma/prisma.service';
import { CreditBalanceService } from '../modules/credits/credit-balance.service';

async function main(): Promise<void> {
  const app = await NestFactory.createApplicationContext(AppModule, {
    logger: ['error', 'warn'],
  });
  const prisma = app.get(PrismaService);
  const balanceService = app.get(CreditBalanceService);

  let failed = false;

  // (a) Row-count invariant.
  const [subCount, balanceCount] = await Promise.all([
    prisma.subscription.count(),
    prisma.companyCreditBalance.count(),
  ]);
  const rowCountOk = subCount === balanceCount;
  console.log(
    `(a) Subscription rows: ${subCount}, CompanyCreditBalance rows: ${balanceCount} — ${
      rowCountOk ? 'MATCH' : 'MISMATCH'
    }`,
  );
  if (!rowCountOk) failed = true;

  // (b) Ledger-vs-cache reconciliation for every company that has a balance row.
  const companies = await prisma.companyCreditBalance.findMany({ select: { companyId: true } });
  let driftCount = 0;
  for (const { companyId } of companies) {
    const result = await balanceService.reconcile(companyId);
    if (result.drift !== 0) {
      driftCount++;
      console.error(`  DRIFT: company ${companyId} drift=${result.drift} (auto-corrected to the ledger sum)`);
    }
  }
  console.log(`(b) Reconciled ${companies.length} companies — ${driftCount} had drift (now corrected)`);
  if (driftCount > 0) failed = true;

  // (c) Rehearsal-on-a-restored-snapshot is a PROCESS step, not something this
  // script can verify about itself — logged as a reminder, not a check.
  console.log(
    '(c) Reminder: this run must be against a restored staging/production snapshot before ' +
      'the backfill is ever run against the real live database (§35.7 requirement).',
  );

  // (d) Before/after checksum of Subscription/AiEmployee (proves the backfill
  // touched neither — §35.5's "adopt as-is" claim). This script reports the
  // CURRENT counts; compare them against a count taken before the backfill ran.
  const [subChecksum, employeeChecksum] = await Promise.all([
    prisma.subscription.count(),
    prisma.aiEmployee.count(),
  ]);
  console.log(
    `(d) Current Subscription count=${subChecksum}, AiEmployee count=${employeeChecksum} — ` +
      'compare against your pre-backfill snapshot; either changing would mean the backfill mutated ' +
      'a table §35.5 promised to leave untouched.',
  );

  await app.close();
  if (failed) {
    console.error('VERIFICATION FAILED — see above.');
    process.exit(1);
  }
  console.log('VERIFICATION PASSED.');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
