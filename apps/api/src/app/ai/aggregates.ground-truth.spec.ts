import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { config as loadEnv } from 'dotenv';
import { PrismaService } from '../../prisma/prisma.service';
import { AggregatesService, SpendByCategoryResult } from './aggregates.service';
import { PERIODS, Period } from './period';

/**
 * TOOL GROUND TRUTH — the aggregate tool against totals the seed computed.
 *
 * A test, not an eval: the expected values are exact, so it asserts rather
 * than scores. It comes first in the harness because the assistant can never
 * be more right than its tools, and an answer-quality score built on a wrong
 * total would measure the wrong thing while looking fine.
 *
 * WHERE THE EXPECTATIONS COME FROM. prisma/.seed-facts.json, written by the
 * generator as it built the data, using its own IST calendar. Nothing on the
 * expected side shares code with the side under test — the only reason
 * agreement means anything. Expectations computed with SQL here would be the
 * tool's own query checking itself.
 *
 * WHY IT IS VALID AT ANY ANCHOR. The facts file records the anchor it was
 * generated against, and every call below resolves its period at that same
 * instant. Pinning SEED_ANCHOR_DATE is what makes two runs comparable; it is
 * not what makes one run correct.
 *
 * Needs a seeded database, so it runs under its own target and never in the
 * unit suite — a unit test that needs Postgres is not a unit test.
 */

type SpendWindow = {
  from: string | null;
  to: string;
  debitsPaise: string;
  debitCount: number;
};

type SeedFacts = {
  anchor: string;
  database: string;
  accounts: Array<{ accountNumber: string; transactionCount: number }>;
  spendByUser: Record<string, Partial<Record<Period, SpendWindow>>>;
};

// apps/api/src/app/ai → repository root. Explicit rather than cwd-relative,
// because which directory Jest runs from depends on how it was invoked.
const REPO_ROOT = join(__dirname, '../../../../..');

// The unit suite never needs DATABASE_URL, so nothing loads .env under Jest.
// Existing variables win, as with the seed: CI's value is used as-is, and a
// local run falls back to the repository's .env.
loadEnv({ path: join(REPO_ROOT, '.env'), quiet: true });

const facts: SeedFacts = JSON.parse(
  readFileSync(join(REPO_ROOT, 'prisma/.seed-facts.json'), 'utf8'),
);
const anchor = new Date(facts.anchor);

// Driven by PERIODS — the tool's own list — not by whatever keys the facts
// file happens to contain. A period added to the tool without teaching the
// seed about it fails here, loudly, instead of silently going untested.
const cases = Object.entries(facts.spendByUser).flatMap(([email, periods]) =>
  PERIODS.map((period) => {
    const expected = periods[period];
    if (!expected) {
      throw new Error(
        `.seed-facts.json has no ground truth for "${period}". Every period the ` +
        `aggregate tool supports needs one — add it to the windows in prisma/seed.ts.`,
      );
    }
    return { email, period, expected };
  }),
);

describe('aggregate tool ground truth', () => {
  let prisma: PrismaService;
  let aggregates: AggregatesService;
  const userIds = new Map<string, string>();

  beforeAll(async () => {
    if (!process.env.DATABASE_URL) {
      throw new Error('DATABASE_URL is not set, and no .env was found at the repository root.');
    }

    // PRECONDITION 1 — the facts describe THIS database. One database's
    // ground truth against another database's data measures nothing, and
    // fails — or worse, passes — for reasons unrelated to the tool. Host only,
    // because that is what the seed records; two databases on one server
    // would slip past, which is acceptable for local Docker and CI, each of
    // which has exactly one.
    const connected = new URL(process.env.DATABASE_URL).host;
    if (facts.database !== connected) {
      throw new Error(
        `.seed-facts.json describes ${facts.database}, but DATABASE_URL points at ` +
        `${connected}. Re-seed this database, or point DATABASE_URL at the one that was seeded.`,
      );
    }

    prisma = new PrismaService();
    await prisma.$connect();
    aggregates = new AggregatesService(prisma);

    // PRECONDITION 2 — nothing has written to the seeded accounts since. A
    // transfer in the UI or a manual edit would make every total below wrong
    // for a reason unrelated to the tool. This turns "the tool is broken" and
    // "the data moved" into two different failure messages.
    for (const account of facts.accounts) {
      const actual = await prisma.transaction.count({
        where: { account: { accountNumber: account.accountNumber } },
      });
      if (actual !== account.transactionCount) {
        throw new Error(
          `Account ${account.accountNumber} holds ${actual} transactions; the facts file ` +
          `expects ${account.transactionCount}. It has been written to since it was ` +
          `seeded, so a mismatch below would be about the data, not the tool. Re-seed.`,
        );
      }
    }

    for (const email of Object.keys(facts.spendByUser)) {
      const user = await prisma.user.findUniqueOrThrow({
        where: { email },
        select: { id: true },
      });
      userIds.set(email, user.id);
    }
  });

  afterAll(async () => {
    await prisma?.$disconnect();
  });

  describe.each(cases)('$email · $period', ({ email, period, expected }) => {
    let result: SpendByCategoryResult;

    beforeAll(async () => {
      result = await aggregates.spendByCategory(userIds.get(email)!, period, anchor);
    });

    // Three assertions rather than one, because they point at different
    // code. A wrong window is period.ts; a right window with a wrong total is
    // the SQL; a right total with a wrong count is the grouping.
    it('resolves the same window', () => {
      expect({ from: result.from, to: result.to }).toEqual({
        from: expected.from,
        to: expected.to,
      });
    });

    it('reports the same total', () => {
      expect(result.totalPaise).toBe(expected.debitsPaise);
    });

    it('counts the same debits', () => {
      const counted = result.categories.reduce((sum, bucket) => sum + bucket.count, 0);
      expect(counted).toBe(expected.debitCount);
    });
  });
});
