import {
  createAuthClient,
  LoginFailedError,
  NetworkError,
  SessionExpiredError,
  type SessionState,
} from './auth-client';
import { createMemoryTokenStore } from './token-store';

/**
 * Each describe block pins one rule from auth-client.ts. The fake API below
 * behaves like the real one in miniature: numbered tokens (A1/R1, A2/R2…),
 * only the CURRENT access token is accepted, and every request and every
 * storage write lands in one ordered log — so tests assert sequences, not
 * just end states.
 */

const BASE = 'http://api.test/api';

/** Minimal Response stand-in: the client reads only status, ok and json(). */
function reply(status: number, body?: unknown): Response {
  return {
    status,
    ok: status >= 200 && status < 300,
    json: async () => body,
  } as unknown as Response;
}

function deferred() {
  let release!: () => void;
  const promise = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { promise, release };
}

/** Lets pending async work (fake fetches, awaits) run before the next step. */
const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

function createFakeApi() {
  const state = {
    access: 'A1',
    refresh: 'R1',
    generation: 1,
    refreshCalls: 0,
    refreshMode: 'ok' as 'ok' | 'network' | 'verdict' | 'server-error',
    refreshGate: null as Promise<void> | null,
    slowGate: null as Promise<void> | null,
    lastRefreshHeaders: null as Headers | null,
    lastLogoutBody: undefined as unknown,
    pathCalls: {} as Record<string, number>,
    log: [] as string[],
  };

  async function fakeFetch(url: string, init: RequestInit = {}): Promise<Response> {
    const path = url.slice(BASE.length);
    const headers = new Headers(init.headers);
    const body = init.body ? (JSON.parse(String(init.body)) as Record<string, string>) : {};
    state.pathCalls[path] = (state.pathCalls[path] ?? 0) + 1;

    switch (path) {
      case '/auth/login':
        return body.password === 'right'
          ? reply(200, { accessToken: state.access, refreshToken: state.refresh })
          : reply(401, { message: 'invalid credentials', statusCode: 401 });

      case '/auth/refresh': {
        state.refreshCalls += 1;
        state.lastRefreshHeaders = headers;
        state.log.push('refresh');
        if (state.refreshGate) await state.refreshGate;
        if (state.refreshMode === 'network') throw new TypeError('Network request failed');
        if (state.refreshMode === 'verdict') return reply(401, { message: 'invalid refresh token' });
        if (state.refreshMode === 'server-error') return reply(500, {});
        state.generation += 1;
        state.access = `A${state.generation}`;
        state.refresh = `R${state.generation}`;
        return reply(200, { accessToken: state.access, refreshToken: state.refresh });
      }

      case '/auth/logout':
        state.lastLogoutBody = body;
        state.log.push('logout');
        return reply(204);

      default: {
        // Validity is decided when the request ARRIVES, as on a real server.
        const auth = headers.get('Authorization');
        const status = auth === `Bearer ${state.access}` && path !== '/always-401' ? 200 : 401;
        state.log.push(`${path} ${auth} -> ${status}`);
        if (path === '/slow' && state.slowGate) {
          const gate = state.slowGate;
          state.slowGate = null;
          await gate;
        }
        return reply(status, status === 200 ? { ok: true } : { message: 'Unauthorized' });
      }
    }
  }

  return {
    state,
    fetch: fakeFetch as unknown as typeof fetch,
    /** The server stops accepting the client's current access token. */
    expireAccess() {
      state.access = `expired-${state.generation}`;
    },
  };
}

