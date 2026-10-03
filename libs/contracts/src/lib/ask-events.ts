/**
 * The assistant's stream contract: the events it sends, and the parser that
 * turns a byte stream into them.
 *
 * SHARED BETWEEN CLIENTS ON PURPOSE. The web app reads this stream through its
 * BFF route; the mobile app will read the same stream directly. Two parsers
 * would mean two implementations of the hard part — frames and characters
 * split across chunk boundaries — and the second one would be the untested
 * one. Moved here unchanged from apps/web/src/lib/ask-stream.ts in Phase 4
 * Step 0b, after checking on the device that Hermes's TextDecoder (an Expo
 * polyfill) handles `stream: true` correctly.
 *
 * WHAT DOES NOT LIVE HERE: the transport. Calling the endpoint differs per
 * client — the web app goes through its own server route with cookie auth,
 * the mobile app will call the API with a bearer token — so each client owns
 * its own fetch and hands this parser a reader.
 *
 * RUNS ON NODE, BROWSERS AND HERMES. No Node APIs: this library's
 * tsconfig.lib.json loads no Node types, so `Buffer` or `process` here is a
 * compile error rather than a crash on a phone.
 */

export type AskSource = {
  source: string;
  heading: string;
  chunkIndex: number;
};

export type AskEvent =
  | { type: 'tool'; name: string }
  | { type: 'delta'; text: string }
  | { type: 'reset' }
  | { type: 'withheld' }
  | { type: 'done'; answer: string; sources: AskSource[] }
  | { type: 'error'; message: string };

/**
 * The two methods of a stream reader this parser uses.
 *
 * Structurally typed rather than named as `ReadableStreamDefaultReader`, for
 * the same reason the SSE route types its response as Node's ServerResponse:
 * name what is used. `response.body.getReader()` satisfies it, and so does a
 * four-line object literal — which is what lets the spec drive real chunk
 * boundaries without a ReadableStream or a TextEncoder polyfill in the test
 * environment at all.
 */
export type ByteReader = {
  read(): Promise<{ done: boolean; value?: Uint8Array }>;
  releaseLock(): void;
};

/**
 * Turn a byte stream of `data: {json}\n\n` frames into events.
 *
 * TWO SPLITS TO SURVIVE, and they are different problems.
 *
 * A FRAME can straddle a chunk, so `buffer` accumulates until a `\n\n`
 * terminator appears and only then is a frame taken from it.
 *
 * A CHARACTER can straddle a chunk too, and this is the one that bites: `₹`
 * is THREE bytes in UTF-8, and a chunk boundary can fall inside it. Without
 * `{ stream: true }` the decoder emits a replacement character for the
 * fragment and the rupee sign disappears from precisely the answers that most
 * need it. It is the same class of problem the AmountGuard solves one layer
 * up, for the same reason: the transport splits wherever it likes, and every
 * layer has to reassemble before it interprets.
 */
export async function* readFrames(reader: ByteReader): AsyncGenerator<AskEvent> {
  const decoder = new TextDecoder();
  let buffer = '';

  try {
    for (; ;) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });

      for (; ;) {
        const end = buffer.indexOf('\n\n');
        if (end === -1) break;

        const frame = buffer.slice(0, end);
        buffer = buffer.slice(end + 2);

        if (!frame.startsWith('data: ')) continue;

        let event: AskEvent;
        try {
          event = JSON.parse(frame.slice(6)) as AskEvent;
        } catch {
          // A frame that will not parse is a bug on our side of the wire, but
          // it must not take the whole answer down with it. Skip and keep
          // reading: the `done` frame at the end carries the authoritative
          // text anyway.
          continue;
        }

        yield event;
      }
    }
  } finally {
    reader.releaseLock();
  }
}
