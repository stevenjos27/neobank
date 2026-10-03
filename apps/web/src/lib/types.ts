/**
 * Re-exports the API types from @neobank/contracts, where they now live.
 *
 * KEPT SO THE EIGHT IMPORT SITES DO NOT CHURN. Dashboard, ledger, transfer and
 * payee components import from '@/lib/types'. Pointing this file at the shared
 * library moves every one of them in a single line, and keeps the commit that
 * introduced the library small enough to review — a failure in web's build or
 * tests then has to be about the move, not about a typo in one of eight files.
 *
 * NEW CODE SHOULD IMPORT FROM @neobank/contracts DIRECTLY. This file is a
 * compatibility seam, not a second home for the types; nothing new belongs
 * here.
 *
 * `export type`, because apps/web sets isolatedModules: SWC compiles one file
 * at a time and must be told these names vanish at runtime.
 */
export type {
  Account,
  Payee,
  PayeeVerification,
  Transaction,
  TransactionPage,
} from '@neobank/contracts';
