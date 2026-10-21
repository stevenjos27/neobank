/**
 * Where the refresh token lives between app launches.
 *
 * An interface, not a direct dependency on expo-secure-store, for two
 * reasons:
 *  - auth-client.ts can be tested in Jest with the in-memory store below,
 *    never loading a native module;
 *  - the storage POLICY (keychain accessibility today; hardware-bound
 *    `requireAuthentication` once the unlock gate exists) changes in exactly
 *    one file, secure-token-store.ts, without touching the client.
 *
 * Only the REFRESH token is stored. The access token is short-lived and is
 * held in memory by the client; it never touches disk.
 */
export interface TokenStore {
  getRefreshToken(): Promise<string | null>;
  setRefreshToken(token: string): Promise<void>;
  clear(): Promise<void>;
}

/** For tests: same contract, no native module, inspectable. */
export function createMemoryTokenStore(initial: string | null = null): TokenStore & {
  readonly current: string | null;
} {
  let token = initial;
  return {
    get current() {
      return token;
    },
    async getRefreshToken() {
      return token;
    },
    async setRefreshToken(next: string) {
      token = next;
    },
    async clear() {
      token = null;
    },
  };
}
