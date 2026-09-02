import axios from 'axios';

const ok = { validateStatus: () => true };

describe('Auth flow', () => {
  const email = `e2e-${Date.now()}@e2e.neobank.test`;
  const password = 'Secret123!';

  it('registers a new user', async () => {
    const res = await axios.post('/api/auth/register', { email, password, fullName: 'E2E User' }, ok);
    expect(res.status).toBe(201);
    expect(res.status).not.toHaveProperty('passwordHash');
  });

  it('rejects a duplicate registration', async () => {
    const res = await axios.post('/api/auth/register', { email, password, fullName: 'E2E User' }, ok);
    expect(res.status).toBe(409);
  });

  it('logs in and can access a guarded route', async () => {
    const login = await axios.post('/api/auth/login', { email, password }, ok);
    expect(login.status).toBe(200);

    const me = await axios.get('/api/accounts/00000000-0000-0000-0000-000000000000', {
      ...ok,
      headers: { Authorization: `Bearer ${login.data.accessToken}` },
    });
    expect(me.status).not.toBe(401);
  });

  it('rejects guarded routes without a token', async () => {
    const res = await axios.get('/api/accounts/00000000-0000-0000-0000-000000000000', ok);
    expect(res.status).toBe(401);
  });

  it('refreshes the token pair', async () => {
    const login = await axios.post('/api/auth/login', { email, password }, ok);
    const res = await axios.post('/api/auth/refresh', { refreshToken: login.data.refreshToken }, ok);
    expect(res.status).toBe(200);
    expect(res.data).toHaveProperty('accessToken');
  });
});
