import { act, fireEvent, render, screen } from '@testing-library/react-native';
import { LoginFailedError, NetworkError } from '../auth/auth-client';
import { useAuth } from '../auth/AuthProvider';
import { deferred, fakeAuth } from '../test/fake-auth';
import LoginScreen, { loginErrorMessage } from './LoginScreen';

jest.mock('../auth/AuthProvider', () => ({ useAuth: jest.fn() }));

const signInMock = () => jest.fn<Promise<void>, [string, string]>();

async function renderWith(signIn: ReturnType<typeof signInMock>) {
  jest
    .mocked(useAuth)
    .mockReturnValue(fakeAuth({ status: 'signedOut', signIn }));
  await render(<LoginScreen />);
}

async function fill(email: string, password: string) {
  await fireEvent.changeText(screen.getByLabelText('Email'), email);
  await fireEvent.changeText(screen.getByLabelText('Password'), password);
}

const signInButton = () => screen.getByRole('button', { name: 'Sign in' });

describe('loginErrorMessage', () => {
  it.each<[string, unknown, RegExp]>([
    [
      '400 (validation)',
      new LoginFailedError('password must be longer than 8', 400),
      /^Email or password is incorrect\.$/,
    ],
    [
      '401 (wrong credentials)',
      new LoginFailedError('invalid credentials', 401),
      /^Email or password is incorrect\.$/,
    ],
    [
      '429 (throttled)',
      new LoginFailedError('Too Many Requests', 429),
      /^Too many attempts/,
    ],
    [
      '500 (server)',
      new LoginFailedError('Internal server error', 500),
      /couldn.t sign you in right now/,
    ],
    [
      'NetworkError',
      new NetworkError('could not reach /auth/login'),
      /^Can.t reach NeoBank/,
    ],
    ['anything else', new Error('boom'), /^Something went wrong/],
  ])('%s', (_label, error, expected) => {
    expect(loginErrorMessage(error)).toMatch(expected);
  });
});

describe('LoginScreen', () => {
  it('Sign in stays disabled until both fields are filled (spaces do not count)', async () => {
    await renderWith(signInMock());
    expect(signInButton()).toBeDisabled();

    await fill('   ', 'correct horse');
    expect(signInButton()).toBeDisabled();

    await fill('asha@example.com', 'correct horse');
    expect(signInButton()).toBeEnabled();
  });

  it('submits the trimmed email and the password exactly as typed', async () => {
    const signIn = signInMock().mockResolvedValue(undefined);
    await renderWith(signIn);

    await fill('  asha@example.com ', ' correct horse ');
    await fireEvent.press(signInButton());

    expect(signIn).toHaveBeenCalledTimes(1);
    expect(signIn).toHaveBeenCalledWith('asha@example.com', ' correct horse ');
  });

  it('"Go" on the keyboard with the password still empty does nothing', async () => {
    const signIn = signInMock();
    await renderWith(signIn);

    await fireEvent.changeText(
      screen.getByLabelText('Email'),
      'asha@example.com',
    );
    await fireEvent(screen.getByLabelText('Password'), 'submitEditing');

    expect(signIn).not.toHaveBeenCalled();
  });

  it('while signing in: busy, and both fields are locked', async () => {
    const held = deferred();
    const signIn = signInMock().mockImplementation(() => held.promise);
    await renderWith(signIn);
    await fill('asha@example.com', 'correct horse');

    void fireEvent.press(signInButton()); // held open: see deferred() in fake-auth.ts

    expect(await screen.findByLabelText('Signing in')).toBeOnTheScreen();
    expect(screen.getByRole('button')).toBeBusy();
    expect(screen.getByLabelText('Email')).toBeDisabled();
    expect(screen.getByLabelText('Password')).toBeDisabled();

    await act(async () => {
      held.resolve();
    });
  });

  it('a rejected login: says so, clears the password, keeps the email', async () => {
    const signIn = signInMock().mockRejectedValueOnce(
      new LoginFailedError('invalid credentials', 401),
    );
    await renderWith(signIn);
    await fill('asha@example.com', 'wrong password');

    await fireEvent.press(signInButton());

    expect(screen.getByRole('alert')).toHaveTextContent(
      'Email or password is incorrect.',
    );
    expect(screen.getByLabelText('Password')).toHaveDisplayValue('');
    expect(screen.getByLabelText('Email')).toHaveDisplayValue(
      'asha@example.com',
    );
    expect(signInButton()).toBeDisabled(); // password is empty again
  });

  it('a new attempt clears the previous error while it runs', async () => {
    const held = deferred();
    const signIn = signInMock()
      .mockRejectedValueOnce(new LoginFailedError('invalid credentials', 401))
      .mockImplementationOnce(() => held.promise);
    await renderWith(signIn);
    await fill('asha@example.com', 'wrong password');
    await fireEvent.press(signInButton());
    expect(screen.getByRole('alert')).toBeOnTheScreen();

    await fireEvent.changeText(
      screen.getByLabelText('Password'),
      'correct horse',
    );
    void fireEvent.press(signInButton());

    await screen.findByLabelText('Signing in');
    expect(screen.queryByRole('alert')).toBeNull();

    await act(async () => {
      held.resolve();
    });
  });
});
