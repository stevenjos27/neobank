/**
 * NeoBank — purge Playwright test residue.
 *
 * Every e2e run registers a throwaway user and never removes it. Against a
 * disposable CI database that is harmless; against your dev database it
 * accumulates forever and poisons every consumer downstream — the admin
 * portal's user list, the AI assistant's retrieval corpus, the eval harness.
 *
 * Scope is deliberately narrow: ONLY users whose email matches the e2e
 * pattern. It will refuse to touch anything else. Deletion order respects
 * the foreign keys (no onDelete: Cascade is declared in the schema).
 *
 * This module has NO side effects on import. Two entry points:
 *   - default export  → Playwright globalTeardown (called with no args)
 *   - cleanTestData() → reuse inside a test that already holds a client
 * The CLI lives in prisma/clean.ts (`pnpm db:clean`).
 */

import 'dotenv/config';
import { PrismaClient } from '../generated/prisma/client';
import { PrismaPg } from '@prisma/adapter-pg';

/**
 * Every test user lives on this domain. Matching a DOMAIN rather than a list of
 * prefixes is what makes this safe: a new spec cannot forget to opt in without
 * also failing to look like a test user, and no real account can ever collide.
 * Demo seed users (admin@/steven@/priya@neobank.test) are NOT on it and survive.
 */
const E2E_EMAIL_DOMAIN = '@e2e.neobank.test';

/** Purge e2e users using a client the caller owns. Returns users deleted. */
export async function cleanTestData(prisma: PrismaClient): Promise<number> {
  const victims = await prisma.user.findMany({
    where: { email: { endsWith: E2E_EMAIL_DOMAIN } },
    select: { id: true, accounts: { select: { id: true } } },
  });

  if (victims.length === 0) {
    console.log('✓ nothing to purge — no e2e users found');
    return 0;
  }

  const userIds = victims.map((u) => u.id);
  const accountIds = victims.flatMap((u) => u.accounts.map((a) => a.id));

  // Order matters: no cascade is declared, so children go first.
  const txns = await prisma.transaction.deleteMany({ where: { accountId: { in: accountIds } } });
  const payees = await prisma.payee.deleteMany({ where: { userId: { in: userIds } } });
  const accounts = await prisma.account.deleteMany({ where: { id: { in: accountIds } } });
  const users = await prisma.user.deleteMany({ where: { id: { in: userIds } } });

  console.log(
    `✓ purged ${users.count} e2e users · ${accounts.count} accounts · ` +
    `${txns.count} transactions · ${payees.count} payees`,
  );
  return users.count;
}

/**
 * Owns its own client and closes it. This is the default export so that
 * Playwright can use this file directly as globalTeardown:
 *
 *   // apps/web-e2e/playwright.config.ts
 *   globalTeardown: require.resolve('../../prisma/clean-test-data.ts'),
 */
export default async function runCleanup(): Promise<number> {
  const prisma = new PrismaClient({
    adapter: new PrismaPg({ connectionString: process.env.DATABASE_URL }),
  });
  try {
    return await cleanTestData(prisma);
  } finally {
    await prisma.$disconnect();
  }
}