function setup(options: { stored?: string; signRefresh?: () => Promise<Record<string, string>> } = {}) {
  const api = createFakeApi();
  const memory = createMemoryTokenStore(options.stored ?? null);
  // Same store, but every write is recorded in the API's log, in order.
  const store = {
    get current() {
      return memory.current;
    },
    getRefreshToken: () => memory.getRefreshToken(),
    setRefreshToken: async (token: string) => {
      api.state.log.push(`store:${token}`);
      await memory.setRefreshToken(token);
    },
    clear: async () => {
      api.state.log.push('store:clear');
      await memory.clear();
    },
  };
  const client = createAuthClient({
    baseUrl: BASE,
    store,
    fetch: api.fetch,
    signRefresh: options.signRefresh,
  });
  const events: SessionState[] = [];
  client.onSessionChange((state) => events.push(state));
  return { api, store, client, events };
}

async function signedIn() {
  const ctx = setup();
  await ctx.client.login('steven@neobank.test', 'right');
  ctx.api.state.log.length = 0;
  ctx.events.length = 0;
  return ctx;
}

describe('login', () => {
  it('stores the refresh token, announces signedIn, and authenticates later requests', async () => {
    const { api, store, client, events } = setup();

    await client.login('steven@neobank.test', 'right');

    expect(store.current).toBe('R1');
    expect(events).toEqual(['signedIn']);
    expect((await client.apiFetch('/accounts')).status).toBe(200);
    expect(api.state.log).toContain('/accounts Bearer A1 -> 200');
  });

  it("surfaces the API's own message on failure and stores nothing", async () => {
    const { store, client, events } = setup();

    const attempt = client.login('steven@neobank.test', 'wrong');

    await expect(attempt).rejects.toBeInstanceOf(LoginFailedError);
    await expect(attempt).rejects.toThrow('invalid credentials');
    expect(store.current).toBeNull();
    expect(events).toEqual([]);
  });
});

describe('refresh', () => {
  it('rule 1: five concurrent 401s cause exactly ONE refresh, and all five succeed', async () => {
    const { api, store, client } = await signedIn();
    api.expireAccess();

    const results = await Promise.all(
      Array.from({ length: 5 }, (_, i) => client.apiFetch(`/r${i}`)),
    );

    expect(results.map((r) => r.status)).toEqual([200, 200, 200, 200, 200]);
    expect(api.state.refreshCalls).toBe(1);
    expect(store.current).toBe('R2');
  });

  it('rule 2: a 401 that arrives after someone else refreshed retries without refreshing again', async () => {
    const { api, client } = await signedIn();
    api.expireAccess();
    const gate = deferred();
    api.state.slowGate = gate.promise;

    // /slow is sent with the expired A1, and its 401 is held back…
    const slow = client.apiFetch('/slow');
    await tick();
    // …while /fast hits 401, refreshes to A2 and succeeds.
    expect((await client.apiFetch('/fast')).status).toBe(200);

    gate.release(); // /slow's stale 401 finally arrives
    expect((await slow).status).toBe(200);
    expect(api.state.refreshCalls).toBe(1);
    expect(api.state.log).toContain('/slow Bearer A2 -> 200');
  });

  it('rule 3: stores the rotated refresh token BEFORE using the new access token', async () => {
    const { api, client } = await signedIn();
    api.expireAccess();

    await client.apiFetch('/x');

    expect(api.state.log).toEqual([
      '/x Bearer A1 -> 401',
      'refresh',
      'store:R2',
      '/x Bearer A2 -> 200',
    ]);
  });

  it('rule 4: a network failure during refresh keeps the session', async () => {
    const { api, store, client, events } = await signedIn();
    api.expireAccess();
    api.state.refreshMode = 'network';

    await expect(client.apiFetch('/x')).rejects.toBeInstanceOf(NetworkError);
    expect(store.current).toBe('R1');
    expect(events).toEqual([]);
  });

  it('rule 4: a 5xx during refresh keeps the session too', async () => {
    const { api, store, client, events } = await signedIn();
    api.expireAccess();
    api.state.refreshMode = 'server-error';

    await expect(client.apiFetch('/x')).rejects.toBeInstanceOf(NetworkError);
    expect(store.current).toBe('R1');
    expect(events).toEqual([]);
  });

  it("a 401 from refresh is the server's verdict: clear storage, announce signedOut", async () => {
    const { api, store, client, events } = await signedIn();
    api.expireAccess();
    api.state.refreshMode = 'verdict';

    await expect(client.apiFetch('/x')).rejects.toBeInstanceOf(SessionExpiredError);
    expect(store.current).toBeNull();
    expect(events).toEqual(['signedOut']);
    expect(api.state.refreshCalls).toBe(1);
  });

  it('rule 5: retries once and hands back a second 401, never looping', async () => {
    const { api, client } = await signedIn();

    const res = await client.apiFetch('/always-401');

    expect(res.status).toBe(401);
    expect(api.state.refreshCalls).toBe(1);
    expect(api.state.pathCalls['/always-401']).toBe(2);
  });

  it('passes headers from the signing hook on the refresh request (L3 seam)', async () => {
    const { api, client } = setup({
      stored: 'R1',
      signRefresh: async () => ({ 'X-Device-Signature': 'sig-for-R1' }),
    });

    await client.restore();

    expect(api.state.lastRefreshHeaders?.get('X-Device-Signature')).toBe('sig-for-R1');
  });
});

