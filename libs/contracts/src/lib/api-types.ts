/**
 * The shapes the NeoBank API returns, as its clients consume them.
 *
 * SHARED, NOT DUPLICATED. Moved from apps/web/src/lib/types.ts in Phase 4
 * Step 0b so the web app and the mobile app read one definition. A second
 * copy in the mobile app would drift from the first the day someone added a
 * field to one of them — and a type that disagrees with the wire is worse than
 * no type, because it turns a runtime surprise into false confidence. Phase 2
 * met exactly that: `Transaction['type']` omitted WITHDRAWAL, and every ATM
 * withdrawal rendered as a credit.
 *
 * KNOWN LIMIT, recorded rather than hidden: these are still HAND-WRITTEN
 * mirrors of what the API sends. Nothing yet makes the API itself satisfy
 * them, so a server-side change can still drift from this file without any
 * build going red. Sharing removes drift between the two clients; it does not
 * remove drift between client and server.
 *
 * MONEY IS A STRING OF PAISE, never a number. JSON has no BigInt, and a
 * balance above Number.MAX_SAFE_INTEGER would silently round on the way
 * through a float. Format with formatPaise from @neobank/utils.
 */

export type Account = {
  id: string;
  accountNumber: string;
  type: 'SAVINGS' | 'CURRENT';
  balancePaise: string;
  currency: string;
  createdAt: string;
};

export type Transaction = {
  id: string;
  accountId: string;
  type: 'DEPOSIT' | 'WITHDRAWAL' | 'TRANSFER_IN' | 'TRANSFER_OUT';
  amountPaise: string;
  description: string | null;
  createdAt: string;
};

export type TransactionPage = {
  items: Transaction[];
  nextCursor: string | null;
};

export type Payee = {
  id: string;
  name: string;
  accountNumber: string;
  ifsc: string;
  createdAt: string;
};

export type PayeeVerification = {
  accountNumber: string;
  beneficiaryName: string;
};
