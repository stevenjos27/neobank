import type { ReactNode } from 'react';
import { AppState } from 'react-native';
import type { AppStateStatus, NativeEventSubscription } from 'react-native';
import { act, renderHook, waitFor } from '@testing-library/react-native';
import { AuthProvider, useAuth } from './AuthProvider';
import { LoginFailedError, NetworkError } from './auth-client';
import type { AuthClient, SessionState } from './auth-client';
import type { DeviceAuth, UnlockOutcome } from './device-auth';

const T0 = Date.UTC(2026, 9, 24, 9, 0, 0);
const MIN = 60_000;
const OFFLINE = () => new NetworkError('could not reach /auth/refresh');

// AppState is captured, not real: the test fires 'background' etc. itself.
let appStateHandler: ((next: AppStateStatus) => void) | null = null;

beforeEach(() => {
  appStateHandler = null;
  jest
    .spyOn(AppState, 'addEventListener')
    .mockImplementation((_type, handler) => {
      appStateHandler = handler;
      return {
        remove: () => {
          appStateHandler = null;
        },
      } as NativeEventSubscription;
    });
});

afterEach(() => {
  jest.restoreAllMocks();
});

const resolves = (value: boolean) => () => Promise.resolve(value);
const rejects = (error: Error) => () => Promise.reject(error);

/** Fake client that behaves like the real one's events: login emits
 *  'signedIn' BEFORE resolving, logout emits 'signedOut'. */
function setup(
  restore: () => Promise<boolean>,
  unlockOutcome: UnlockOutcome = 'unlocked',
) {
  const listeners = new Set<(state: SessionState) => void>();
  const emit = (state: SessionState) =>
    listeners.forEach((listener) => listener(state));

  const client: AuthClient = {
    restore: jest.fn(restore),
    login: jest.fn(async () => emit('signedIn')),
    logout: jest.fn(async () => emit('signedOut')),
    apiFetch: jest.fn(),
    onSessionChange: (listener) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    debug: { corruptAccessToken: () => undefined, refreshCount: () => 0 },
  };
  const deviceAuth: DeviceAuth = { unlock: jest.fn(async () => unlockOutcome) };

  let clock = T0;
  const now = () => clock;
  const wrapper = ({ children }: { children: ReactNode }) => (
    <AuthProvider client={client} deviceAuth={deviceAuth} now={now}>
      {children}
    </AuthProvider>
  );

  return {
    client,
    deviceAuth,
    emit,
    wrapper,
    advance: (ms: number) => {
      clock += ms;
    },
  };
}

async function mount(fakes: ReturnType<typeof setup>) {
  const { result } = await renderHook(() => useAuth(), {
    wrapper: fakes.wrapper,
  });
  /** The routing table in one string: "<status>/<locked|unlocked>". */
  const view = () =>
    `${result.current.status}/${result.current.locked ? 'locked' : 'unlocked'}`;
  return { result, view };
}

async function fire(next: AppStateStatus) {
  await act(async () => {
    if (!appStateHandler)
      throw new Error('AppState listener is not subscribed');
    appStateHandler(next);
  });
}

/** Restored session, unlocked: the starting point for the re-lock tests. */
async function onHome() {
  const fakes = setup(resolves(true));
  const mounted = await mount(fakes);
  await waitFor(() => expect(mounted.view()).toBe('signedIn/locked'));
  await act(async () => {
    await mounted.result.current.unlock();
  });
  expect(mounted.view()).toBe('signedIn/unlocked');
  return { fakes, ...mounted };
}

/** Launched offline with a stored session: the starting point for Retry. */
async function onNoConnection() {
  const fakes = setup(rejects(OFFLINE()));
  const mounted = await mount(fakes);
  await waitFor(() => expect(mounted.view()).toBe('unreachable/locked'));
  return { fakes, ...mounted };
}

describe('AuthProvider: launch', () => {
  it('is "restoring" until restore() settles (splash)', async () => {
    const { view } = await mount(
      setup(() => new Promise<boolean>(() => undefined)),
    );
    expect(view()).toBe('restoring/locked');
  });

  it('active session → Unlock, not Home', async () => {
    const { view } = await mount(setup(resolves(true)));
    await waitFor(() => expect(view()).toBe('signedIn/locked'));
  });

  it('no session, or an expired one → Login', async () => {
    const { view } = await mount(setup(resolves(false)));
    await waitFor(() => expect(view()).toBe('signedOut/locked'));
  });

  it('offline with a stored session → No connection (blocks)', async () => {
    const { view } = await mount(setup(rejects(OFFLINE())));
    await waitFor(() => expect(view()).toBe('unreachable/locked'));
  });

  it('any other launch error fails closed → Login', async () => {
    const { view } = await mount(
      setup(rejects(new Error('keychain unreadable'))),
    );
    await waitFor(() => expect(view()).toBe('signedOut/locked'));
  });
});

