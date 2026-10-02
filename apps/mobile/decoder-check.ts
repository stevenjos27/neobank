/**
 * Phase 4, Step 0b: does the stream decoder keep the rupee sign intact when
 * the network splits it, ON HERMES?
 *
 * WHY THIS COMES BEFORE MOVING ANY CODE. The assistant's frame parser
 * (`readFrames`, about to move from apps/web into a shared library) depends on
 * `new TextDecoder().decode(chunk, { stream: true })`. `₹` is THREE bytes in
 * UTF-8 (E2 82 B9); a chunk boundary can fall inside it, and `stream: true` is
 * what carries the unfinished bytes over to the next call. Without it the
 * rupee sign becomes "\uFFFD" — on exactly the answers that quote money, only
 * on real networks, never on a dev server that sends one chunk.
 *
 * Node's decoder does this correctly. Hermes historically shipped no
 * TextDecoder at all; Expo SDK 57 installs a JS fallback that claims to
 * support `stream`. Same shape of question as Step 0a's BigInt finding:
 * the source says what was intended, the device says what happens.
 *
 * The checks build their bytes WITHOUT TextEncoder, so a missing or broken
 * encoder cannot hide a broken decoder — and the hand-written encoder is
 * itself checked against the known bytes of ₹.
 */

export type DecoderCheck = { label: string; pass: boolean; detail: string };

export type DecoderReport = {
  /** Which TextDecoder is actually installed on this runtime. */
  implementation: 'native' | 'JS polyfill' | 'missing';
  checks: DecoderCheck[];
};

/** A sentence shaped like a real answer: ASCII around a 3-byte character. */
const TEXT = 'You spent ₹57,011.90 in August 2026.';

/** UTF-8 for the Basic Multilingual Plane, by hand. Enough for ₹ and ASCII. */
function utf8(s: string): Uint8Array {
  const out: number[] = [];
  for (const ch of s) {
    const cp = ch.codePointAt(0) ?? 0;
    if (cp < 0x80) {
      out.push(cp);
    } else if (cp < 0x800) {
      out.push(0xc0 | (cp >> 6), 0x80 | (cp & 0x3f));
    } else if (cp < 0x10000) {
      out.push(0xe0 | (cp >> 12), 0x80 | ((cp >> 6) & 0x3f), 0x80 | (cp & 0x3f));
    } else {
      throw new Error('Outside the BMP: not needed for this check');
    }
  }
  return Uint8Array.from(out);
}

const hex = (bytes: Uint8Array): string =>
  Array.from(bytes, (b) => b.toString(16).toUpperCase().padStart(2, '0')).join(' ');

/**
 * Makes invisible differences visible: anything outside printable ASCII,
 * except ₹ itself, is shown as its code point. A replacement character
 * renders as a near-invisible box on some fonts; "\u{fffd}" cannot be missed.
 */
export function visible(s: string): string {
  return Array.from(s)
    .map((ch) => {
      const cp = ch.codePointAt(0) ?? 0;
      if ((cp >= 0x20 && cp <= 0x7e) || ch === '₹') return ch;
      return `\\u{${cp.toString(16)}}`;
    })
    .join('');
}

/** Feed `bytes` to one decoder, one byte per call. */
function decodeOneByteAtATime(bytes: Uint8Array, stream: boolean): string {
  const decoder = new TextDecoder();
  let out = '';
  for (let i = 0; i < bytes.length; i++) {
    out += decoder.decode(bytes.subarray(i, i + 1), stream ? { stream: true } : undefined);
  }
  // A final call with no options flushes anything still held.
  if (stream) out += decoder.decode();
  return out;
}

/** Turn a throw into a failed check, so one failure cannot hide the rest. */
function attempt(label: string, run: () => { pass: boolean; detail: string }): DecoderCheck {
  try {
    return { label, ...run() };
  } catch (e) {
    return { label, pass: false, detail: `THREW: ${e instanceof Error ? e.message : String(e)}` };
  }
}

export function runDecoderChecks(): DecoderReport {
  const implementation: DecoderReport['implementation'] =
    typeof TextDecoder === 'undefined'
      ? 'missing'
      : /\[native code\]/.test(Function.prototype.toString.call(TextDecoder))
        ? 'native'
        : 'JS polyfill';

  const bytes = utf8(TEXT);

  const checks: DecoderCheck[] = [
    // The test's own encoder, checked first: every other check trusts it.
    attempt('encoder: ₹ is E2 82 B9', () => {
      const got = hex(utf8('₹'));
      return { pass: got === 'E2 82 B9', detail: got };
    }),

    // The real-world worst case: every boundary is a chunk boundary.
    attempt('one byte at a time, stream: true', () => {
      const got = decodeOneByteAtATime(bytes, true);
      return { pass: got === TEXT, detail: visible(got) };
    }),

    // Every place a single split could fall — including the two INSIDE ₹.
    attempt('every two-chunk split, stream: true', () => {
      let ok = 0;
      let firstBad = '';
      for (let i = 1; i < bytes.length; i++) {
        const decoder = new TextDecoder();
        const got =
          decoder.decode(bytes.subarray(0, i), { stream: true }) +
          decoder.decode(bytes.subarray(i));
        if (got === TEXT) ok++;
        else if (!firstBad) firstBad = `split at byte ${i}: ${visible(got)}`;
      }
      const total = bytes.length - 1;
      return { pass: ok === total, detail: firstBad || `${ok}/${total} splits intact` };
    }),

    // NEGATIVE CONTROL. Without stream: true the rupee sign MUST break. If it
    // does not, the bytes were never really split and the two checks above
    // proved nothing — a test that cannot fail.
    attempt('control: without stream, ₹ must break', () => {
      const got = decodeOneByteAtATime(bytes, false);
      return { pass: got !== TEXT && got.includes('\uFFFD'), detail: visible(got) };
    }),
  ];

  return { implementation, checks };
}
