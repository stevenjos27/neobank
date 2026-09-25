/**
 * What counts as a rupee amount, and whether one is supported by a tool.
 *
 * EXTRACTED SO BOTH DELIVERY PATHS SHARE ONE POLICY. The buffered answer
 * checks the finished text; the streaming guard checks each amount as it
 * completes. Two implementations of the same rule would mean the same answer
 * could be suppressed when buffered and published when streamed — a
 * correctness bug that would surface as "it only happens in the chat UI".
 *
 * Note the contrast with the eval's ANY_RUPEE_AMOUNT, which is deliberately
 * NOT shared with this file. That one exists to check this one, and two
 * independent regexes disagreeing is information. These two are the same
 * policy applied twice, and disagreement is a defect. Ground truth should be
 * independent; a policy should be shared.
 */

/**
 * The exact shape `formatPaise` emits, and nothing else.
 *
 * The lookahead is load-bearing. Without it, `[\d,]+` matches a bare comma,
 * so `₹,` — as in "prices are shown in ₹, not dollars" — parses as an amount,
 * fails verification because no tool payload contains it, and suppresses an
 * entire correct answer that contained no figure at all. That shipped in Step
 * 4 and was found by the stream guard's spec, which splits its inputs at every
 * position and so reaches strings nobody would think to write down.
 *
 * `(?=[\d,]*\d)` requires at least one DIGIT somewhere in the numeric run,
 * while still admitting a leading comma: `₹,123` stays matched, and therefore
 * stays checkable, because an oddly formatted figure is still a figure.
 *
 * Written once and compiled into both forms below, so the whole-text matcher
 * and the anchored matcher cannot drift apart.
 */
const AMOUNT_SOURCE = '₹\\s?(?=[\\d,]*\\d)[\\d,]+(?:\\.\\d{2})?';

/** Every amount in a body of text. Global: use with `String.match`. */
export const RUPEE_AMOUNT = new RegExp(AMOUNT_SOURCE, 'g');

/**
 * An amount at the very start of a string, for the streaming guard, which
 * always examines a tail beginning at a `₹`.
 *
 * Not global on purpose. A `g` regex carries `lastIndex` between calls, and a
 * shared one used with `.test()` or `.exec()` returns different answers for
 * the same input depending on what was asked before it — the kind of bug that
 * reproduces only under load.
 */
export const RUPEE_AMOUNT_AT_START = new RegExp(`^${AMOUNT_SOURCE}`);

/**
 * Whitespace removed, because the tools emit `₹1,06,318.21` while a model may
 * write `₹ 1,06,318.21`. The space is the model's typography; the digits are
 * the claim.
 */
const normalise = (amount: string): string => amount.replace(/\s/g, '');

/**
 * Is this one amount present in some tool payload?
 *
 * The substring test is what makes the guardrail possible at all, and it
 * works only because of a decision made two steps earlier: **tools return
 * money PRE-FORMATTED**, so a correct answer quotes a string that exists
 * verbatim in a tool result. Had the tools returned raw paise and left the
 * model to format, every amount in every answer would be model-authored and
 * none of this would be checkable.
 */
export const isAmountSupported = (amount: string, toolPayloads: string[]): boolean =>
  toolPayloads.some((payload) => payload.includes(normalise(amount)));

/**
 * Every rupee amount in the answer that appears in NO tool payload.
 *
 * The most valuable runtime guardrail in Step 4, moved here unchanged.
 *
 * A reformatted-but-arithmetically-correct figure is flagged too, and that is
 * intentional. The instruction is to quote exactly; a model that reformats is
 * a model that is processing figures rather than repeating them, which is the
 * behaviour one step away from computing them.
 */
export function findUnsupportedAmounts(answer: string, toolPayloads: string[]): string[] {
  const amounts = answer.match(RUPEE_AMOUNT);
  if (!amounts) return [];

  const unsupported = new Set<string>();
  for (const amount of amounts) {
    if (!isAmountSupported(amount, toolPayloads)) {
      unsupported.add(amount);
    }
  }

  return [...unsupported];
}
