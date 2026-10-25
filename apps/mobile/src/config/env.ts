import { parseApiUrl } from './parse-api-url';

/**
 * The API base URL, inlined into the bundle by babel-preset-expo.
 *
 * MUST stay written exactly as `process.env.EXPO_PUBLIC_API_URL`:
 *  - not destructured: const { EXPO_PUBLIC_API_URL } = process.env
 *  - not computed:     process.env[`EXPO_PUBLIC_${name}`]
 * Expo replaces only the literal member expression at build time. Any
 * other form stays a runtime lookup, and on the device process.env does
 * not hold these values, so it reads undefined.
 *
 * Evaluated on import: a missing or unsafe URL stops the app at launch
 * with the fix in the message. Import it from the composition root only;
 * tests use parseApiUrl with explicit inputs.
 */
export const API_URL = parseApiUrl(process.env.EXPO_PUBLIC_API_URL, __DEV__);
