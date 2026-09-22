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
/**
 * The instant the entire dataset is generated relative to.
 *
 * Defaults to the real "now", because a permanently fixed anchor makes
 * `last_month` empty within weeks and a live demo is what this data is for.
 * `SEED_ANCHOR_DATE` pins it for the eval harness, which needs two runs to
 * differ only in what the eval changed — a prompt comparison against a
 * dataset that moved underneath has two variables and measures neither.
 *
 * Pass a FULL ISO instant with `Z`. A bare `2026-09-01` parses as UTC
 * midnight, but `2026-09-01T00:00:00` (no zone) parses as LOCAL time, so the
 * same string produces different data in different timezones — which is the
 * exact class of bug this variable exists to remove.
 */
const ANCHOR_ENV = process.env.SEED_ANCHOR_DATE;
const now = ANCHOR_ENV ? new Date(ANCHOR_ENV) : new Date();

// An unparseable date yields Invalid Date, and EVERY comparison against it is
// false — including `d > now` in the clamp below. A typo would therefore not
// throw; it would silently disable the future-date guard and fill the ledger
// with transactions dated next year. NaN checks on dates are not paranoia.
if (Number.isNaN(now.getTime())) {
  throw new Error(
    `SEED_ANCHOR_DATE is not a valid date: "${ANCHOR_ENV}" — expected a full ISO instant such as 2026-09-01T00:00:00Z`,
  );
}
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
  // Drawn UNCONDITIONALLY, even when it goes unused.
  //
  // A draw inside the branch couples the PRNG stream to the DATA: the number
  // of future-dated days changes every time the anchor moves, so the number
  // of extra draws changes, so every subsequent amount, merchant and coin
  // flip shifts. That is what turned 238 transactions into 249 into 252 for
  // byte-identical code — not the window sliding, the stream desynchronising.
  //
  // Cost: one wasted rng() per call. Benefit: the stream position depends
  // only on HOW MANY TIMES this function is called, never on what it decides.
  const clampHours = randInt(1, 72);

  // never emit a future-dated transaction in the current month
  return d > now ? new Date(now.getTime() - clampHours * 3600_000) : d;
}

// ---------- IST calendar, for the ground-truth file ----------
//
// A SECOND implementation of the rule apps/api/src/app/ai/period.ts
// implements, deliberately not imported from it. Ground truth that shares code
// with the system under test is wrong in lockstep with it: a bug in period.ts
// would move the expected and the actual figure together, and the test would
// pass. Written from the specification — NeoBank's calendar is IST civil
// dates, UTC+05:30, no DST — not from the code.
const IST_OFFSET_MS = (5 * 60 + 30) * 60_000;

/** The IST civil date an instant falls on. */
function istDate(instant: Date): { year: number; month: number; day: number } {
  const shifted = new Date(instant.getTime() + IST_OFFSET_MS);
  return {
    year: shifted.getUTCFullYear(),
    month: shifted.getUTCMonth(),
    day: shifted.getUTCDate(),
  };
}

/** The instant an IST civil day begins. Out-of-range month or day normalise, as in Date.UTC. */
function istMidnight(year: number, month: number, day: number): Date {
  return new Date(Date.UTC(year, month, day) - IST_OFFSET_MS);
}

/** `YYYY-MM` of the IST civil month an instant falls in. */
function istMonthKey(instant: Date): string {
  const { year, month } = istDate(instant);
  return `${year}-${String(month + 1).padStart(2, '0')}`;
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

  // ---- per-user spend windows: ground truth for the aggregate tool ----
  //
  // For each user and each period, exactly what `spend_by_category` must
  // report when resolved at the anchor: debits only, summed across all of the
  // user's accounts, over half-open [from, to) IST windows. The periods are
  // restated here from their specification, not imported.
  //
  // Keyed by email, not id: email is the natural key, and the ids that win in
  // a database with history are not the logical ids this file plans with.
  const today = istDate(now);
  const windows: Record<string, { from: Date | null; to: Date }> = {
    this_month: { from: istMidnight(today.year, today.month, 1), to: now },
    last_month: {
      from: istMidnight(today.year, today.month - 1, 1),
      to: istMidnight(today.year, today.month, 1),
    },
    // Thirty days INCLUDING today: today and the 29 before it.
    last_30_days: { from: istMidnight(today.year, today.month, today.day - 29), to: now },
    this_year: { from: istMidnight(today.year, 0, 1), to: now },
    all_time: { from: null, to: now },
  };

  const spendByUser = Object.fromEntries(
    users.map((u) => {
      // Widened to string: `a.id` is a literal-union type (ID is `as const`),
      // but PlannedTxn.accountId is a plain string, and Set<T>.has only
      // accepts a T.
      const own = new Set<string>(accounts.filter((a) => a.userId === u.id).map((a) => a.id));
      const debits = accepted.filter((t) => own.has(t.accountId) && !CREDITS.has(t.type));
      const periods = Object.fromEntries(
        Object.entries(windows).map(([period, w]) => {
          const hits = debits.filter(
            (t) => (w.from === null || t.createdAt >= w.from) && t.createdAt < w.to,
          );
          return [
            period,
            {
              from: w.from ? w.from.toISOString() : null,
              to: w.to.toISOString(),
              debitsPaise: hits.reduce((sum, t) => sum + t.amountPaise, 0n).toString(),
              debitCount: hits.length,
            },
          ];
        }),
      );
      return [u.email, periods];
    }),
  );

  // ---- ground truth for the eval harness ----
  const facts = {
    // `generatedAt` and `anchor` are different facts and were conflated. When
    // the anchor is pinned they disagree, and it is the anchor that determines
    // the data — the same invariant as ChatResult.model and the search
    // result's threshold: a derived value travels with the inputs that
    // derived it.
    generatedAt: new Date().toISOString(),
    anchor: now.toISOString(),
    anchorPinned: ANCHOR_ENV !== undefined,
    // Host only. NEVER the connection string — it carries the password, and
    // this file has been shared before.
    database: (() => {
      try {
        return new URL(process.env.DATABASE_URL ?? '').host;
      } catch {
        return 'unknown';
      }
    })(),
    monthsOfHistory: MONTHS_OF_HISTORY,
    demoPassword: DEMO_PASSWORD,
    accounts: accounts.map((a) => {
      const mine = accepted.filter((t) => t.accountId === a.id);
      const byMonth: Record<string, { creditsPaise: string; debitsPaise: string; count: number }> = {};
      const byMerchant: Record<string, { totalPaise: string; count: number }> = {};
      for (const t of mine) {
        // IST civil month — the system's definition of a month. This was UTC,
        // which agreed with IST only because no generated transaction falls
        // between 18:30 and 24:00 UTC on a month's last day.
        const key = istMonthKey(t.createdAt);
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
    spendByUser,
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
