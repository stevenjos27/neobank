import { RUPEE_AMOUNT_AT_START } from './amounts';

/**
 * Holds back streamed text until every rupee amount in it has been verified.
 *
 * THE PROBLEM IT SOLVES. Step 4's guardrail needs the finished answer: it
 * matches every amount against the tool payloads and replaces the WHOLE
 * answer if any of them is untraceable. A token stream publishes text before
 * that check can run, and the failure mode is the one Step 4 explicitly
 * rejected — the customer reads a fabricated figure, and a later retraction
 * arrives after the screenshot, the screen reader and the copy-paste.
 *
 * THE RULE. Text is published as soon as it cannot be part of an unverified
 * amount. A `₹` starts a held region; everything from it is buffered until
 * the amount it begins is provably complete, at which point it is verified
 * and either released or the whole stream is abandoned. In practice the stall
 * is the handful of tokens that spell out a number, so it is invisible.
 *
 * ITS JOB IS TO AGREE WITH THE BUFFERED PATH, NOT TO BE STRICTER. Where the
 * buffered check has a blind spot, this reproduces it deliberately — see
 * `₹  57` below. A guard that caught more than findUnsupportedAmounts would
 * mean the same answer is suppressed when streamed and published when
 * buffered, which is a worse bug than the blind spot itself.
 */

/**
 * An amount that might still be growing.
 *
 * Deliberately looser than RUPEE_AMOUNT_AT_START: `[\d,]*` instead of `+`, and
 * `\.\d{0,2}` instead of `\d{2}`, so that every PREFIX of a real amount
 * matches it in full. That is the whole trick — if this consumes the entire
 * buffer, more characters could still extend the amount, so nothing is safe
 * to publish yet.
 *
 * The relationship between the two patterns is asserted in the spec rather
 * than trusted: every prefix of every canonical amount must match this one
 * completely. Change one without the other and that test goes red.
 */
const AMOUNT_STILL_GROWING = /^₹\s?[\d,]*(?:\.\d{0,2})?/;

export type GuardResult = {
  /** Text safe to publish now. Often empty; that is normal, not an error. */
  text: string;
  /**
   * Set exactly once, naming the amount that could not be traced to a tool
   * result. The stream must stop and the client must replace everything it
   * has rendered with the withheld notice — whole-answer suppression, the
   * same semantics as the buffered path.
   */
  withheld?: string;
};

const NOTHING: GuardResult = { text: '' };

export class AmountGuard {
  private pending = '';
  private stopped = false;

  /**
   * `verify` is injected rather than imported so this class knows nothing
   * about tool payloads. It buffers; it does not judge. In production the
   * caller passes `amount => isAmountSupported(amount, toolPayloads)`; the
   * spec passes a set of known-good strings, which is what lets the buffering
   * logic be tested without constructing a single tool result.
   */
  constructor(private readonly verify: (amount: string) => boolean) { }

  /** Feed the next delta from the model. */
  push(chunk: string): GuardResult {
    if (this.stopped) return NOTHING;
    this.pending += chunk;
    return this.drain(false);
  }

  /**
   * The stream is over. Anything still held is complete by definition, so the
   * final amount is verified here rather than held forever — an answer ending
   * on a figure is the common case, not an edge one.
   */
  end(): GuardResult {
    if (this.stopped) return NOTHING;
    const result = this.drain(true);
    this.stopped = true;
    return result;
  }

  private drain(atEnd: boolean): GuardResult {
    let out = '';
    let cursor = 0;

    for (; ;) {
      const start = this.pending.indexOf('₹', cursor);

      if (start === -1) {
        // No amount in flight. Everything left is text.
        out += this.pending.slice(cursor);
        this.pending = '';
        return { text: out };
      }

      out += this.pending.slice(cursor, start);
      const tail = this.pending.slice(start);
      const growing = AMOUNT_STILL_GROWING.exec(tail);
      // Always matches: the pattern's every component is optional after `₹`.
      const span = growing ? growing[0].length : 1;

      if (span === tail.length && !atEnd) {
        // The buffer ends inside a possible amount, so the next chunk could
        // extend it. `₹57,011` is not safe to publish while `.90` may follow.
        this.pending = tail;
        return { text: out };
      }

      const complete = RUPEE_AMOUNT_AT_START.exec(tail);

      if (!complete) {
        // A `₹` that begins no amount — a stray symbol, or `₹  57` with two
        // spaces, which findUnsupportedAmounts also declines to match. Passing
        // it through as plain text is what keeps the two paths in agreement.
        out += tail.slice(0, span);
        cursor = start + span;
        continue;
      }

      if (!this.verify(complete[0])) {
        // Nothing further is published, including the safe text accumulated
        // on this pass. The client is about to discard everything anyway.
        this.pending = '';
        this.stopped = true;
        return { text: '', withheld: complete[0] };
      }

      // Release through the end of the growing span, not just the canonical
      // match: `₹57,011.` at a sentence end has a trailing stop that is
      // punctuation, and the buffered path treats it the same way.
      out += tail.slice(0, span);
      cursor = start + span;
    }
  }
}
