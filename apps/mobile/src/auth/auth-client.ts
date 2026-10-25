import type { TokenStore } from './token-store';

/**
 * The mobile app's only path to the API: login, restore, authenticated
 * requests with single-flight refresh, and logout.
 *
 * Plain TypeScript — no React. fetch, the token store and the base URL are
 * injected, so every rule below is unit-tested with fakes
 * (auth-client.spec.ts). Screens only call into this.
 *
 * THE RULES (each one is a test):
 *  1. Single flight: concurrent refreshes share ONE promise. Five requests
 *     hitting 401 together cause one POST /auth/refresh. This — not the API's
 *     10 s grace window, which exists for the web proxy — is why mobile never
 *     presents the same refresh token twice.
 *  2. A late 401 does not refresh again: if the access token changed while a
 *     request was in flight, that request retries with the new one.
 *  3. Store first, then use: the rotated refresh token is persisted BEFORE the
 *     new access token is used. A crash in between leaves the old (already
 *     used) token stored; the server treats its next use as reuse and ends
 *     the session — a forced login, never a leak.
 *  4. Offline is not logged out: a network failure, 5xx or 429 during refresh
 *     clears nothing. Only a 4xx verdict on the token ends the session.
 *  5. One retry per request, never a loop.
 *  6. Logout always clears locally, even if the API call fails.
 *
 * The access token lives only in this closure; it never touches storage.
 */

export type SessionState = 'signedIn' | 'signedOut';

/** Login rejected; `message` is the API's own (e.g. "invalid credentials"). */
export class LoginFailedError extends Error {
  constructor(message: string, readonly status: number) {
    super(message);
    this.name = 'LoginFailedError';
  }
}

/** The session is over (revoked, reused, expired, or never existed). Log in again. */
export class SessionExpiredError extends Error {
  constructor(message = 'session expired') {
    super(message);
    this.name = 'SessionExpiredError';
  }
}

/** Could not get an answer about the session. Nothing was cleared; retry later. */
export class NetworkError extends Error {
  constructor(message: string, readonly cause?: unknown) {
    super(message);
    this.name = 'NetworkError';
  }
}

/**
 * Hook for device-key binding (post-launch backlog L3): returns extra headers
 * for the refresh request, e.g. a signature from a hardware-backed key.
 * Unused at launch; present so binding slots in without restructuring.
 */
export type RefreshRequestSigner = (body: { refreshToken: string }) => Promise<Record<string, string>>;

export interface AuthClientOptions {
  /** API root including the global prefix, no trailing slash: `http://host:3000/api`. */
  baseUrl: string;
  store: TokenStore;
  fetch?: typeof fetch;
  signRefresh?: RefreshRequestSigner;
}

export interface AuthClient {
  login(email: string, password: string): Promise<void>;
  /** On launch: true if a stored session was refreshed into a live one. */
  restore(): Promise<boolean>;
  apiFetch(path: string, init?: RequestInit): Promise<Response>;
  logout(): Promise<void>;
  onSessionChange(listener: (state: SessionState) => void): () => void;
  /** For the dev-only diagnostics controls; never used by product screens. */
  readonly debug: {
    corruptAccessToken(): void;
    refreshCount(): number;
  };
}

interface TokenPair {
  accessToken: string;
  refreshToken: string;
}

/** A 4xx other than 429 is the server's verdict on the token: the session is over. */
function isSessionVerdict(status: number): boolean {
  return status >= 400 && status < 500 && status !== 429;
}

/** Nest errors carry `message` as a string or an array of validation messages. */
function messageFrom(body: unknown): string | undefined {
  if (typeof body !== 'object' || body === null || !('message' in body)) return undefined;
  const message = (body as { message: unknown }).message;
  if (typeof message === 'string') return message;
  if (Array.isArray(message)) return message.join(', ');
  return undefined;
}

