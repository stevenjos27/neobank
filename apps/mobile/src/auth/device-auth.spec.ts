import type {
  LocalAuthenticationError,
  LocalAuthenticationOptions,
  LocalAuthenticationResult,
} from 'expo-local-authentication';
import { biometricLevelFor, classifyResult, createDeviceAuth } from './device-auth';
import type { LocalAuthModule, UnlockOutcome } from './device-auth';

/**
 * A fake authenticateAsync whose prompts stay open until the test settles
 * them, so concurrency is controlled by the test, not by timing.
 */
function fakeLocalAuth() {
  const calls: LocalAuthenticationOptions[] = [];
  const open: {
    resolve: (r: LocalAuthenticationResult) => void;
    reject: (e: unknown) => void;
  }[] = [];

  const la: LocalAuthModule = {
    authenticateAsync: (options?: LocalAuthenticationOptions) => {
      calls.push(options ?? {});
      return new Promise((resolve, reject) => open.push({ resolve, reject }));
    },
  };

  const next = () => {
    const prompt = open.shift();
    if (!prompt) throw new Error('no prompt is open');
    return prompt;
  };

  return {
    la,
    calls,
    succeed: () => next().resolve({ success: true }),
    failWith: (error: LocalAuthenticationError) => next().resolve({ success: false, error }),
    reject: (e: unknown) => next().reject(e),
  };
}

describe('classifyResult', () => {
  it('success → unlocked', () => {
    expect(classifyResult({ success: true })).toBe('unlocked');
  });

  it.each<[LocalAuthenticationError, UnlockOutcome]>([
    ['user_cancel', 'cancelled'],
    ['system_cancel', 'cancelled'],
    ['app_cancel', 'cancelled'],
    ['user_fallback', 'cancelled'],
    ['lockout', 'locked_out'],
    ['not_enrolled', 'unavailable'],
    ['not_available', 'unavailable'],
    ['passcode_not_set', 'unavailable'],
    ['authentication_failed', 'failed'],
    ['timeout', 'failed'],
    ['unable_to_process', 'failed'],
    ['invalid_context', 'failed'],
    ['no_space', 'failed'],
    ['unknown', 'failed'],
  ])('%s → %s', (error, outcome) => {
    expect(classifyResult({ success: false, error })).toBe(outcome);
  });

  it('an error string the types do not know fails closed', () => {
    const error = 'added_in_a_future_sdk' as LocalAuthenticationError;
    expect(classifyResult({ success: false, error })).toBe('failed');
  });
});

describe('biometricLevelFor', () => {
  it.each<[string, string | number, 'weak' | 'strong']>([
    ['android', 29, 'weak'],
    ['android', 30, 'strong'],
    ['android', 35, 'strong'],
    ['android', '35', 'strong'],
    ['ios', '18.1', 'weak'],
    ['ios', '30.0', 'weak'],
  ])('%s %s → %s', (os, version, level) => {
    expect(biometricLevelFor(os, version)).toBe(level);
  });
});

describe('createDeviceAuth', () => {
  it('asks for biometrics WITH device-passcode fallback, at the given level', () => {
    const fake = fakeLocalAuth();
    void createDeviceAuth(fake.la, 'strong').unlock();

    expect(fake.calls).toEqual([
      {
        promptMessage: 'Unlock NeoBank',
        disableDeviceFallback: false,
        biometricsSecurityLevel: 'strong',
      },
    ]);
  });

  it('concurrent unlock() calls share ONE native prompt and its outcome', async () => {
    const fake = fakeLocalAuth();
    const auth = createDeviceAuth(fake.la, 'weak');

    const first = auth.unlock();
    const second = auth.unlock();
    expect(fake.calls).toHaveLength(1);

    fake.succeed();
    await expect(Promise.all([first, second])).resolves.toEqual(['unlocked', 'unlocked']);
  });

  it('once a prompt settles, the next unlock() opens a fresh one (Retry works)', async () => {
    const fake = fakeLocalAuth();
    const auth = createDeviceAuth(fake.la, 'weak');

    const first = auth.unlock();
    fake.failWith('user_cancel');
    await expect(first).resolves.toBe('cancelled');

    const retry = auth.unlock();
    expect(fake.calls).toHaveLength(2);
    fake.succeed();
    await expect(retry).resolves.toBe('unlocked');
  });

  it('a native rejection fails closed as "failed", never throws', async () => {
    const fake = fakeLocalAuth();
    const attempt = createDeviceAuth(fake.la, 'weak').unlock();

    fake.reject(new Error('Authenticator combination is unsupported on API 28-29'));
    await expect(attempt).resolves.toBe('failed');
  });
});
