/**
 * NeoBank — deterministic seed.
 *
 * Guarantees:
 *  - Idempotent: running twice leaves the database in an identical state.
 *  - Deterministic: a seeded PRNG drives every amount and merchant choice,
 *    so the same data appears on every machine and every run.
 *  - Ledger-consistent: Account.balancePaise is FOLDED from the transactions,
 *    never authored independently. No account is ever overdrawn.
 *  - Emits prisma/.seed-facts.json — ground truth for the Phase 3 eval harness,
 *    computed here, by the generator, independently of any query the app runs.
 *
 * Money is always paise (BigInt). Never floats.
 */

import * as argon2 from 'argon2';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';

// --- CLIENT SETUP ---------------------------------------------------------
// Mirrors apps/api/src/prisma/prisma.service.ts — Prisma 7 uses a driver adapter.
import 'dotenv/config';
import { PrismaClient } from '../generated/prisma/client';
import { PrismaPg } from '@prisma/adapter-pg';

const prisma = new PrismaClient({
  adapter: new PrismaPg({ connectionString: process.env.DATABASE_URL }),
});
// -------------------------------------------------------------------------

// ---------- deterministic PRNG (mulberry32) ----------
function mulberry32(seed: number) {
  return function rng(): number {
    seed |= 0;
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const rng = mulberry32(20260824);
const randInt = (min: number, max: number) => min + Math.floor(rng() * (max - min + 1));
const pick = <T>(xs: readonly T[]): T => xs[Math.floor(rng() * xs.length)];

// ---------- fixed identifiers (so upserts are stable) ----------
const ID = {
  adminUser: '00000000-0000-4000-8000-000000000001',
  stevenUser: '00000000-0000-4000-8000-000000000002',
  priyaUser: '00000000-0000-4000-8000-000000000003',
  adminSavings: '00000000-0000-4000-8000-000000000101',
  stevenSavings: '00000000-0000-4000-8000-000000000102',
  stevenCurrent: '00000000-0000-4000-8000-000000000103',
  priyaSavings: '00000000-0000-4000-8000-000000000104',
  payeePriya: '00000000-0000-4000-8000-000000000201',
  payeeAsha: '00000000-0000-4000-8000-000000000202',
} as const;

const DEMO_PASSWORD = 'Demo@12345';
const MONTHS_OF_HISTORY = 6;

/** Single-branch bank: one IFSC identifies NeoBank. Must match the API's BANK_IFSC. */
const BANK_IFSC = (process.env.BANK_IFSC ?? 'NEOB0000001').toUpperCase();

// ---------- merchants: realistic, uncategorised on purpose ----------
// No `category` field exists and none is seeded. Step 2's enrichment
// pipeline derives categories from these strings — that is the AI feature.
const MERCHANTS = [
  { label: 'SWIGGY*ORDER', min: 18000, max: 92000 },
  { label: 'ZOMATO ONLINE ORDER', min: 22000, max: 88000 },
  { label: 'BIGBASKET GROCERIES', min: 85000, max: 420000 },
  { label: 'RELIANCE FRESH ANDHERI', min: 45000, max: 310000 },
  { label: 'AMAZON PAY INDIA', min: 39900, max: 649900 },
  { label: 'UBER INDIA TRIP', min: 12000, max: 78000 },
  { label: 'IRCTC RAIL TICKET', min: 45000, max: 285000 },
  { label: 'NETFLIX SUBSCRIPTION', min: 64900, max: 64900 },
  { label: 'AIRTEL POSTPAID BILL', min: 79900, max: 129900 },
  { label: 'TATA POWER ELECTRICITY', min: 118000, max: 340000 },
  { label: 'PVR CINEMAS PHOENIX', min: 38000, max: 142000 },
  { label: 'INDIAN OIL PETROL PUMP', min: 150000, max: 400000 },
  { label: 'CROMA ELECTRONICS', min: 249900, max: 1899900 },
  { label: 'DECATHLON SPORTS', min: 89900, max: 549900 },
] as const;

const ATM = ['ATM WDL SBI ANDHERI W', 'ATM WDL HDFC POWAI', 'ATM WDL ICICI BKC'] as const;

type PlannedTxn = {
  accountId: string;
  type: 'DEPOSIT' | 'WITHDRAWAL' | 'TRANSFER_IN' | 'TRANSFER_OUT';
  amountPaise: bigint;
  description: string;
  createdAt: Date;
};

// ---------- date helpers: window slides with the calendar ----------
const now = new Date();
const monthStart = (monthsAgo: number) =>
  new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - monthsAgo, 1, 0, 0, 0));

