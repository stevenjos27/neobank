/**
 * Validates the API base URL the app was bundled with.
 *
 * Rules:
 *  - required: a missing value is a setup error, reported with the fix;
 *  - scheme://host[:port][/path], no query or fragment;
 *  - https everywhere; plain http ONLY in development builds (__DEV__),
 *    for the local API on the LAN. A release build pointed at http fails
 *    at launch instead of sending passwords in cleartext;
 *  - trailing slashes are stripped: the auth client joins `${base}${path}`
 *    and every path starts with '/'.
 *
 * Regex, not `new URL()`: React Native's URL support has historically been
 * partial, and this check must behave the same in Jest, Hermes and every
 * SDK we upgrade to.
 */
const URL_SHAPE = /^(https?):\/\/[^/\s?#]+(\/[^\s?#]*)?$/i;

export function parseApiUrl(raw: string | undefined, isDev: boolean): string {
  const value = raw?.trim() ?? '';
  if (value === '') {
    throw new Error(
      'EXPO_PUBLIC_API_URL is not set. Copy apps/mobile/.env.example to ' +
      'apps/mobile/.env.local, set it, then restart Metro with --clear.',
    );
  }

  const match = URL_SHAPE.exec(value);
  if (!match) {
    throw new Error(`EXPO_PUBLIC_API_URL is not a valid http(s) URL: "${value}"`);
  }

  const scheme = match[1].toLowerCase();
  if (scheme === 'http' && !isDev) {
    throw new Error('EXPO_PUBLIC_API_URL must use https outside development builds.');
  }

  return value.replace(/\/+$/, '');
}
