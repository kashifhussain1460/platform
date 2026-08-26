/**
 * LOCAL DEV DATABASE reset — deletes every Company (cascades to ~37 related
 * tables: Users, Subscriptions, AiEmployees, Workflows, WorkflowRuns,
 * AuditLogs, CompanyCreditBalance, etc. — anything with `onDelete: Cascade`
 * on its Company relation), plus the credit-system tables that are
 * DELIBERATELY not FK'd to Company (so a company delete does NOT clean
 * them up on its own): CreditLedger, CreditReservation,
 * CreditUsageDailyRollup, ReconciliationRun/Discrepancy, ProviderInvoice —
 * and PlatformOperator (a fully separate identity, no Company relation at
 * all).
 *
 * Verified before writing this: every company in this DB (oldest row is
 * 2026-08-16, newest today) has a recognizable e2e-fixture name
 * ("Design QA Co", "Credits P10 ...", "PM Test Co", etc.) — no user or
 * company anywhere matches "kashif" (checked both `User.email`/`.name` and
 * `Company.name`). This script is for the LOCAL Docker Postgres
 * (`localhost:5433/vaep`) this repo's own e2e suite runs against, not any
 * shared/staging/production database.
 *
 * Run (from `apps/api`): `npx ts-node prisma/dev-cleanup-all.ts`
 * ⚠️ Irreversible. Point DATABASE_URL at a throwaway/local DB before running.
 */
import { PrismaClient } from '@prisma/client';

async function main(): Promise<void> {
  const prisma = new PrismaClient();
  try {
    // Standalone credit-system tables (no FK to Company, so a Company
    // delete would silently leave these behind).
    const discrepancies = await prisma.reconciliationDiscrepancy.deleteMany({});
    const runs = await prisma.reconciliationRun.deleteMany({});
    const invoices = await prisma.providerInvoice.deleteMany({});
    const rollups = await prisma.creditUsageDailyRollup.deleteMany({});
    const reservations = await prisma.creditReservation.deleteMany({});
    const ledger = await prisma.creditLedger.deleteMany({});

    // Company cascades to every tenant-scoped table (Users, Subscriptions,
    // AiEmployees, Conversations, Messages, Workflows, WorkflowRuns,
    // AuditLogs, CompanyCreditBalance, InstalledSkills, ... — every model
    // with `onDelete: Cascade` on its Company relation).
    const companies = await prisma.company.deleteMany({});

    // A fully separate identity axis — never touched by the Company cascade.
    const operators = await prisma.platformOperator.deleteMany({});

    console.log('Dev DB cleanup complete:');
    console.log(`  ReconciliationDiscrepancy: ${discrepancies.count}`);
    console.log(`  ReconciliationRun:         ${runs.count}`);
    console.log(`  ProviderInvoice:           ${invoices.count}`);
    console.log(`  CreditUsageDailyRollup:    ${rollups.count}`);
    console.log(`  CreditReservation:         ${reservations.count}`);
    console.log(`  CreditLedger:              ${ledger.count}`);
    console.log(`  Company (cascaded):        ${companies.count}`);
    console.log(`  PlatformOperator:          ${operators.count}`);
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
