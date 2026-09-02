/**
 * The duplicate-timestamp case, at the SQL level.
 *
 * This is the one test that cannot go through the API. No endpoint can produce
 * two transactions on the SAME account sharing a createdAt: deposits are
 * separate database transactions, and a transfer's two rows — which DO share a
 * timestamp, because Postgres `now()` is transaction-start time — land on two
 * different accounts. So the rows are written directly.
 *
 * Note this deliberately breaks the ledger/balance invariant for this account:
 * rows are inserted without moving balancePaise. That is fine precisely because
 * the account belongs to a throwaway @e2e.neobank.test user that global
 * teardown purges. Never point this at seeded or real data.
 */

import 'dotenv/config';
import axios from 'axios';
import { PrismaClient } from '@neobank/prisma';
import { PrismaPg } from '@prisma/adapter-pg';

const ok = { validateStatus: () => true };

async function makeUser(prefix: string) {
  const email = `${prefix}-${Date.now()}@e2e.neobank.test`;
  await axios.post('/api/auth/register', {
    email,
    password: 'Secret456!',
    fullName: `Tiebreak ${prefix}`,
  });
  const login = await axios.post('/api/auth/login', { email, password: 'Secret456!' }, ok);
  expect(login.status).toBe(200);
  return { headers: { Authorization: `Bearer ${login.data.accessToken}` } };
}

describe('Pagination across identical timestamps', () => {
  const prisma = new PrismaClient({
    adapter: new PrismaPg({ connectionString: process.env.DATABASE_URL }),
  });

  let auth: any;
  let accountId: string;

  beforeAll(async () => {
    auth = await makeUser('tiebreak');
    const account = await axios.post('/api/accounts', { type: 'SAVINGS' }, { ...ok, ...auth });
    accountId = account.data.id;

    const sharedInstant = new Date('2026-06-15T10:30:00.000Z');
    await prisma.transaction.createMany({
      data: [
        { accountId, type: 'DEPOSIT', amountPaise: 111n, description: 'tie A', createdAt: sharedInstant },
        { accountId, type: 'DEPOSIT', amountPaise: 222n, description: 'tie B', createdAt: sharedInstant },
        { accountId, type: 'DEPOSIT', amountPaise: 333n, description: 'tie C', createdAt: sharedInstant },
      ],
    });
  });

  afterAll(async () => {
    await prisma.$disconnect();
  });

  it('returns every tied row exactly once when paging one at a time', async () => {
    const seen: string[] = [];
    const descriptions: string[] = [];
    let cursor: string | null = null;
    let pages = 0;

    do {
      const url =
        `/api/accounts/${accountId}/transactions?limit=1` +
        (cursor ? `&cursor=${encodeURIComponent(cursor)}` : '');

      const res = await axios.get(url, { ...ok, ...auth });
      expect(res.status).toBe(200);

      seen.push(...res.data.items.map((t: any) => t.id));
      descriptions.push(...res.data.items.map((t: any) => t.description));
      cursor = res.data.nextCursor;
      pages++;

      expect(pages).toBeLessThan(20);
    } while (cursor);

    // limit=1 forces a page boundary between every pair of tied rows — the
    // exact position where a cursor without a tiebreaker skips or repeats.
    expect(seen).toHaveLength(3);
    expect(new Set(seen).size).toBe(3);
    expect(descriptions.sort()).toEqual(['tie A', 'tie B', 'tie C']);
  });
});
