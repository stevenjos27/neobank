import { Platform } from 'react-native';
import * as LocalAuthentication from 'expo-local-authentication';
import type {
  BiometricsSecurityLevel,
  LocalAuthenticationError,
  LocalAuthenticationResult,
} from 'expo-local-authentication';

/**
 * Device authentication for the app-unlock gate (Phase 4 Step 2,
 * Decision 1): biometrics, with the device passcode/PIN as fallback.
 *
 * The rest of the app never sees expo-local-authentication's 14 error
 * strings, only these five outcomes, each with one UI response:
 */
export type UnlockOutcome =
  | 'unlocked' // presence proven (biometric or device passcode)
  | 'cancelled' // prompt dismissed by user or system: offer Retry
  | 'failed' // prompt errored or did not match: offer Retry
  | 'locked_out' // too many attempts: offer password sign-in
  | 'unavailable'; // no screen lock set up: password sign-in

/**
 * Record<> over the library's error union: adding an error in a future
 * expo-local-authentication release fails the typecheck here until it is
 * mapped. Anything unmapped at runtime falls to 'failed' (stays locked).
 */
const OUTCOME_BY_ERROR: Record<LocalAuthenticationError, Exclude<UnlockOutcome, 'unlocked'>> = {
  user_cancel: 'cancelled',
  system_cancel: 'cancelled',
  app_cancel: 'cancelled',
  user_fallback: 'cancelled',
  lockout: 'locked_out',
  not_enrolled: 'unavailable',
  not_available: 'unavailable',
  passcode_not_set: 'unavailable',
  authentication_failed: 'failed',
  timeout: 'failed',
  unable_to_process: 'failed',
  invalid_context: 'failed',
  no_space: 'failed',
  unknown: 'failed',
};

export function classifyResult(result: LocalAuthenticationResult): UnlockOutcome {
  if (result.success) return 'unlocked';
  return OUTCOME_BY_ERROR[result.error] ?? 'failed';
}

/**
 * Android only (iOS ignores the option). Class 3 ('strong') biometrics on
 * API 30+. On API 28-29 AndroidX rejects STRONG | DEVICE_CREDENTIAL, so
 * those phones get 'weak', still with the device-credential fallback.
 */
export function biometricLevelFor(os: string, version: string | number): BiometricsSecurityLevel {
  return os === 'android' && Number(version) >= 30 ? 'strong' : 'weak';
}

export type LocalAuthModule = Pick<typeof LocalAuthentication, 'authenticateAsync'>;

export interface DeviceAuth {
  /** Shows the system prompt. Concurrent calls share one prompt. */
  unlock(): Promise<UnlockOutcome>;
}

export function createDeviceAuth(
  la: LocalAuthModule = LocalAuthentication,
  level: BiometricsSecurityLevel = biometricLevelFor(Platform.OS, Platform.Version),
): DeviceAuth {
  let inflight: Promise<UnlockOutcome> | null = null;

  async function attempt(): Promise<UnlockOutcome> {
    try {
      const result = await la.authenticateAsync({
        promptMessage: 'Unlock NeoBank',
        disableDeviceFallback: false,
        biometricsSecurityLevel: level,
      });
      return classifyResult(result);
    } catch {
      return 'failed';
    }
  }

  return {
    unlock() {
      inflight ??= attempt().finally(() => {
        inflight = null;
      });
      return inflight;
    },
  };
}

export const deviceAuth = createDeviceAuth();
