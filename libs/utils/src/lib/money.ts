/**
 * Paise → a formatted rupee string, in Indian digit grouping.
 *
 * Lives in the shared library rather than in one app, deliberately. Three
 * consumers need the identical output: the web ledger, the API's AI
 * aggregate tools, and Phase 4's React Native client. Two copies of a money
 * formatter is not a tidiness problem — it is the assistant reporting
 * "₹12,34,567.89" while the ledger shows "₹1,234,567.89" for the same
 * number, with nothing on screen telling the user which one to trust.
 *
 * This is also the first genuinely shared code in libs/utils, which until
 * now held only the Nx-generated placeholder. The monorepo's code-sharing
 * argument starts being true here rather than being a claim about the future.
 */
export function formatPaise(paise: string | bigint): string {
  const val = BigInt(paise);
  // Sign is split off BEFORE the divide. BigInt division truncates toward
  // zero and BigInt modulo KEEPS THE DIVIDEND'S SIGN, so -12345n yields
  // units -123n and remainder -45n — which concatenated gives "-123.-45".
  // Taking the magnitude first makes the remainder unconditionally 0..99,
  // and the sign is reattached as a character for the formatter to place
  // according to locale convention rather than by string surgery here.
  const negative = val < 0n;
  const magnitude = negative ? -val : val;

  const rupees = magnitude / 100n;
  const paisePart = (magnitude % 100n).toString().padStart(2, '0');

  // A BIGINT is handed to Intl, never a Number. That is the whole reason the
  // arithmetic above is BigInt: a balance beyond Number.MAX_SAFE_INTEGER
  // would silently round somebody's money on the way to a float. Intl
  // formats only the whole rupees (fraction digits forced to 0) and the
  // paise are appended, because Intl cannot take an arbitrary-precision
  // decimal under this tsconfig's `lib`.
  const formattedRupees = Intl.NumberFormat(
    'en-IN',
    {
      style: "currency",
      currency: 'INR',
      minimumFractionDigits: 0,
      maximumFractionDigits: 0,
    }).format(rupees);

  // The minus is placed by hand rather than by Intl, and that is NOT laziness.
  // Formatting the signed value would lose the sign entirely for amounts
  // between -1 and 0 paise-wise: -45 paise has 0n whole rupees, and
  // Intl.format(0n) is "₹0", so the result would read "₹0.45" for a debit.
  // Deriving the sign from the original value and formatting the magnitude
  // is the only version that is correct below one rupee. Prefix placement
  // matches en-IN, which is hardcoded above — a second locale would have to
  // revisit this.

  return `${negative ? '-' : ''}${formattedRupees}.${paisePart}`;
}
