import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
} from '@testing-library/react-native';
import { useAuth } from '../auth/AuthProvider';
import type { AuthContextValue } from '../auth/AuthProvider';
import type { UnlockOutcome } from '../auth/device-auth';
import { deferred, fakeAuth } from '../test/fake-auth';
import UnlockScreen, { unlockMessage } from './UnlockScreen';

jest.mock('../auth/AuthProvider', () => ({ useAuth: jest.fn() }));

async function renderWith(overrides: Partial<AuthContextValue>) {
  jest
    .mocked(useAuth)
    .mockReturnValue(
      fakeAuth({ status: 'signedIn', locked: true, ...overrides }),
    );
  await render(<UnlockScreen />);
}

const unlockMock = () => jest.fn<Promise<UnlockOutcome>, []>();

describe('unlockMessage', () => {
  it.each<[UnlockOutcome, RegExp]>([
    ['failed', /^Couldn.t confirm it.s you/],
    ['locked_out', /^Too many attempts.*password/],
    ['unavailable', /screen lock.*password/],
  ])('%s → tells the user what to do', (outcome, expected) => {
    expect(unlockMessage(outcome)).toMatch(expected);
  });

  it.each<UnlockOutcome | null>(['cancelled', 'unlocked', null])(
    '%s → no message',
    (outcome) => {
      expect(unlockMessage(outcome)).toBeNull();
    },
  );
});

describe('UnlockScreen', () => {
  it('prompts once on arrival, and everything waits for it', async () => {
    const held = deferred<UnlockOutcome>();
    const unlock = unlockMock().mockImplementation(() => held.promise);
    await renderWith({ unlock });

    expect(
      await screen.findByLabelText('Waiting for unlock'),
    ).toBeOnTheScreen();
    expect(unlock).toHaveBeenCalledTimes(1);
    expect(screen.getByRole('button', { busy: true })).toBeDisabled();
    expect(
      screen.getByRole('button', { name: 'Use password instead' }),
    ).toBeDisabled();

    await act(async () => {
      held.resolve('cancelled');
    });
  });

  it('after a cancel: no message, no automatic re-prompt; tapping Unlock prompts again', async () => {
    const unlock = unlockMock().mockResolvedValue('cancelled');
    await renderWith({ unlock });

    expect(await screen.findByRole('button', { name: 'Unlock' })).toBeEnabled();
    expect(unlock).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole('alert')).toBeNull();

    await fireEvent.press(screen.getByRole('button', { name: 'Unlock' }));
    await waitFor(() => expect(unlock).toHaveBeenCalledTimes(2));
    await screen.findByRole('button', { name: 'Unlock' });
  });

  it('a failed prompt explains, and Unlock is still offered', async () => {
    await renderWith({ unlock: unlockMock().mockResolvedValue('failed') });

    expect(await screen.findByRole('alert')).toHaveTextContent(
      /Couldn.t confirm/,
    );
    expect(screen.getByRole('button', { name: 'Unlock' })).toBeEnabled();
  });

  it('tapping Unlock clears the old message while it prompts', async () => {
    const held = deferred<UnlockOutcome>();
    const unlock = unlockMock()
      .mockResolvedValueOnce('failed')
      .mockImplementationOnce(() => held.promise);
    await renderWith({ unlock });
    await screen.findByRole('alert');

    await fireEvent.press(screen.getByRole('button', { name: 'Unlock' }));

    await screen.findByLabelText('Waiting for unlock');
    expect(screen.queryByRole('alert')).toBeNull();

    await act(async () => {
      held.resolve('cancelled');
    });
  });

  it.each<UnlockOutcome>(['locked_out', 'unavailable'])(
    '%s → only "Sign in with password" (another prompt cannot work)',
    async (outcome) => {
      await renderWith({ unlock: unlockMock().mockResolvedValue(outcome) });

      expect(
        await screen.findByRole('button', { name: 'Sign in with password' }),
      ).toBeEnabled();
      expect(screen.queryByRole('button', { name: 'Unlock' })).toBeNull();
      expect(
        screen.queryByRole('button', { name: 'Use password instead' }),
      ).toBeNull();
      expect(screen.getByRole('alert')).toBeOnTheScreen();
    },
  );

  it('"Use password instead" signs out, and nothing else can start meanwhile', async () => {
    const held = deferred();
    const signOut = jest.fn(() => held.promise);
    await renderWith({
      unlock: unlockMock().mockResolvedValue('cancelled'),
      signOut,
    });
    await screen.findByRole('button', { name: 'Unlock' });

    void fireEvent.press(
      screen.getByRole('button', { name: 'Use password instead' }),
    );

    await waitFor(() => expect(signOut).toHaveBeenCalledTimes(1));
    expect(screen.getByRole('button', { name: 'Unlock' })).toBeDisabled();

    await act(async () => {
      held.resolve();
    });
  });
});
