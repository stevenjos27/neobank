import type { AuthContextValue } from '../auth/AuthProvider';

/**
 * Test-only helpers for screen tests, which replace useAuth with
 * jest.mock('../auth/AuthProvider', () => ({ useAuth: jest.fn() })).
 *
 * Never imported by app code, so Metro never bundles it, and it is not a
 * *.test / *.spec file, so Jest never runs it as a suite.
 */

/**
 * A complete AuthContextValue. Typed against the real contract, so a
 * field added to or renamed in the provider fails typecheck here, not
 * silently in every screen test.
 */
export function fakeAuth(overrides: Partial<AuthContextValue> = {}): AuthContextValue {
  return {
    status: 'signedIn',
    locked: true,
    signIn: jest.fn(async () => undefined),
    unlock: jest.fn(async () => 'unlocked' as const),
    signOut: jest.fn(async () => undefined),
    retry: jest.fn(async () => undefined),
    apiFetch: jest.fn(),
    debug: null,
    ...overrides,
  };
}

/**
 * A promise the test settles by hand, for inspecting the in-between state
 * (busy, disabled) of an async action without timers.
 *
 * RNTL 14: fireEvent resolves only after an async handler settles, so
 * start the press without awaiting it, then wait on what the user sees.
 */
export function deferred<T = void>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}
