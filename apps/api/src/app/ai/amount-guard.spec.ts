import { AmountGuard } from './amount-guard';

/**
 * The guard is a buffering state machine, and the only honest way to test one
 * is to prove that HOW the input arrives cannot change what comes out.
 *
 * Two properties carry most of the weight, each checked across every chunking
 * of the input — whole, one character at a time, and every single split point:
 *
 *   1. when every amount verifies, the emitted text equals the input exactly;
 *   2. when one does not, that amount NEVER appears in the emitted text.
 *
 * The second is the security property. A guard that emitted a fabricated
 * figure and then withheld would be Step 4's rejected design with extra steps.
 */

/** Verification, faked the way `isAmountSupported` really behaves. */
const guardFor = (supported: string[]) =>
  new AmountGuard((amount) => supported.includes(amount.replace(/\s/g, '')));

const run = (chunks: string[], supported: string[]) => {
  const guard = guardFor(supported);
  let text = '';
  let withheld: string | undefined;

  for (const chunk of chunks) {
    const result = guard.push(chunk);
    text += result.text;
    if (result.withheld) {
      withheld = result.withheld;
      break;
    }
  }

  if (withheld === undefined) {
    const final = guard.end();
    text += final.text;
    withheld = final.withheld;
  }

  return { text, withheld };
};

/** Whole, per character, and split at every position. */
const chunkings = (text: string): string[][] => {
  const all: string[][] = [[text], [...text]];
  for (let i = 1; i < text.length; i++) {
    all.push([text.slice(0, i), text.slice(i)]);
  }
  return all;
};

const SUPPORTED = ['₹57,011.90', '₹1,06,318.21', '₹15,388.41', '₹15,388'];

describe('AmountGuard', () => {
  describe('text that should pass through', () => {
    const cases: Array<[string, string]> = [
      ['no amount at all', 'Our documents do not cover home loans.'],
      ['one verified amount', 'In August 2026 you spent ₹57,011.90 across 18 debits.'],
      ['an amount at the very end', 'You spent ₹57,011.90'],
      ['an amount at the very start', '₹57,011.90 was your August total.'],
      ['two amounts', 'You spent ₹57,011.90 last month and ₹1,06,318.21 in 30 days.'],
      ['an amount before a full stop', 'Your total was ₹15,388.41.'],
      ['a full stop that is punctuation, not paise', 'Total ₹15,388. Next question?'],
      ['a stray symbol that begins no amount', 'Costs are shown in ₹, not dollars.'],
      [
        // Two spaces match neither pattern, so findUnsupportedAmounts does not
        // see it either. Asserted so the shared blind spot is a recorded
        // decision rather than something nobody noticed.
        'a double-spaced amount, unverified on both paths',
        'You spent ₹  99,999.00 supposedly.',
      ],
    ];

    for (const [name, text] of cases) {
      it(`${name}: every chunking emits the input exactly`, () => {
        for (const chunks of chunkings(text)) {
          expect({ chunks: chunks.length, ...run(chunks, SUPPORTED) }).toEqual({
            chunks: chunks.length,
            text,
            withheld: undefined,
          });
        }
      });
    }
  });

  describe('an amount that cannot be verified', () => {
    const text = 'In August 2026 you spent ₹9,999.00 on groceries.';

    it('is withheld under every chunking, and never reaches the output', () => {
      for (const chunks of chunkings(text)) {
        const result = run(chunks, SUPPORTED);

        expect({
          chunks: chunks.length,
          withheld: result.withheld,
          leaked: result.text.includes('₹9,999.00'),
          // Not even the digits: a partial release would be worse, since a
          // truncated figure reads as a real one.
          leakedPartially: /₹/.test(result.text),
        }).toEqual({
          chunks: chunks.length,
          withheld: '₹9,999.00',
          leaked: false,
          leakedPartially: false,
        });
      }
    });

    it('withholds when the amount completes, then emits nothing', () => {
      const guard = guardFor(SUPPORTED);

      // Still HELD, not withheld. The buffer ends inside a possible amount,
      // so `₹9,999.00` could yet be the start of something longer and the
      // guard cannot rule on it. Verification fires one chunk later than a
      // reader would call the number finished.
      expect(guard.push('You spent ₹9,999.00')).toEqual({ text: 'You spent ' });

      // The space proves completion. Note the safe text on this pass is
      // dropped too: the client is about to discard everything it has.
      expect(guard.push(' more than usual.')).toEqual({
        text: '',
        withheld: '₹9,999.00',
      });

      expect(guard.push(' And another sentence.')).toEqual({ text: '' });
      expect(guard.end()).toEqual({ text: '' });
    });
  });

  describe('when text is released', () => {
    it('holds everything from the ₹ while the amount could still grow', () => {
      const guard = guardFor(SUPPORTED);
      // `₹57,011` is a prefix of a supported amount and also a plausible
      // amount in its own right. Releasing it here would publish ₹57,011
      // when the model is about to write ₹57,011.90.
      expect(guard.push('You spent ₹57,011')).toEqual({ text: 'You spent ' });
      expect(guard.push('.90')).toEqual({ text: '' });
      expect(guard.push(' in total.')).toEqual({ text: '₹57,011.90 in total.' });
    });

    it('releases as soon as the next character cannot extend the amount', () => {
      const guard = guardFor(SUPPORTED);
      expect(guard.push('Total ₹57,011.90').text).toBe('Total ');
      // The space proves the amount is finished, so it and the amount go out
      // together — no waiting for the end of the stream.
      expect(guard.push(' today.')).toEqual({ text: '₹57,011.90 today.' });
    });

    it('verifies a trailing amount when the stream ends', () => {
      const guard = guardFor(SUPPORTED);
      expect(guard.push('You spent ₹57,011.90').text).toBe('You spent ');
      expect(guard.end()).toEqual({ text: '₹57,011.90' });
    });

    it('withholds a trailing bad amount when the stream ends', () => {
      const guard = guardFor(SUPPORTED);
      expect(guard.push('You spent ₹9,999.00').text).toBe('You spent ');
      expect(guard.end()).toEqual({ text: '', withheld: '₹9,999.00' });
    });
  });
});
