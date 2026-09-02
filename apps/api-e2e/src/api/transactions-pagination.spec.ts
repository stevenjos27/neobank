import axios from 'axios';

const ok = { validateStatus: () => true };

async function makeUser(prefix: string) {
  const email = `${prefix}-${Date.now()}@e2e.neobank.test`;
  await axios.post('/api/auth/register', {
    email,
    password: 'Secret456!',
    fullName: `Pagination ${prefix}`,
  });
  const login = await axios.post('/api/auth/login', { email, password: 'Secret456!' }, ok);
  expect(login.status).toBe(200);
  return { headers: { Authorization: `Bearer ${login.data.accessToken}` } };
}

describe('Transaction pagination', () => {
  let authA: any;
  let authB: any;
  let accountId: string;

  beforeAll(async () => {
    authA = await makeUser('pager-a');
    authB = await makeUser('pager-b');

    const account = await axios.post('/api/accounts', { type: 'SAVINGS' }, { ...ok, ...authA });
    accountId = account.data.id;

    // Five deposits over a limit of two gives pages of 2, 2, 1 — an uneven
    // final page, which is where off-by-one errors live.
    for (let i = 1; i <= 5; i++) {
      await axios.post(
        `/api/accounts/${accountId}/deposit`,
        { amountPaise: 1000 * i, description: `deposit ${i}` },
        { ...ok, ...authA },
      );
    }
  });

  it('pages through the whole ledger with no duplicates and no gaps', async () => {
    const seen: string[] = [];
    let cursor: string | null = null;
    let pages = 0;

    do {
      const url =
        `/api/accounts/${accountId}/transactions?limit=2` +
        (cursor ? `&cursor=${encodeURIComponent(cursor)}` : '');

      const res = await axios.get(url, { ...ok, ...authA });
      expect(res.status).toBe(200);

      seen.push(...res.data.items.map((t: any) => t.id));
      cursor = res.data.nextCursor;
      pages++;

      // A cursor that fails to advance loops forever. Without this the suite
      // hangs rather than fails
      expect(pages).toBeLessThan(10);
    } while (cursor);

    expect(seen).toHaveLength(5);          // no gaps
    expect(new Set(seen).size).toBe(5);    // no duplicates
    expect(pages).toBe(3);                 // 2 + 2 + 1
  });

  it('orders newest-first and defaults the page size', async () => {
    const res = await axios.get(`/api/accounts/${accountId}/transactions`, { ...ok, ...authA });

    expect(res.status).toBe(200);
    expect(res.data.items).toHaveLength(5);
    expect(res.data.nextCursor).toBeNull();
    expect(res.data.items[0].description).toBe('deposit 5');
    expect(res.data.items[4].description).toBe('deposit 1');
  });

  it('rejects a malformed cursor with 400', async () => {
    const res = await axios.get(
      `/api/accounts/${accountId}/transactions?cursor=not-a-real-cursor`,
      { ...ok, ...authA },
    );
    expect(res.status).toBe(400);
  });

  it('rejects a limit above the cap with 400', async () => {
    const res = await axios.get(`/api/accounts/${accountId}/transactions?limit=101`, {
      ...ok,
      ...authA,
    });
    expect(res.status).toBe(400);
  });

  it('rejects a limit below one with 400', async () => {
    const res = await axios.get(`/api/accounts/${accountId}/transactions?limit=0`, {
      ...ok,
      ...authA,
    });
    expect(res.status).toBe(400);
  });

  it('404s when B pages A\'s account with a cursor A legitimately obtained', async () => {
    const first = await axios.get(`/api/accounts/${accountId}/transactions?limit=2`, {
      ...ok,
      ...authA,
    });
    expect(first.status).toBe(200);
    const cursor: string = first.data.nextCursor;
    expect(cursor).toBeTruthy();

    // A valid cursor must never become a way around the ownership guard, and
    // the response must stay indistinguishable from "no such account".
    const res = await axios.get(
      `/api/accounts/${accountId}/transactions?limit=2&cursor=${encodeURIComponent(cursor)}`,
      { ...ok, ...authB },
    );
    expect(res.status).toBe(404);
  });
});
