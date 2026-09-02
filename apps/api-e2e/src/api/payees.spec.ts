import axios from 'axios';

const ok = { validateStatus: () => true };
const BANK_IFSC = process.env.BANK_IFSC ?? 'NEOB0000001';

async function makeUser(prefix: string, fullName: string) {
  const email = `${prefix}-${Date.now()}@e2e.neobank.test`;
  await axios.post('/api/auth/register', { email, password: 'Secret456!', fullName });
  const login = await axios.post('/api/auth/login', { email, password: 'Secret456!' }, ok);
  expect(login.status).toBe(200);
  return { headers: { Authorization: `Bearer ${login.data.accessToken}` } };
}

describe('Payees', () => {
  let payer: any;      // Steven — adds a payee and sends money
  let recipient: any;  // Priya  — receives it
  let stranger: any;   // a third user, to prove payees are private

  let payerAccountId: string;
  let recipientAccountId: string;
  let recipientAccountNumber: string;
  let payeeId: string;

  beforeAll(async () => {
    payer = await makeUser('payer', 'Steven Joseph');
    recipient = await makeUser('recipient', 'Priya Nair');
    stranger = await makeUser('stranger', 'Mallory Quinn');

    const payerAccount = await axios.post('/api/accounts', { type: 'SAVINGS' }, { ...ok, ...payer });
    payerAccountId = payerAccount.data.id;

    const recipientAccount = await axios.post(
      '/api/accounts', { type: 'SAVINGS' }, { ...ok, ...recipient },
    );
    recipientAccountId = recipientAccount.data.id;
    recipientAccountNumber = recipientAccount.data.accountNumber;

    await axios.post(
      `/api/accounts/${payerAccountId}/deposit`,
      { amountPaise: 500000, description: 'opening funds' },
      { ...ok, ...payer },
    );
  });

  // ─────────────────────────────────────────────── Confirmation of Payee

  it('confirms the account holder\'s name for a valid account', async () => {
    const res = await axios.post(
      '/api/payees/verify',
      { accountNumber: recipientAccountNumber, ifsc: BANK_IFSC },
      { ...ok, ...payer },
    );

    expect(res.status).toBe(200);
    expect(res.data).toEqual({
      accountNumber: recipientAccountNumber,
      beneficiaryName: 'Priya Nair',
    });
  });

  it('gives the same 404 for a foreign IFSC and an unknown account', async () => {
    const foreignBank = await axios.post(
      '/api/payees/verify',
      { accountNumber: recipientAccountNumber, ifsc: 'HDFC0000123' },
      { ...ok, ...payer },
    );
    const noSuchAccount = await axios.post(
      '/api/payees/verify',
      { accountNumber: '999999999999', ifsc: BANK_IFSC },
      { ...ok, ...payer },
    );

    // Distinguishable responses would make this endpoint an oracle telling an
    // attacker which half of the input to vary.
    expect(foreignBank.status).toBe(404);
    expect(noSuchAccount.status).toBe(404);
    expect(foreignBank.data.message).toBe(noSuchAccount.data.message);
  });

  it('rejects a malformed IFSC before it reaches the service', async () => {
    const res = await axios.post(
      '/api/payees/verify',
      { accountNumber: recipientAccountNumber, ifsc: 'nonsense' },
      { ...ok, ...payer },
    );
    expect(res.status).toBe(400);
  });

  // ──────────────────────────────────────────────────────── adding a payee

  it('stores the verified name, not anything the client sent', async () => {
    const res = await axios.post(
      '/api/payees',
      {
        accountNumber: recipientAccountNumber,
        ifsc: BANK_IFSC,
        name: 'Definitely Not Priya',   // whitelist: true strips this
      },
      { ...ok, ...payer },
    );

    expect(res.status).toBe(201);
    expect(res.data.name).toBe('Priya Nair');
    expect(res.data.accountNumber).toBe(recipientAccountNumber);
    payeeId = res.data.id;
  });

  it('409s a duplicate payee', async () => {
    const res = await axios.post(
      '/api/payees',
      { accountNumber: recipientAccountNumber, ifsc: BANK_IFSC },
      { ...ok, ...payer },
    );
    expect(res.status).toBe(409);
  });

  it('lists only the caller\'s payees', async () => {
    const mine = await axios.get('/api/payees', { ...ok, ...payer });
    expect(mine.status).toBe(200);
    expect(mine.data).toHaveLength(1);
    expect(mine.data[0].name).toBe('Priya Nair');

    const theirs = await axios.get('/api/payees', { ...ok, ...stranger });
    expect(theirs.data).toHaveLength(0);
  });

  // ───────────────────────────────────────────────── transferring to a payee

  it('moves money and names the right counterparty in BOTH ledgers', async () => {
    const res = await axios.post(
      '/api/accounts/transfer',
      {
        fromAccountId: payerAccountId,
        payeeId,
        amountPaise: 120000,
        description: 'CLIENT SUPPLIED — must be ignored',
      },
      { ...ok, ...payer },
    );
    expect(res.status).toBe(201);

    const payerAccount = await axios.get(`/api/accounts/${payerAccountId}`, { ...ok, ...payer });
    expect(payerAccount.data.balancePaise).toBe('380000'); // 500000 − 120000

    const recipientAccount = await axios.get(
      `/api/accounts/${recipientAccountId}`, { ...ok, ...recipient },
    );
    expect(recipientAccount.data.balancePaise).toBe('120000');

    const payerLedger = await axios.get(
      `/api/accounts/${payerAccountId}/transactions?limit=1`, { ...ok, ...payer },
    );
    const recipientLedger = await axios.get(
      `/api/accounts/${recipientAccountId}/transactions?limit=1`, { ...ok, ...recipient },
    );

    const out = payerLedger.data.items[0];
    const inbound = recipientLedger.data.items[0];

    expect(out.type).toBe('TRANSFER_OUT');
    expect(out.description).toContain('Transfer to Priya Nair');
    expect(inbound.type).toBe('TRANSFER_IN');
    expect(inbound.description).toContain('Transfer from Steven Joseph');

    // The payer cannot write text into someone else's bank statement.
    expect(out.description).not.toContain('CLIENT SUPPLIED');
    expect(inbound.description).not.toContain('CLIENT SUPPLIED');
  });

  it('404s when a payee belonging to someone else is used', async () => {
    const res = await axios.post(
      '/api/accounts/transfer',
      { fromAccountId: payerAccountId, payeeId, amountPaise: 1000 },
      { ...ok, ...stranger },
    );
    // Stranger's source account isn't payerAccountId either, so this fails at
    // the very first ownership check — which is the correct order.
    expect(res.status).toBe(404);
  });

  // ────────────────────────────────────────────────── destination exclusivity

  it('400s when neither destination is supplied', async () => {
    const res = await axios.post(
      '/api/accounts/transfer',
      { fromAccountId: payerAccountId, amountPaise: 1000 },
      { ...ok, ...payer },
    );
    expect(res.status).toBe(400);
  });

  it('400s when both destinations are supplied', async () => {
    const res = await axios.post(
      '/api/accounts/transfer',
      { fromAccountId: payerAccountId, toAccountId: recipientAccountId, payeeId, amountPaise: 1000 },
      { ...ok, ...payer },
    );
    expect(res.status).toBe(400);
  });

  it('refuses toAccountId pointed at an account the caller does not own', async () => {
    const res = await axios.post(
      '/api/accounts/transfer',
      { fromAccountId: payerAccountId, toAccountId: recipientAccountId, amountPaise: 1000 },
      { ...ok, ...payer },
    );

    expect(res.status).toBe(404);

    const recipientAccount = await axios.get(
      `/api/accounts/${recipientAccountId}`, { ...ok, ...recipient },
    );
    expect(recipientAccount.data.balancePaise).toBe('120000');
  });

  // ───────────────────────────────────────────────────────── deleting a payee

  it('404s deleting someone else\'s payee, and leaves it intact', async () => {
    const res = await axios.delete(`/api/payees/${payeeId}`, { ...ok, ...stranger });
    expect(res.status).toBe(404);

    const mine = await axios.get('/api/payees', { ...ok, ...payer });
    expect(mine.data).toHaveLength(1);
  });

  it('deletes the caller\'s own payee, after which transfers to it 404', async () => {
    const res = await axios.delete(`/api/payees/${payeeId}`, { ...ok, ...payer });
    expect(res.status).toBe(204);

    const transfer = await axios.post(
      '/api/accounts/transfer',
      { fromAccountId: payerAccountId, payeeId, amountPaise: 1000 },
      { ...ok, ...payer },
    );
    expect(transfer.status).toBe(404);
  });

});
