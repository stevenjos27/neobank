/**
 * @neobank/contracts — the public surface.
 *
 * Every export is named, deliberately. `export *` would publish whatever the
 * files below happen to export, including helpers added later for their own
 * use. An index that lists its exports is a decision a reviewer can see; a
 * wildcard is one nobody made.
 *
 * Types are re-exported with `export type`. They have no runtime existence,
 * and saying so lets per-file transpilers — the web app's SWC, Metro's Babel —
 * drop them without needing to see the other file. Without it, a re-exported
 * type under `isolatedModules` (which apps/web sets) is a compile error.
 */

export { readFrames } from './lib/ask-events';
export type { AskEvent, AskSource, ByteReader } from './lib/ask-events';

export type {
  Account,
  Payee,
  PayeeVerification,
  Transaction,
  TransactionPage,
} from './lib/api-types';
