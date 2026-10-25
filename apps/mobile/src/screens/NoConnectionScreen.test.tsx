import { act, fireEvent, render, screen } from '@testing-library/react-native';
import { useAuth } from '../auth/AuthProvider';
import { deferred, fakeAuth } from '../test/fake-auth';
import NoConnectionScreen from './NoConnectionScreen';

// The screen is tested on its own: useAuth is replaced, so each test
// controls exactly what the provider would return. The provider's own
// behaviour is covered by AuthProvider.test.tsx.
jest.mock('../auth/AuthProvider', () => ({ useAuth: jest.fn() }));

describe('NoConnectionScreen', () => {
  it('tells the user what happened, and that they are still signed in', async () => {
    jest.mocked(useAuth).mockReturnValue(fakeAuth({ status: 'unreachable' }));
    await render(<NoConnectionScreen />);

    expect(
      screen.getByRole('header', { name: /can.t reach neobank/i }),
    ).toBeOnTheScreen();
    expect(screen.getByText(/still signed in/)).toBeOnTheScreen();
    expect(screen.getByRole('button', { name: 'Try again' })).toBeEnabled();
  });

  it('while retrying: busy and disabled, and a second tap does not retry again', async () => {
    const held = deferred();
    const retry = jest.fn(() => held.promise);
    jest
      .mocked(useAuth)
      .mockReturnValue(fakeAuth({ status: 'unreachable', retry }));
    await render(<NoConnectionScreen />);

    // Not awaited: RNTL 14's fireEvent resolves only when the async
    // onPress finishes, and this retry is held open on purpose.
    void fireEvent.press(screen.getByRole('button', { name: 'Try again' }));

    expect(await screen.findByLabelText('Retrying')).toBeOnTheScreen();
    const button = screen.getByRole('button');
    expect(button).toBeDisabled();
    expect(button).toBeBusy();

    // Disabled: RNTL finds no enabled handler, so this returns at once.
    await fireEvent.press(button);
    expect(retry).toHaveBeenCalledTimes(1);
  });

  it('once the retry settles (still offline), the button comes back', async () => {
    const held = deferred();
    const retry = jest.fn(() => held.promise);
    jest
      .mocked(useAuth)
      .mockReturnValue(fakeAuth({ status: 'unreachable', retry }));
    await render(<NoConnectionScreen />);

    const pressing = fireEvent.press(
      screen.getByRole('button', { name: 'Try again' }),
    );
    await screen.findByLabelText('Retrying');

    await act(async () => {
      held.resolve();
      await pressing; // settles after onRetry's finally has run
    });

    expect(screen.getByRole('button', { name: 'Try again' })).toBeEnabled();
    expect(screen.queryByLabelText('Retrying')).toBeNull();
  });
});
