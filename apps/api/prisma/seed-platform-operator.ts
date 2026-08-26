/**
 * Credit system Phase 10, Task 10.1 — out-of-band `PlatformOperator`
 * provisioning (mirrors `ENCRYPTION_KEY`'s provisioning story). This is the
 * ONLY way a `PlatformOperator` row is ever created or given a token — there
 * is no HTTP endpoint that can do either, by design (§31.5/§32.3: no company
 * OWNER can ever reach this power).
 *
 * Run: `PLATFORM_ADMIN_JWT_SECRET=<secret> npx ts-node prisma/seed-platform-operator.ts <email> <name>`
 * (from `apps/api`). Prints the minted token to stdout ONCE — copy it
 * somewhere safe; re-running mints a fresh token (the intended rotation
 * path) but does not invalidate the old one before its 365-day expiry.
 */
import { PrismaClient } from '@prisma/client';
import { JwtService } from '@nestjs/jwt';
import { PLATFORM_ADMIN_AUDIENCE } from '../src/modules/billing/platform-admin/platform-admin-auth.service';

async function main(): Promise<void> {
  const [email, name] = process.argv.slice(2);
  if (!email || !name) {
    console.error('Usage: seed-platform-operator.ts <email> <name>');
    process.exit(1);
  }
  const secret = process.env.PLATFORM_ADMIN_JWT_SECRET;
  if (!secret) {
    console.error('PLATFORM_ADMIN_JWT_SECRET must be set in the environment.');
    process.exit(1);
  }

  const prisma = new PrismaClient();
  try {
    const operator = await prisma.platformOperator.upsert({
      where: { email },
      create: { email, name },
      update: { name, status: 'ACTIVE' },
    });

    const jwt = new JwtService();
    const token = await jwt.signAsync(
      { sub: operator.id, aud: PLATFORM_ADMIN_AUDIENCE },
      { secret, expiresIn: '365d' },
    );

    console.log(`Platform operator: ${operator.email} (${operator.id})`);
    console.log(`Token (store securely, printed once):\n${token}`);
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
