import { fireEvent, render, screen } from '@testing-library/react-native';
import { NetworkError } from '../auth/auth-client';
import { useAuth } from '../auth/AuthProvider';
import { fakeAuth } from '../test/fake-auth';
import AuthDebugPanel, { PROBES } from './AuthDebugPanel';

jest.mock('../auth/AuthProvider', () => ({ useAuth: jest.fn() }));

/**
 * A fake session that behaves like the real client from the panel's point
 * of view: a corrupted token costs exactly one refresh, however many
 * requests are in flight (the client's single-flight rule, which
 * auth-client.spec.ts proves; here it only drives the panel's arithmetic).
 * Starts at 1 refresh, as after a launch restore, so the panel must
 * subtract its "before" reading rather than print the raw counter.
 */
function fakeSession() {
  let corrupted = false;
  let refreshes = 1;
  const debug = {
    corruptAccessToken: jest.fn(() => {
      corrupted = true;
    }),
    refreshCount: () => refreshes,
  };
  const apiFetch = jest.fn(async () => {
    if (corrupted) {
      corrupted = false;
      refreshes += 1;
    }
    return { status: 200 } as Response;
  });
  return { debug, apiFetch };
}

async function renderWith(session: ReturnType<typeof fakeSession>) {
  jest.mocked(useAuth).mockReturnValue(fakeAuth({ ...session }));
  await render(<AuthDebugPanel />);
}

const [plain, corrupt, parallel] = PROBES;

describe('AuthDebugPanel', () => {
  it('renders nothing when debug is null (always, in release)', async () => {
    jest.mocked(useAuth).mockReturnValue(fakeAuth());
    await render(<AuthDebugPanel />);

    expect(
      screen.queryByRole('header', { name: 'Auth (dev only)' }),
    ).toBeNull();
  });

  it('plain GET: 200 and no refresh', async () => {
    const session = fakeSession();
    await renderWith(session);

    await fireEvent.press(screen.getByRole('button', { name: plain.label }));

    expect(
      await screen.findByText(`${plain.label}: HTTP 200 · refreshes +0`),
    ).toBeOnTheScreen();
    expect(session.apiFetch).toHaveBeenCalledWith('/accounts');
  });

  it('corrupt then GET: 200 after exactly one refresh', async () => {
    const session = fakeSession();
    await renderWith(session);

    await fireEvent.press(screen.getByRole('button', { name: corrupt.label }));

    expect(
      await screen.findByText(`${corrupt.label}: HTTP 200 · refreshes +1`),
    ).toBeOnTheScreen();
    expect(session.debug.corruptAccessToken).toHaveBeenCalledTimes(1);
  });

  it('corrupt then 3 parallel GETs: three 200s, still one refresh', async () => {
    const session = fakeSession();
    await renderWith(session);

    await fireEvent.press(screen.getByRole('button', { name: parallel.label }));

    expect(
      await screen.findByText(
        `${parallel.label}: HTTP 200, 200, 200 · refreshes +1`,
      ),
    ).toBeOnTheScreen();
    expect(session.apiFetch).toHaveBeenCalledTimes(3);
  });

  it('a failed request shows only the error name', async () => {
    const session = fakeSession();
    session.apiFetch.mockRejectedValueOnce(
      new NetworkError('could not reach /accounts'),
    );
    await renderWith(session);

    await fireEvent.press(screen.getByRole('button', { name: plain.label }));

    expect(
      await screen.findByText(`${plain.label}: NetworkError`),
    ).toBeOnTheScreen();
  });
});