describe('AuthProvider: retry from No connection', () => {
  it('still offline → stays on No connection', async () => {
    const { fakes, result, view } = await onNoConnection();

    await act(async () => {
      await result.current.retry();
    });

    expect(fakes.client.restore).toHaveBeenCalledTimes(2);
    expect(view()).toBe('unreachable/locked');
  });

  it('back online with a live session → Unlock', async () => {
    const { fakes, result, view } = await onNoConnection();
    jest.mocked(fakes.client.restore).mockResolvedValueOnce(true);

    await act(async () => {
      await result.current.retry();
    });

    expect(view()).toBe('signedIn/locked');
  });

  it('back online but the session expired meanwhile → Login', async () => {
    const { fakes, result, view } = await onNoConnection();
    jest.mocked(fakes.client.restore).mockResolvedValueOnce(false);

    await act(async () => {
      await result.current.retry();
    });

    expect(view()).toBe('signedOut/locked');
  });

  it('retry() anywhere else does nothing', async () => {
    const fakes = setup(resolves(true));
    const { result, view } = await mount(fakes);
    await waitFor(() => expect(view()).toBe('signedIn/locked'));

    await act(async () => {
      await result.current.retry();
    });

    expect(fakes.client.restore).toHaveBeenCalledTimes(1);
    expect(view()).toBe('signedIn/locked');
  });
});

describe('AuthProvider: sign in', () => {
  it('credentials go straight to Home, with no unlock prompt', async () => {
    const fakes = setup(resolves(false));
    const { result, view } = await mount(fakes);
    await waitFor(() => expect(view()).toBe('signedOut/locked'));

    await act(async () => {
      await result.current.signIn('asha@example.com', 'correct horse');
    });

    expect(view()).toBe('signedIn/unlocked');
    expect(fakes.deviceAuth.unlock).not.toHaveBeenCalled();
  });

  it('a rejected login stays on Login and hands the error to the screen', async () => {
    const fakes = setup(resolves(false));
    jest
      .mocked(fakes.client.login)
      .mockRejectedValueOnce(new LoginFailedError('invalid credentials', 401));
    const { result, view } = await mount(fakes);
    await waitFor(() => expect(view()).toBe('signedOut/locked'));

    await act(async () => {
      await expect(
        result.current.signIn('asha@example.com', 'wrong'),
      ).rejects.toBeInstanceOf(LoginFailedError);
    });

    expect(view()).toBe('signedOut/locked');
  });
});

describe('AuthProvider: unlock', () => {
  it('a successful prompt opens Home', async () => {
    const { result, view } = await mount(setup(resolves(true), 'unlocked'));
    await waitFor(() => expect(view()).toBe('signedIn/locked'));

    let outcome: UnlockOutcome | undefined;
    await act(async () => {
      outcome = await result.current.unlock();
    });

    expect(outcome).toBe('unlocked');
    expect(view()).toBe('signedIn/unlocked');
  });

  it('a cancelled prompt stays locked and reports why', async () => {
    const { result, view } = await mount(setup(resolves(true), 'cancelled'));
    await waitFor(() => expect(view()).toBe('signedIn/locked'));

    let outcome: UnlockOutcome | undefined;
    await act(async () => {
      outcome = await result.current.unlock();
    });

    expect(outcome).toBe('cancelled');
    expect(view()).toBe('signedIn/locked');
  });
});

describe('AuthProvider: session events', () => {
  it('the session ending anywhere → Login, and locked', async () => {
    const { fakes, view } = await onHome();

    await act(async () => {
      fakes.emit('signedOut');
    });

    expect(view()).toBe('signedOut/locked');
  });

  it('a "signedIn" event on its own changes nothing', async () => {
    const fakes = setup(resolves(false));
    const { view } = await mount(fakes);
    await waitFor(() => expect(view()).toBe('signedOut/locked'));

    await act(async () => {
      fakes.emit('signedIn');
    });

    expect(view()).toBe('signedOut/locked');
  });

  it('signOut() goes through the client', async () => {
    const { fakes, result, view } = await onHome();

    await act(async () => {
      await result.current.signOut();
    });

    expect(fakes.client.logout).toHaveBeenCalledTimes(1);
    expect(view()).toBe('signedOut/locked');
  });
});

describe('AuthProvider: re-lock (Decision 2)', () => {
  it('6 minutes in the background → locked again', async () => {
    const { fakes, view } = await onHome();
    await fire('background');
    fakes.advance(6 * MIN);
    await fire('active');
    expect(view()).toBe('signedIn/locked');
  });

  it('2 minutes in the background → still unlocked', async () => {
    const { fakes, view } = await onHome();
    await fire('background');
    fakes.advance(2 * MIN);
    await fire('active');
    expect(view()).toBe('signedIn/unlocked');
  });

  it('"inactive" (Face ID sheet, app switcher) never starts the clock', async () => {
    const { fakes, view } = await onHome();
    await fire('inactive');
    fakes.advance(6 * MIN);
    await fire('active');
    expect(view()).toBe('signedIn/unlocked');
  });
});

describe('useAuth', () => {
  it('throws outside <AuthProvider>', async () => {
    jest.spyOn(console, 'error').mockImplementation(() => undefined);
    const attempt = async () => {
      await renderHook(() => useAuth());
    };
    await expect(attempt()).rejects.toThrow(
      'useAuth must be used inside <AuthProvider>',
    );
  });
});