describe('restore (app launch)', () => {
  it('reports no session and makes no request when nothing is stored', async () => {
    const { api, client } = setup();

    await expect(client.restore()).resolves.toBe(false);
    expect(api.state.refreshCalls).toBe(0);
  });

  it('turns a stored token into a live session', async () => {
    const { api, store, client, events } = setup({ stored: 'R1' });

    await expect(client.restore()).resolves.toBe(true);
    expect(events).toEqual(['signedIn']);
    expect(store.current).toBe('R2');
    expect((await client.apiFetch('/accounts')).status).toBe(200);
    expect(api.state.refreshCalls).toBe(1);
  });

  it('reports no session, and clears it, when the server rejects the stored token', async () => {
    const { api, store, client, events } = setup({ stored: 'R1' });
    api.state.refreshMode = 'verdict';

    await expect(client.restore()).resolves.toBe(false);
    expect(store.current).toBeNull();
    expect(events).toEqual(['signedOut']);
  });

  it('keeps the stored session when the server cannot be reached', async () => {
    const { api, store, client, events } = setup({ stored: 'R1' });
    api.state.refreshMode = 'network';

    await expect(client.restore()).rejects.toBeInstanceOf(NetworkError);
    expect(store.current).toBe('R1');
    expect(events).toEqual([]);
  });
});

describe('logout', () => {
  it('rule 6: revokes on the server, clears storage, announces signedOut', async () => {
    const { api, store, client, events } = await signedIn();

    await client.logout();

    expect(api.state.lastLogoutBody).toEqual({ refreshToken: 'R1' });
    expect(store.current).toBeNull();
    expect(events).toEqual(['signedOut']);
  });

  it('rule 6: still clears locally when the API cannot be reached', async () => {
    const { api, store, client, events } = await signedIn();
    const offline = createAuthClient({
      baseUrl: BASE,
      store,
      fetch: (async () => {
        throw new TypeError('Network request failed');
      }) as unknown as typeof fetch,
    });
    offline.onSessionChange((state) => events.push(state));

    await expect(offline.logout()).resolves.toBeUndefined();
    expect(store.current).toBeNull();
    expect(events).toEqual(['signedOut']);
  });

  it('waits for an in-flight refresh, then revokes the NEWEST token, so nothing is resurrected', async () => {
    const { api, store, client } = await signedIn();
    api.expireAccess();
    const gate = deferred();
    api.state.refreshGate = gate.promise;

    const request = client.apiFetch('/x');
    await tick(); // the refresh is now in flight, held at the gate
    const loggingOut = client.logout();
    gate.release();
    await Promise.allSettled([request, loggingOut]);

    expect(api.state.lastLogoutBody).toEqual({ refreshToken: 'R2' });
    expect(store.current).toBeNull();
  });
});
