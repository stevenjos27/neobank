import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useReducer,
  useRef,
  useState,
} from 'react';
import type { ReactNode } from 'react';
import { AppState } from 'react-native';
import { NetworkError } from './auth-client';
import type { AuthClient } from './auth-client';
import type { DeviceAuth, UnlockOutcome } from './device-auth';
import { LOCKED, lockReducer } from './lock-machine';

/**
 * Combines the two sources of truth the screens route on:
 *  - the auth client: is there a session at all, and could we check it?
 *  - the lock machine: is the UI locked?
 *
 *   restoring                → nothing yet (splash)
 *   unreachable              → No connection, Retry
 *   signedOut                → Login
 *   signedIn && locked       → Unlock
 *   signedIn && !locked      → Home
 *
 * The client and device auth are injected, so tests drive every
 * transition with fakes; app/_layout.tsx passes the real ones.
 */
export type AuthStatus = 'restoring' | 'unreachable' | 'signedOut' | 'signedIn';

export interface AuthContextValue {
  status: AuthStatus;
  locked: boolean;
  /** Throws LoginFailedError / NetworkError for the Login screen to show. */
  signIn(email: string, password: string): Promise<void>;
  unlock(): Promise<UnlockOutcome>;
  signOut(): Promise<void>;
  /** From 'unreachable' only: check the stored session again. */
  retry(): Promise<void>;
  apiFetch: AuthClient['apiFetch'];
  /** Dev-only diagnostics hooks; null in release builds. */
  debug: AuthClient['debug'] | null;
}

const AuthContext = createContext<AuthContextValue | null>(null);

export interface AuthProviderProps {
  client: AuthClient;
  deviceAuth: DeviceAuth;
  /** Clock for the re-lock timer; injectable for tests. */
  now?: () => number;
  children: ReactNode;
}

export function AuthProvider({
  client,
  deviceAuth,
  now = Date.now,
  children,
}: AuthProviderProps) {
  const [status, setStatus] = useState<AuthStatus>('restoring');
  const [lock, dispatch] = useReducer(lockReducer, LOCKED);

  // A restore can settle after unmount (Fast Refresh, a test ending);
  // its result must not land on a provider that is gone.
  const mounted = useRef(false);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  // ONE restore path for launch and Retry, so they cannot drift apart.
  // Refresh first: the server decides Unlock vs Login before any prompt.
  // Offline with a stored session blocks on 'unreachable' (nothing is
  // cleared: offline is not logged out). Anything else fails closed.
  const runRestore = useCallback(async () => {
    let next: AuthStatus;
    try {
      next = (await client.restore()) ? 'signedIn' : 'signedOut';
    } catch (error) {
      next = error instanceof NetworkError ? 'unreachable' : 'signedOut';
    }
    if (mounted.current) setStatus(next);
  }, [client]);

  useEffect(() => {
    void runRestore();
  }, [runRestore]);

  // Stays on 'unreachable' while retrying (no flash back to the splash);
  // the screen shows its own "Retrying…" state.
  const retry = useCallback(async () => {
    if (status !== 'unreachable') return;
    await runRestore();
  }, [runRestore, status]);

  // The session can end anywhere (logout, a refresh verdict during any
  // request). 'signedIn' is ignored here: signIn and restore set it
  // themselves, so it never lands without the matching lock state.
  useEffect(
    () =>
      client.onSessionChange((state) => {
        if (state === 'signedOut') {
          setStatus('signedOut');
          dispatch({ type: 'LOCK' });
        }
      }),
    [client],
  );

  // Re-lock input (Decision 2). 'inactive' is ignored: iOS reports it for
  // the Face ID sheet, Control Centre and the app switcher. Only a real
  // trip to the background starts the clock.
  useEffect(() => {
    const subscription = AppState.addEventListener('change', (next) => {
      if (next === 'background') dispatch({ type: 'BACKGROUNDED', at: now() });
      else if (next === 'active') dispatch({ type: 'FOREGROUNDED', at: now() });
    });
    return () => subscription.remove();
  }, [now]);

  const signIn = useCallback(
    async (email: string, password: string) => {
      await client.login(email, password);
      // Credentials just proved the user: straight to Home, no prompt.
      // Both updates in one synchronous block, so React commits them together.
      setStatus('signedIn');
      dispatch({ type: 'UNLOCKED' });
    },
    [client],
  );

  const unlock = useCallback(async () => {
    const outcome = await deviceAuth.unlock();
    if (outcome === 'unlocked') dispatch({ type: 'UNLOCKED' });
    return outcome;
  }, [deviceAuth]);

  const signOut = useCallback(() => client.logout(), [client]);

  const locked = lock.status === 'locked';
  const value = useMemo<AuthContextValue>(
    () => ({
      status,
      locked,
      signIn,
      unlock,
      signOut,
      retry,
      apiFetch: client.apiFetch,
      debug: __DEV__ ? client.debug : null,
    }),
    [status, locked, signIn, unlock, signOut, retry, client],
  );

  return <AuthContext value={value}>{children}</AuthContext>;
}

export function useAuth(): AuthContextValue {
  const value = useContext(AuthContext);
  if (!value) throw new Error('useAuth must be used inside <AuthProvider>');
  return value;
}
