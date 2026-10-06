/**
 * Refresh-token rotation, reuse detection and server-side logout, against a
 * real server and a real database.
 *
 * Unit tests prove what decideRefresh DECIDES. Only this suite proves what
 * the system DOES: that the conditional UPDATE lets exactly one concurrent
 * request rotate, that a revoked session really rejects every token in it,
 * and that logout is enforced by the server rather than by a deleted cookie.
 *
 * "Outside the grace window" is produced by moving `usedAt` back in the
 * database rather than by sleeping or shrinking the window: production
 * configuration is what gets tested. Rows are found through the throwaway
 * user's email, never by hashing the token here, so this suite does not
 * depend on how AuthService encodes the hash.
 */

import 'dotenv/config';
import axios from 'axios';
import { PrismaClient } from '@neobank/prisma';
import { PrismaPg } from '@prisma/adapter-pg';

const ok = { validateStatus: () => true };
const password = 'Secret789!';

const prisma = new PrismaClient({
  adapter: new PrismaPg({ connectionString: process.env.DATABASE_URL }),
});

afterAll(async () => {
  await prisma.$disconnect();
});

async function newUser(prefix: string): Promise<string> {
  const email = `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}@e2e.neobank.test`;
  const res = await axios.post('/api/auth/register', { email, password, fullName: `Rotation ${prefix}` }, ok);
  expect(res.status).toBe(201);
  return email;
}

async function login(email: string): Promise<{ accessToken: string; refreshToken: string }> {
  const res = await axios.post('/api/auth/login', { email, password }, ok);
  expect(res.status).toBe(200);
  return res.data;
}

const refresh = (refreshToken: string) => axios.post('/api/auth/refresh', { refreshToken }, ok);
const logout = (refreshToken: string) => axios.post('/api/auth/logout', { refreshToken }, ok);

/** Pretend every token this user has already rotated was rotated a minute ago. */
async function pushUsedTokensPastGrace(email: string) {
  const moved = await prisma.refreshToken.updateMany({
    where: { usedAt: { not: null }, session: { user: { email } } },
    data: { usedAt: new Date(Date.now() - 60_000) },
  });
  // Guard against a vacuous test: if nothing moved, the replay below would
  // be inside the window and prove nothing about reuse.
  expect(moved.count).toBeGreaterThan(0);
}

describe('Refresh-token rotation', () => {
  it('issues a different refresh token on every refresh, and the new one works', async () => {
    const email = await newUser('rotate');
    const { refreshToken: t1 } = await login(email);

    const r1 = await refresh(t1);
    expect(r1.status).toBe(200);
    const t2: string = r1.data.refreshToken;
    expect(t2).not.toBe(t1);

    expect((await refresh(t2)).status).toBe(200);
  });

  it('stores only a hash: the raw refresh token never appears in the database', async () => {
    const email = await newUser('hashed');
    const { refreshToken } = await login(email);

    const rows = await prisma.refreshToken.findMany({
      where: { session: { user: { email } } },
      select: { tokenHash: true },
    });
    expect(rows.length).toBe(1);
    expect(rows[0].tokenHash).not.toBe(refreshToken);
    expect(rows[0].tokenHash).not.toContain(refreshToken);
  });

  it('treats a replay outside the grace window as theft and revokes the whole session', async () => {
    const email = await newUser('reuse');
    const { refreshToken: t1 } = await login(email);
    const t2: string = (await refresh(t1)).data.refreshToken;

    await pushUsedTokensPastGrace(email);

    // The replay is refused…
    expect((await refresh(t1)).status).toBe(401);
    // …and so is the NEWEST token, which may be the attacker's or the user's.
    // Neither side can be told apart, so the session ends for both.
    expect((await refresh(t2)).status).toBe(401);

    const sessions = await prisma.session.findMany({ where: { user: { email } } });
    expect(sessions).toHaveLength(1);
    expect(sessions[0].revokedReason).toBe('REUSE');
  });

  it('lets five concurrent refreshes with ONE token all succeed, without revoking the session', async () => {
    // The web proxy's real behaviour when the access cookie expires: one
    // navigation, several requests, the same refresh token on each.
    //
    // Expected to PASS on the old stateless code too: it is the regression
    // guard for the grace window, the test that fails if reuse detection
    // ships without it.
    const email = await newUser('concurrent');
    const { refreshToken: t1 } = await login(email);

    const results = await Promise.all(Array.from({ length: 5 }, () => refresh(t1)));
    expect(results.map((r) => r.status)).toEqual([200, 200, 200, 200, 200]);

    // Every token handed out is usable: none of them was issued into a
    // session that a sibling request then revoked.
    expect((await refresh(results[4].data.refreshToken)).status).toBe(200);

    const sessions = await prisma.session.findMany({ where: { user: { email } } });
    expect(sessions).toHaveLength(1);
    expect(sessions[0].revokedAt).toBeNull();
  });

  it('rejects a refresh token it never issued', async () => {
    expect((await refresh('not-a-token-this-server-issued')).status).toBe(401);
  });
});

describe('Server-side logout', () => {
  it('ends the session: the current refresh token stops working', async () => {
    const email = await newUser('logout');
    const { refreshToken: t1 } = await login(email);
    const t2: string = (await refresh(t1)).data.refreshToken;

    expect((await logout(t2)).status).toBe(204);
    expect((await refresh(t2)).status).toBe(401);

    const sessions = await prisma.session.findMany({ where: { user: { email } } });
    expect(sessions[0].revokedReason).toBe('LOGOUT');
  });

  it('answers 204 whatever it is given, so it cannot be used to test a stolen token', async () => {
    const email = await newUser('logout-idem');
    const { refreshToken } = await login(email);

    expect((await logout(refreshToken)).status).toBe(204);
    expect((await logout(refreshToken)).status).toBe(204);
    expect((await logout('garbage')).status).toBe(204);
  });

  it('logout-all ends every session the user has (the lost-phone control)', async () => {
    const email = await newUser('logout-all');
    const phone = await login(email);
    const laptop = await login(email);

    const res = await axios.post('/api/auth/logout-all', {}, {
      ...ok,
      headers: { Authorization: `Bearer ${laptop.accessToken}` },
    });
    expect(res.status).toBe(204);

    expect((await refresh(phone.refreshToken)).status).toBe(401);
    expect((await refresh(laptop.refreshToken)).status).toBe(401);
  });

  it('logout-all requires an access token', async () => {
    expect((await axios.post('/api/auth/logout-all', {}, ok)).status).toBe(401);
  });

  it('DOCUMENTED LIMIT: an access token keeps working until it expires (≤15 min)', async () => {
    // Asserted so nobody believes otherwise. Checking every request against
    // the session table would make access tokens stateful; short-lived JWTs
    // are the accepted trade, and this test is where that trade is visible.
    const email = await newUser('residual');
    const { accessToken, refreshToken } = await login(email);

    expect((await logout(refreshToken)).status).toBe(204);

    const accounts = await axios.get('/api/accounts', {
      ...ok,
      headers: { Authorization: `Bearer ${accessToken}` },
    });
    expect(accounts.status).toBe(200);
  });
});
