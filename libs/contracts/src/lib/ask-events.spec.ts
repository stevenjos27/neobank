import { AskEvent, ByteReader, readFrames } from './ask-events';

/**
 * Runs under Jest's `node` environment, which provides TextDecoder and
 * TextEncoder natively. (In apps/web, where this spec used to live, it ran
 * under jsdom, which has neither, and installed Node's by hand.)
 *
 * WHAT THIS SPEC DOES NOT PROVE: that the decoder on a phone behaves the same.
 * Node's decoder is not the one Hermes uses — Hermes ships none, and Expo
 * installs a JavaScript polyfill. That is checked on the device, by
 * apps/mobile/decoder-check.ts. This spec proves the PARSER's handling of
 * split frames and split characters, given a correct decoder.
 */

/**
 * Chunk boundaries are the entire subject of this file.
 *
 * The parser's job is to reassemble before it interprets, and every way that
 * can go wrong is invisible locally: a dev server sends a small response in one
 * chunk, so a parser that assumes whole frames and whole characters passes
 * every manual test and fails in production, intermittently, on the answers
 * that quote money.
 *
 * `readerOf` is why the module takes a ByteReader rather than a ReadableStream:
 * the transport becomes four lines of test code, and the chunk boundaries
 * become something a test can choose.
 */

const readerOf = (...chunks: Uint8Array[]): ByteReader => {
  let next = 0;
  return {
    read: async () =>
      next < chunks.length ? { done: false, value: chunks[next++] } : { done: true },
    releaseLock: () => undefined,
  };
};

const bytes = (text: string) => new TextEncoder().encode(text);

const frame = (event: unknown) => `data: ${JSON.stringify(event)}\n\n`;

const collect = async (reader: ByteReader): Promise<AskEvent[]> => {
  const events: AskEvent[] = [];
  for await (const event of readFrames(reader)) events.push(event);
  return events;
};

describe('readFrames', () => {
  it('yields events for frames that arrive whole', async () => {
    const events = await collect(
      readerOf(
        bytes(
          frame({ type: 'tool', name: 'spend_by_category' }) +
          frame({ type: 'delta', text: 'You spent' }),
        ),
      ),
    );

    expect(events).toEqual([
      { type: 'tool', name: 'spend_by_category' },
      { type: 'delta', text: 'You spent' },
    ]);
  });

  it('reassembles a frame split across chunks', async () => {
    const text = frame({ type: 'delta', text: 'You spent' });
    const at = Math.floor(text.length / 2);

    const events = await collect(readerOf(bytes(text.slice(0, at)), bytes(text.slice(at))));

    expect(events).toEqual([{ type: 'delta', text: 'You spent' }]);
  });

  it('reassembles a ₹ split across chunks', async () => {
    // THE CASE THIS FILE EXISTS FOR. ₹ is U+20B9 — three bytes, E2 82 B9 — and
    // a chunk boundary can fall inside it. Without `{ stream: true }` the
    // decoder emits a replacement character for the fragment and the rupee
    // sign vanishes from the one kind of answer that must never be ambiguous
    // about money. Both interior boundaries are exercised.
    const all = bytes(frame({ type: 'delta', text: '₹57,011.90' }));
    const rupeeStart = all.indexOf(0xe2);

    expect(rupeeStart).toBeGreaterThan(0);

    for (const offset of [1, 2]) {
      const events = await collect(
        readerOf(all.slice(0, rupeeStart + offset), all.slice(rupeeStart + offset)),
      );

      expect({ offset, events }).toEqual({
        offset,
        events: [{ type: 'delta', text: '₹57,011.90' }],
      });
    }
  });

  it('skips a frame that will not parse and keeps reading', async () => {
    // A malformed frame is a bug on our side of the wire, but it must not take
    // the whole answer down — the `done` frame still carries the
    // authoritative text.
    const events = await collect(
      readerOf(bytes('data: {not json\n\n' + frame({ type: 'delta', text: 'still here' }))),
    );

    expect(events).toEqual([{ type: 'delta', text: 'still here' }]);
  });

  it('ignores lines that are not data frames', async () => {
    // SSE comments are legal and are what a keepalive looks like.
    const events = await collect(
      readerOf(bytes(': keepalive\n\n' + frame({ type: 'withheld' }))),
    );

    expect(events).toEqual([{ type: 'withheld' }]);
  });

  it('drops a trailing frame with no terminator', async () => {
    // The producer always writes `\n\n`, so this cannot happen in practice.
    // Asserted so the constraint on the producer is written down rather than
    // assumed — and because the tempting alternative, flushing the buffer on
    // `done`, would silently accept a TRUNCATED frame. Half an answer that
    // looks whole is worse than a dropped one.
    const events = await collect(
      readerOf(
        bytes(frame({ type: 'delta', text: 'kept' }) + 'data: {"type":"delta","text":"lost"}'),
      ),
    );

    expect(events).toEqual([{ type: 'delta', text: 'kept' }]);
  });

  it('carries the done frame through with its sources', async () => {
    const done = {
      type: 'done',
      answer: 'You spent a total of ₹57,011.90 in August 2026.',
      sources: [{ source: 'neobank-faq.md', heading: 'Fees and charges', chunkIndex: 11 }],
    };

    expect(await collect(readerOf(bytes(frame(done))))).toEqual([done]);
  });
});
