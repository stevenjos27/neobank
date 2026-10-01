/**
 * Paise → a formatted rupee string, in Indian digit grouping.
 *
 * Lives in the shared library rather than in one app, deliberately. Three
 * consumers need the identical output: the web ledger, the API's AI
 * aggregate tools, and the React Native client. Two copies of a money
 * formatter is not a tidiness problem — it is the assistant reporting
 * "₹12,34,567.89" while the ledger shows "₹1,234,567.89" for the same
 * number, with nothing on screen telling the user which one to trust.
 *
 * NO Intl, DELIBERATELY. This function used Intl.NumberFormat until Phase 4
 * Step 0a ran it on a phone: Hermes, the React Native engine, throws
 * "Cannot convert BigInt to number" when Intl is handed a BigInt, on both
 * iOS and Android. Node accepts one, so every test on Node stayed green
 * while the shared formatter could not run on the third consumer at all.
 *
 * Grouping by hand is the better design anyway, not just a workaround. The
 * Phase 3 amount guardrail matches a quoted figure BYTE FOR BYTE against a
 * tool result, so every runtime that formats money must produce identical
 * bytes. With Intl, that identity depended on each engine's ICU build. Now
 * it depends only on this file. The locale was already hardcoded to en-IN,
 * so Intl was only ever doing the digit grouping, and the grouping rule is
 * below.
 */
export function formatPaise(paise: string | bigint): string {
  const val = BigInt(paise);
  // Sign is split off BEFORE the divide. BigInt division truncates toward
  // zero and BigInt modulo KEEPS THE DIVIDEND'S SIGN, so -12345n yields
  // units -123n and remainder -45n — which concatenated gives "-123.-45".
  // Taking the magnitude first makes the remainder unconditionally 0..99.
  //
  // It also keeps the sign for amounts below one rupee: -45 paise has 0n
  // whole rupees, so any approach that formats the signed rupee count loses
  // the minus and renders a debit as a credit. The sign comes from the
  // original value, always.
  const negative = val < 0n;
  const magnitude = negative ? -val : val;

  // Everything stays BigInt until it becomes a decimal STRING. Never a
  // Number: a balance beyond Number.MAX_SAFE_INTEGER would silently round
  // somebody's money on the way through a float.
  const rupees = (magnitude / 100n).toString();
  const paisePart = (magnitude % 100n).toString().padStart(2, '0');

  return `${negative ? '-' : ''}₹${groupIndian(rupees)}.${paisePart}`;
}

/**
 * Indian digit grouping on a string of digits.
 *
 * The rule: the last three digits are one group, and everything to their
 * left is grouped in TWOS, counted from the right. 1234567 → 12,34,567.
 *
 * "Counted from the right" is the part that is easy to get wrong. Grouping
 * the head from the left gives the same answer whenever the head has an
 * even number of digits, and the wrong one whenever it is odd: one lakh,
 * 100000, has the head "100", which must become "1,00", not "10,0". The
 * boundary cases in money.spec.ts exist to catch exactly that.
 */
function groupIndian(digits: string): string {
  if (digits.length <= 3) return digits;

  const lastThree = digits.slice(-3);
  const head = digits.slice(0, -3);

  const pairs: string[] = [];
  for (let end = head.length; end > 0; end -= 2) {
    pairs.unshift(head.slice(Math.max(0, end - 2), end));
  }

  return `${pairs.join(',')},${lastThree}`;
}