export function createAuthClient(options: AuthClientOptions): AuthClient {
  const { baseUrl, store, signRefresh } = options;
  const doFetch = options.fetch ?? fetch;

  let accessToken: string | null = null;
  let inflight: Promise<string> | null = null;
  let refreshes = 0;
  const listeners = new Set<(state: SessionState) => void>();

  const emit = (state: SessionState) => listeners.forEach((listener) => listener(state));

  async function request(path: string, init: RequestInit): Promise<Response> {
    try {
      return await doFetch(`${baseUrl}${path}`, init);
    } catch (cause) {
      throw new NetworkError(`could not reach ${path}`, cause);
    }
  }

  function postJson(path: string, body: unknown, headers: Record<string, string> = {}) {
    return request(path, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...headers },
      body: JSON.stringify(body),
    });
  }

  async function endSession(): Promise<void> {
    accessToken = null;
    await store.clear();
    emit('signedOut');
  }

  async function runRefresh(): Promise<string> {
    const refreshToken = await store.getRefreshToken();
    if (!refreshToken) {
      await endSession();
      throw new SessionExpiredError('no stored session');
    }

    refreshes += 1;
    const extraHeaders = signRefresh ? await signRefresh({ refreshToken }) : {};
    // A NetworkError from here propagates with storage untouched (rule 4).
    const res = await postJson('/auth/refresh', { refreshToken }, extraHeaders);

    if (isSessionVerdict(res.status)) {
      await endSession();
      throw new SessionExpiredError();
    }
    if (!res.ok) {
      throw new NetworkError(`refresh failed with HTTP ${res.status}`);
    }

    const tokens = (await res.json()) as TokenPair;
    await store.setRefreshToken(tokens.refreshToken); // rule 3: persist first…
    accessToken = tokens.accessToken; //                   …then use
    return tokens.accessToken;
  }

  /** Rule 1: one refresh at a time; every caller during it shares its result. */
  function refresh(): Promise<string> {
    if (!inflight) {
      inflight = runRefresh().finally(() => {
        inflight = null;
      });
    }
    return inflight;
  }

  function send(path: string, init: RequestInit, token: string): Promise<Response> {
    const headers = new Headers(init.headers);
    headers.set('Authorization', `Bearer ${token}`);
    return request(path, { ...init, headers });
  }

  async function apiFetch(path: string, init: RequestInit = {}): Promise<Response> {
    const usedToken = accessToken ?? (await refresh());
    const first = await send(path, init, usedToken);
    if (first.status !== 401) return first;

    // Rule 2: another request already refreshed while this one was in flight.
    const retryToken = accessToken !== null && accessToken !== usedToken ? accessToken : await refresh();

    return send(path, init, retryToken); // rule 5: exactly one retry
  }

  async function login(email: string, password: string): Promise<void> {
    const res = await postJson('/auth/login', { email, password });
    if (!res.ok) {
      const body: unknown = await res.json().catch(() => undefined);
      throw new LoginFailedError(messageFrom(body) ?? 'Login failed', res.status);
    }
    const tokens = (await res.json()) as TokenPair;
    await store.setRefreshToken(tokens.refreshToken);
    accessToken = tokens.accessToken;
    emit('signedIn');
  }

  async function restore(): Promise<boolean> {
    if (!(await store.getRefreshToken())) return false;
    try {
      await refresh();
    } catch (error) {
      if (error instanceof SessionExpiredError) return false;
      throw error; // NetworkError: keep the session, let the screen offer "retry"
    }
    emit('signedIn');
    return true;
  }

  async function logout(): Promise<void> {
    // A refresh finishing after we clear would write a new token back:
    // let it land first, then revoke and clear whatever is current.
    if (inflight) await inflight.catch(() => undefined);

    const refreshToken = await store.getRefreshToken();
    if (refreshToken) {
      try {
        await postJson('/auth/logout', { refreshToken });
      } catch {
        // Rule 6: the server may keep the session until it expires, but this
        // device's only copy of its token is about to be deleted.
      }
    }
    await endSession();
  }

  return {
    login,
    restore,
    apiFetch,
    logout,
    onSessionChange(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    debug: {
      corruptAccessToken() {
        accessToken = 'corrupted.by.diagnostics';
      },
      refreshCount() {
        return refreshes;
      },
    },
  };
}