function dayIn(monthsAgo: number, day: number, hour = 10): Date {
  const base = monthStart(monthsAgo);
  const daysInMonth = new Date(
    Date.UTC(base.getUTCFullYear(), base.getUTCMonth() + 1, 0),
  ).getUTCDate();
  const d = new Date(
    Date.UTC(base.getUTCFullYear(), base.getUTCMonth(), Math.min(day, daysInMonth), hour, randInt(0, 59)),
  );
  // never emit a future-dated transaction in the current month
  return d > now ? new Date(now.getTime() - randInt(1, 72) * 3600_000) : d;
}

// ---------- generation ----------
function generateForAccount(opts: {
  accountId: string;
  openingPaise: bigint;
  salaryPaise: bigint | null;
  salaryLabel: string;
  spendsPerMonth: [number, number];
}): PlannedTxn[] {
  const out: PlannedTxn[] = [];

  out.push({
    accountId: opts.accountId,
    type: 'DEPOSIT',
    amountPaise: opts.openingPaise,
    description: 'OPENING DEPOSIT',
    createdAt: new Date(monthStart(MONTHS_OF_HISTORY).getTime() - 86_400_000),
  });

  for (let m = MONTHS_OF_HISTORY - 1; m >= 0; m--) {
    if (opts.salaryPaise) {
      out.push({
        accountId: opts.accountId,
        type: 'DEPOSIT',
        amountPaise: opts.salaryPaise,
        description: opts.salaryLabel,
        createdAt: dayIn(m, randInt(1, 2), 6),
      });
    }
    const n = randInt(opts.spendsPerMonth[0], opts.spendsPerMonth[1]);
    for (let i = 0; i < n; i++) {
      const merchant = pick(MERCHANTS);
      out.push({
        accountId: opts.accountId,
        type: 'WITHDRAWAL',
        amountPaise: BigInt(randInt(merchant.min, merchant.max)),
        description: `${merchant.label} ${randInt(100000, 999999)}`,
        createdAt: dayIn(m, randInt(2, 28), randInt(8, 22)),
      });
    }
    if (rng() > 0.35) {
      out.push({
        accountId: opts.accountId,
        type: 'WITHDRAWAL',
        amountPaise: BigInt(randInt(2, 10) * 100000),
        description: pick(ATM),
        createdAt: dayIn(m, randInt(3, 26), randInt(9, 20)),
      });
    }
  }
  return out;
}

/** Paired transfer legs. No transferId exists in the schema (yet) — the
 *  counterparty survives only as text. Step 3 will have to reckon with that. */
function transferPair(from: {
  id: string; name: string; acct: string;
}, to: {
  id: string; name: string; acct: string;
}, amountPaise: bigint, when: Date): PlannedTxn[] {
  const mask = (a: string) => `…${a.slice(-4)}`;
  return [
    {
      accountId: from.id,
      type: 'TRANSFER_OUT',
      amountPaise,
      description: `Transfer to ${to.name} (${mask(to.acct)})`,
      createdAt: when,
    },
    {
      accountId: to.id,
      type: 'TRANSFER_IN',
      amountPaise,
      description: `Transfer from ${from.name} (${mask(from.acct)})`,
      createdAt: when,
    },
  ];
}

const CREDITS = new Set(['DEPOSIT', 'TRANSFER_IN']);

