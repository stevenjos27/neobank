import axios from 'axios';

const ok = { validateStatus: () => true };

describe('Transfers', () => {
  let auth: { headers: { Authorization: string } };
  let savingsId: string;
  let currentId: string;

  beforeAll(async () => {
    const email = `transfer-${Date.now()}@neobank.test`;
    await axios.post('/api/auth/register', { email, password: 'Secret123!', fullName: 'Transfer Tester' }, ok);
    const login = await axios.post('/api/auth/login', { email, password: 'Secret123!' }, ok);
    auth = { headers: { Authorization: `Bearer ${login.data.accessToken}` } };

    const savings = await axios.post('/api/accounts', { type: 'SAVINGS' }, { ...ok, ...auth });
    const current = await axios.post('/api/accounts', { type: 'CURRENT' }, { ...ok, ...auth });
    savingsId = savings.data.id;
    currentId = current.data.id;

    await axios.post(`/api/accounts/${savingsId}/deposit`, { amountPaise: 300000 }, { ...ok, ...auth });
  });

  it('transfers between accounts and updates both balances', async () => {
    const res = await axios.post('/api/accounts/transfer', { fromAccountId: savingsId, toAccountId: currentId, amountPaise: 100000, description: 'ok' }, { ...ok, ...auth });

    expect(res.status).toBe(201);

    const savings = await axios.get(`/api/accounts/${savingsId}`, { ...ok, ...auth });
    const current = await axios.get(`/api/accounts/${currentId}`, { ...ok, ...auth });
    expect(savings.data.balancePaise).toBe('200000');
    expect(current.data.balancePaise).toBe('100000');
  });

  it('rejects a transfer to a nonexistent destination and leaves balances untouched', async () => {
    const res = await axios.post('/api/accounts/transfer', {
      fromAccountId: savingsId,
      toAccountId: '00000000-0000-4000-8000-000000000000',
      amountPaise: 50000,
    }, { ...ok, ...auth });

    expect(res.status).toBe(404);

    const savings = await axios.get(`/api/accounts/${savingsId}`, { ...ok, ...auth });
    const current = await axios.get(`/api/accounts/${currentId}`, { ...ok, ...auth });
    expect(savings.data.balancePaise).toBe('200000');
    expect(current.data.balancePaise).toBe('100000');
  });

  it('rejects a transfer exceeding the balance', async () => {
    const res = await axios.post('/api/accounts/transfer', { fromAccountId: savingsId, toAccountId: currentId, amountPaise: 999999999, description: 'ok' }, { ...ok, ...auth });

    expect(res.status).toBe(400);
    const savings = await axios.get(`/api/accounts/${savingsId}`, { ...ok, ...auth });
    const current = await axios.get(`/api/accounts/${currentId}`, { ...ok, ...auth });
    expect(savings.data.balancePaise).toBe('200000');
    expect(current.data.balancePaise).toBe('100000');
  });

  it('never loses money under concurrent transfers', async () => {
    const attempts = Array.from({ length: 10 }, () =>
      axios.post('/api/accounts/transfer', {
        fromAccountId: savingsId,
        toAccountId: currentId,
        amountPaise: 100000
      }, { ...ok, ...auth })
    );
    const results = await Promise.all(attempts);

    const succeeded = results.filter((r) => r.status === 201).length;
    expect(succeeded).toBe(2);
    const savings = await axios.get(`/api/accounts/${savingsId}`, { ...ok, ...auth });
    const current = await axios.get(`/api/accounts/${currentId}`, { ...ok, ...auth });
    expect(savings.data.balancePaise).toBe('0');
    expect(current.data.balancePaise).toBe('300000');
  });

  it('returns latest 50 transactions for the account', async () => {
    const res = await axios.get(`/api/accounts/${savingsId}/transactions`, { ...ok, ...auth });
    expect(res.status).toBe(200);
    expect(res.data.some((t: { type: string; amountPaise: string }) => t.type === 'TRANSFER_OUT' && t.amountPaise === '100000',)).toBe(true);
  });
});
