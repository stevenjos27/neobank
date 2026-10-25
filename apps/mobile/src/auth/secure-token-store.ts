import * as SecureStore from 'expo-secure-store';
import type { TokenStore } from './token-store';

/**
 * The refresh token in the platform's secure storage: iOS Keychain, Android
 * Keystore-backed encrypted storage.
 *
 * ONE options object for get, set and delete. An item saved under a
 * keychainService can only be read back with that same service; options that
 * drift apart between calls make reads silently return null.
 *
 * WHEN_UNLOCKED_THIS_DEVICE_ONLY (iOS):
 *  - readable only while the phone is unlocked. NeoBank never refreshes in
 *    the background, so nothing legitimate needs it while locked;
 *  - THIS_DEVICE_ONLY: never copied into an iCloud/iTunes backup, so it cannot
 *    be restored onto another phone.
 *
 * Deliberately NOT stored with `requireAuthentication`: that prompts on
 * every update (iOS) or every operation (Android), and this token rotates on
 * every refresh. Refresh stays silent; user presence is enforced by the app
 * unlock gate, and possession of the device by the device-key binding
 * (post-launch backlog L3).
 */
const KEY = 'refreshToken';

const OPTIONS: SecureStore.SecureStoreOptions = {
  keychainService: 'neobank.session',
  keychainAccessible: SecureStore.WHEN_UNLOCKED_THIS_DEVICE_ONLY,
};

export const secureTokenStore: TokenStore = {
  getRefreshToken() {
    return SecureStore.getItemAsync(KEY, OPTIONS);
  },
  setRefreshToken(token: string) {
    return SecureStore.setItemAsync(KEY, token, OPTIONS);
  },
  clear() {
    return SecureStore.deleteItemAsync(KEY, OPTIONS);
  }
};