async function main() {
  console.log('→ seeding NeoBank…');
  const passwordHash = await argon2.hash(DEMO_PASSWORD);

  const users = [
    { id: ID.adminUser, email: 'admin@neobank.test', fullName: 'Asha Menon', role: 'ADMIN' as const },
    { id: ID.stevenUser, email: 'steven@neobank.test', fullName: 'Steven Joseph', role: 'CUSTOMER' as const },
    { id: ID.priyaUser, email: 'priya@neobank.test', fullName: 'Priya Nair', role: 'CUSTOMER' as const },
  ];

  // Upsert on the NATURAL key (email), not the surrogate id: a row with this
  // email may already exist under an id we didn't choose (hand-registered users).
  // Adopt it, and remember the id that actually won.
  const userIdByLogical = new Map<string, string>();
  for (const u of users) {
    const row = await prisma.user.upsert({
      where: { email: u.email },
      update: { fullName: u.fullName, role: u.role, passwordHash },
      create: { id: u.id, email: u.email, fullName: u.fullName, role: u.role, passwordHash },
    });
    if (row.id !== u.id) console.log(`  adopted existing user ${u.email} (id ${row.id})`);
    userIdByLogical.set(u.id, row.id);
  }

  const accounts = [
    { id: ID.adminSavings, userId: ID.adminUser, accountNumber: '900000000001', type: 'SAVINGS' as const },
    { id: ID.stevenSavings, userId: ID.stevenUser, accountNumber: '900000000002', type: 'SAVINGS' as const },
    { id: ID.stevenCurrent, userId: ID.stevenUser, accountNumber: '900000000003', type: 'CURRENT' as const },
    { id: ID.priyaSavings, userId: ID.priyaUser, accountNumber: '900000000004', type: 'SAVINGS' as const },
  ];

  // Same rule: accountNumber is the natural key.
  const acctIdByLogical = new Map<string, string>();
  for (const a of accounts) {
    const ownerId = userIdByLogical.get(a.userId)!;
    const row = await prisma.account.upsert({
      where: { accountNumber: a.accountNumber },
      update: { type: a.type, userId: ownerId },
      create: {
        id: a.id, accountNumber: a.accountNumber, type: a.type,
        userId: ownerId, balancePaise: 0n, currency: 'INR',
      },
    });
    if (row.id !== a.id) console.log(`  adopted existing account ${a.accountNumber} (id ${row.id})`);
    acctIdByLogical.set(a.id, row.id);
  }
  const realAcctId = (logical: string) => acctIdByLogical.get(logical)!;

  // Payees key on the compound unique (userId, accountNumber) — the natural key.
  // Keying on the surrogate id would hit P2002 the moment a payee for the same
  // pair already exists under an id we didn't choose (e.g. one added via the API).
  //
  // `update` is no longer empty: a payee's `name` is meant to be the name the
  // bank VERIFIED, so if it has drifted the seed corrects it, exactly as the
  // user upsert corrects fullName and role.
  const stevenId = userIdByLogical.get(ID.stevenUser)!;

  await prisma.payee.upsert({
    where: { userId_accountNumber: { userId: stevenId, accountNumber: '900000000004' } },
    update: { name: 'Priya Nair', ifsc: BANK_IFSC },
    create: {
      id: ID.payeePriya, userId: stevenId,
      name: 'Priya Nair', accountNumber: '900000000004', ifsc: BANK_IFSC,
    },
  });

  await prisma.payee.upsert({
    where: { userId_accountNumber: { userId: stevenId, accountNumber: '900000000001' } },
    update: { name: 'Asha Menon', ifsc: BANK_IFSC },
    create: {
      id: ID.payeeAsha, userId: stevenId,
      name: 'Asha Menon', accountNumber: '900000000001', ifsc: BANK_IFSC,
    },
  });

  // ---- build the plan ----
  const planned: PlannedTxn[] = [
    ...generateForAccount({
      accountId: ID.stevenSavings, openingPaise: 45_000_00n,
      salaryPaise: 85_000_00n, salaryLabel: 'SALARY CREDIT — ACME TECHNOLOGIES',
      spendsPerMonth: [9, 15],
    }),
    ...generateForAccount({
      accountId: ID.stevenCurrent, openingPaise: 75_000_00n,
      salaryPaise: 40_000_00n, salaryLabel: 'NEFT CR — CLIENT INVOICE SETTLEMENT',
      spendsPerMonth: [3, 6],
    }),
    ...generateForAccount({
      accountId: ID.priyaSavings, openingPaise: 35_000_00n,
      salaryPaise: 62_000_00n, salaryLabel: 'SALARY CREDIT — NORTHWIND LABS',
      spendsPerMonth: [6, 11],
    }),
    ...generateForAccount({
      accountId: ID.adminSavings, openingPaise: 50_000_00n,
      salaryPaise: 95_000_00n, salaryLabel: 'SALARY CREDIT — NEOBANK LTD',
      spendsPerMonth: [3, 6],
    }),
  ];

  const steven = { id: ID.stevenSavings, name: 'Steven Joseph', acct: '900000000002' };
  const priya = { id: ID.priyaSavings, name: 'Priya Nair', acct: '900000000004' };
  for (let m = MONTHS_OF_HISTORY - 1; m >= 0; m--) {
    planned.push(...transferPair(steven, priya, BigInt(randInt(15, 60) * 100000), dayIn(m, randInt(5, 12), 11)));
    if (rng() > 0.5) {
      planned.push(...transferPair(priya, steven, BigInt(randInt(8, 30) * 100000), dayIn(m, randInt(15, 25), 17)));
    }
  }

  // ---- fold to balances, dropping any debit that would overdraw ----
  planned.sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime());
  const balance = new Map<string, bigint>(accounts.map((a) => [a.id, 0n]));
  const accepted: PlannedTxn[] = [];
  let skipped = 0;

  for (const t of planned) {
    const current = balance.get(t.accountId) ?? 0n;
    if (CREDITS.has(t.type)) {
      balance.set(t.accountId, current + t.amountPaise);
      accepted.push(t);
    } else if (current >= t.amountPaise) {
      balance.set(t.accountId, current - t.amountPaise);
      accepted.push(t);
    } else {
      skipped++; // would overdraw — a bank would decline it, so do we
    }
  }

  // ---- replace transactions for seeded accounts only ----
  // The plan was built with LOGICAL ids; translate to the ids that actually
  // won in the database before touching a single row.
  const seededAccountIds = accounts.map((a) => realAcctId(a.id));
  await prisma.transaction.deleteMany({ where: { accountId: { in: seededAccountIds } } });
  await prisma.transaction.createMany({
    data: accepted.map((t) => ({
      accountId: realAcctId(t.accountId), type: t.type,
      amountPaise: t.amountPaise, description: t.description, createdAt: t.createdAt,
    })),
  });

  for (const a of accounts) {
    await prisma.account.update({
      where: { id: realAcctId(a.id) },
      data: { balancePaise: balance.get(a.id) ?? 0n },
    });
  }

  // ---- ground truth for the eval harness ----
  const facts = {
    generatedAt: now.toISOString(),
    monthsOfHistory: MONTHS_OF_HISTORY,
    demoPassword: DEMO_PASSWORD,
    accounts: accounts.map((a) => {
      const mine = accepted.filter((t) => t.accountId === a.id);
      const byMonth: Record<string, { creditsPaise: string; debitsPaise: string; count: number }> = {};
      const byMerchant: Record<string, { totalPaise: string; count: number }> = {};
      for (const t of mine) {
        const key = `${t.createdAt.getUTCFullYear()}-${String(t.createdAt.getUTCMonth() + 1).padStart(2, '0')}`;
        const bucket = (byMonth[key] ??= { creditsPaise: '0', debitsPaise: '0', count: 0 });
        if (CREDITS.has(t.type)) bucket.creditsPaise = (BigInt(bucket.creditsPaise) + t.amountPaise).toString();
        else bucket.debitsPaise = (BigInt(bucket.debitsPaise) + t.amountPaise).toString();
        bucket.count++;
        if (!CREDITS.has(t.type)) {
          const merchant = t.description.replace(/\s+\d+$/, '');
          const mb = (byMerchant[merchant] ??= { totalPaise: '0', count: 0 });
          mb.totalPaise = (BigInt(mb.totalPaise) + t.amountPaise).toString();
          mb.count++;
        }
      }
      return {
        accountNumber: a.accountNumber,
        ownerEmail: users.find((u) => u.id === a.userId)!.email,
        closingBalancePaise: (balance.get(a.id) ?? 0n).toString(),
        transactionCount: mine.length,
        byMonth, byMerchant,
      };
    }),
  };
  writeFileSync(join(__dirname, '.seed-facts.json'), JSON.stringify(facts, null, 2));

  console.log(`✓ ${users.length} users, ${accounts.length} accounts, ${accepted.length} transactions`);
  if (skipped) console.log(`  (${skipped} debits declined — would have overdrawn)`);
  for (const a of facts.accounts) {
    console.log(`  ${a.accountNumber}  ₹${(Number(a.closingBalancePaise) / 100).toLocaleString('en-IN')}  (${a.transactionCount} txns)`);
  }
  console.log('✓ ground truth → prisma/.seed-facts.json');
  console.log(`✓ logins: admin@neobank.test / steven@neobank.test / priya@neobank.test — password ${DEMO_PASSWORD}`);
}

main()
  .catch((e) => { console.error(e); process.exit(1); })
  .finally(async () => { await prisma.$disconnect(); });
