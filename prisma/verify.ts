/**
 * NeoBank — database invariant checks.
 *
 * The core invariant of the whole domain: for every account,
 *     balancePaise === SUM(credits) - SUM(debits)
 * If that ever drifts, the dashboard and the ledger disagree about someone's
 * money, and every downstream consumer (AI assistant included) inherits the lie.
 *
 * Exits non-zero on drift so it can gate CI.
 *
 *   pnpm db:verify
 */

import 'dotenv/config';
import { PrismaClient } from '../generated/prisma/client';
import { PrismaPg } from '@prisma/adapter-pg';

const prisma = new PrismaClient({
  adapter: new PrismaPg({ connectionString: process.env.DATABASE_URL }),
});

const rupees = (paise: bigint) =>
  `₹${(Number(paise) / 100).toLocaleString('en-IN', { minimumFractionDigits: 2 })}`;

type Row = {
  accountNumber: string;
  ownerEmail: string;
  role: string;
  balancePaise: string;
  ledgerPaise: string;
  txnCount: number;
};

async function main() {
  const users = await prisma.user.findMany({
    select: { id: true, email: true, role: true, fullName: true, createdAt: true },
    orderBy: { createdAt: 'asc' },
  });

  console.log(`\nUsers (${users.length})`);
  for (const u of users) {
    console.log(`  ${u.role.padEnd(8)} ${u.email.padEnd(28)} ${u.fullName.padEnd(20)} ${u.id}`);
  }

  const rows = await prisma.$queryRaw<Row[]>`
    SELECT a."accountNumber"                                   AS "accountNumber",
           u.email                                             AS "ownerEmail",
           u.role::text                                        AS "role",
           a."balancePaise"::text                              AS "balancePaise",
           COALESCE(SUM(CASE WHEN t.type IN ('DEPOSIT','TRANSFER_IN')
                             THEN t."amountPaise"
                             ELSE -t."amountPaise" END), 0)::text AS "ledgerPaise",
           COUNT(t.id)::int                                    AS "txnCount"
    FROM "Account" a
    JOIN "User" u ON u.id = a."userId"
    LEFT JOIN "Transaction" t ON t."accountId" = a.id
    GROUP BY a.id, a."accountNumber", u.email, u.role, a."balancePaise"
    ORDER BY a."accountNumber";
  `;

  console.log(`\nAccounts (${rows.length})`);
  console.log(`  ${'ACCOUNT'.padEnd(14)}${'OWNER'.padEnd(28)}${'BALANCE'.padStart(16)}${'LEDGER'.padStart(16)}${'TXNS'.padStart(7)}`);

  const drifted: Row[] = [];
  let totalTxns = 0;

  for (const r of rows) {
    const balance = BigInt(r.balancePaise);
    const ledger = BigInt(r.ledgerPaise);
    const ok = balance === ledger;
    if (!ok) drifted.push(r);
    totalTxns += r.txnCount;
    console.log(
      `  ${r.accountNumber.padEnd(14)}${r.ownerEmail.padEnd(28)}` +
        `${rupees(balance).padStart(16)}${rupees(ledger).padStart(16)}` +
        `${String(r.txnCount).padStart(7)}  ${ok ? '✓' : '✗ DRIFT'}`,
    );
  }

  const negatives = rows.filter((r) => BigInt(r.balancePaise) < 0n);
  console.log(`\nTotal transactions: ${totalTxns}`);

  if (negatives.length) {
    console.error(`\n✗ ${negatives.length} account(s) with a NEGATIVE balance:`);
    for (const r of negatives) console.error(`    ${r.accountNumber}  ${rupees(BigInt(r.balancePaise))}`);
  }

  if (drifted.length) {
    console.error(`\n✗ LEDGER INTEGRITY FAILED — ${drifted.length} account(s) drifted:`);
    for (const r of drifted) {
      const delta = BigInt(r.balancePaise) - BigInt(r.ledgerPaise);
      console.error(`    ${r.accountNumber}  balance − ledger = ${rupees(delta)}`);
    }
  }

  if (drifted.length || negatives.length) process.exit(1);
  console.log('\n✓ ledger integrity holds for every account\n');
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
