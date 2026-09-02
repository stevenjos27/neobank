import axios from 'axios';

const ok = { validateStatus: () => true };

async function makeUser(prefix: string) {
  const email = `${prefix}-${Date.now()}@e2e.neobank.test`;
  await axios.post('/api/auth/register', {
    email,
    "password": "Secret456!",
    "fullName": `Register ${prefix}`
  });

  const login = await axios.post('/api/auth/login', { email, password: 'Secret456!' }, ok);
  expect(login.status).toBe(200);
  const auth = { headers: { Authorization: `Bearer ${login.data.accessToken}` } };
  return auth;
}

describe('Ownership', () => {
  let authA, authB;
  let accountA_ID: string;
  let accountB_ID: string;

  beforeAll(async () => {
    authA = await makeUser('owner-a');
    const accountA = await axios.post('/api/accounts', { type: 'SAVINGS' }, { ...ok, ...authA });
    authB = await makeUser('owner-b');
    const accountB = await axios.post('/api/accounts', { type: 'SAVINGS' }, { ...ok, ...authB });
    accountA_ID = accountA.data.id;
    accountB_ID = accountB.data.id;

    await axios.post(`/api/accounts/${accountA_ID}/deposit`, { amountPaise: 100000 }, { ...ok, ...authA });
  });

  it('B cannot read A\'s account (404, indistinguishable from nonexistent)', async () => {
    const res = await axios.get(`/api/accounts/${accountA_ID}`, { ...ok, ...authB });
    expect(res.status).toBe(404);
  });

  it('B cannot deposit into A\'s account (404)', async () => {
    const res = await axios.post(`/api/accounts/${accountA_ID}/deposit`, {
      amountPaise: 50000, description: 'test deposit'
    }, { ...ok, ...authB });
    expect(res.status).toBe(404);
    const accountA = await axios.get(`/api/accounts/${accountA_ID}`, { ...ok, ...authA });
    expect(accountA.data.balancePaise).toBe('100000');
  });

  it('B cannot transfer from A\'s account (404), and A\'s money never moves', async () => {
    // POST transfer { from: accountA, to: accountB } as B -> expect 400
    const res = await axios.post('/api/accounts/transfer', {
      fromAccountId: accountA_ID,
      toAccountId: accountB_ID,
      amountPaise: 50000,
      description: 'ok'
    }, { ...ok, ...authB });

    expect(res.status).toBe(404);

    // as A: accountA balance still '100000'
    // as B: accountB balance still '0'
    const accountA = await axios.get(`/api/accounts/${accountA_ID}`, { ...ok, ...authA });
    expect(accountA.data.balancePaise).toBe('100000');
    const accountB = await axios.get(`/api/accounts/${accountB_ID}`, { ...ok, ...authB });
    expect(accountB.data.balancePaise).toBe('0');
  });

  it('B\'s account list contains only B\'s accounts', async () => {
    // GET /api/accounts as B -> expect array of length 1, [0].id === accountB
    const accountB = await axios.get('/api/accounts', { ...ok, ...authB });
    expect(accountB.data.length).toBe(1);
    expect(accountB.data[0].id).toBe(accountB_ID);
  });

  it("B cannot read A's transactions (404)", async () => {
    const res = await axios.get(`/api/accounts/${accountA_ID}/transactions`, { ...ok, ...authB });
    expect(res.status).toBe(404);
  });
});
