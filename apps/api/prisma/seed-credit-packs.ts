/**
 * Credit system Phase 5, Task 5.1 — standalone ops/deploy convenience script.
 * Reuses the exact same idempotent upsert `CreditPackCatalogService.onModuleInit`
 * runs on every boot, so this script is a no-op in an environment that has
 * already booted at least once — never a required manual step, just an
 * explicit one for anyone who wants to seed ahead of first boot.
 *
 * Run: `npx ts-node prisma/seed-credit-packs.ts` (from `apps/api`).
 */
import { PrismaClient } from '@prisma/client';
import { seedCreditPacks } from '../src/modules/billing/credit-packs';

async function main(): Promise<void> {
  const prisma = new PrismaClient();
  try {
    const created = await seedCreditPacks(prisma as never);
    console.log(`seeded ${created} credit pack(s)`);
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
