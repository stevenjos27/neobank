import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
} from '@testing-library/react-native';
import { router } from 'expo-router';
import { useAuth } from '../auth/AuthProvider';
import type { AuthContextValue } from '../auth/AuthProvider';
import { deferred, fakeAuth } from '../test/fake-auth';
import HomeScreen from './HomeScreen';

jest.mock('../auth/AuthProvider', () => ({ useAuth: jest.fn() }));
// Only the imperative router is used; no navigator needed in the test.
jest.mock('expo-router', () => ({ router: { push: jest.fn() } }));

async function renderWith(overrides: Partial<AuthContextValue> = {}) {
  jest
    .mocked(useAuth)
    .mockReturnValue(
      fakeAuth({ status: 'signedIn', locked: false, ...overrides }),
    );
  await render(<HomeScreen />);
}

const signOutButton = () => screen.getByRole('button', { name: 'Sign out' });

beforeEach(() => {
  jest.mocked(router.push).mockClear();
});

describe('HomeScreen', () => {
  it('shows the signed-in placeholder with Sign out available', async () => {
    await renderWith();

    expect(screen.getByRole('header', { name: 'NeoBank' })).toBeOnTheScreen();
    expect(screen.getByText(/signed in/)).toBeOnTheScreen();
    expect(signOutButton()).toBeEnabled();
  });

  it('Sign out calls the provider once; busy and disabled while it runs', async () => {
    const held = deferred();
    const signOut = jest.fn(() => held.promise);
    await renderWith({ signOut });

    void fireEvent.press(signOutButton()); // held open: see deferred() in fake-auth.ts

    await waitFor(() => expect(signOutButton()).toBeBusy());
    expect(signOutButton()).toBeDisabled();

    await fireEvent.press(signOutButton()); // disabled: returns at once
    expect(signOut).toHaveBeenCalledTimes(1);

    await act(async () => {
      held.resolve();
    });
  });

  it('in development, links to the diagnostics screen', async () => {
    await renderWith();

    await fireEvent.press(
      screen.getByRole('button', { name: 'Diagnostics (dev only)' }),
    );

    expect(router.push).toHaveBeenCalledWith('/diagnostics');
  });
});
