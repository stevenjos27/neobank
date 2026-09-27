/**
 * Reads the assistant's SSE stream from the BFF.
 *
 * SEPARATE FROM THE PAGE ON PURPOSE. Frame parsing has boundary conditions —
 * a frame split across chunks, a multi-byte character split across chunks, a
 * malformed frame — and none of them can be tested if the parser lives inside
 * a component. This module is the testable half; the page is the rendering
 * half.
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

/**
 * What to tell the customer when the request never became a stream.
 *
 * Status-driven rather than echoing the body. The API deliberately keeps
 * provider detail out of its responses, and the BFF passes that through; a
 * raw message here would be either useless or a leak.
 */
function messageFor(status: number): string {
  if (status === 401) return 'Your session has expired. Please sign in again.';
  if (status === 429) return 'Too many questions just now. Try again in a minute.';
  if (status === 503) return 'The assistant is unavailable right now. Please try again later.';
  return 'Something went wrong asking the assistant. Please try again.';
}

/**
 * Ask a question and yield events as they arrive.
 *
 * A non-OK response is yielded as an `error` event rather than thrown, so a
 * caller has ONE thing to consume: an expired session and a mid-stream
 * provider failure arrive through the same channel and render the same way.
 * Throwing for one and eventing the other would mean two error paths in the
 * page, and the second one would be the untested one.
 */
export async function* askStream(
  question: string,
  signal?: AbortSignal,
): AsyncGenerator<AskEvent> {
  const res = await fetch('/api/ai/ask/stream', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ question }),
    signal,
  });

  if (!res.ok || !res.body) {
    yield { type: 'error', message: messageFor(res.status) };
    return;
  }

  yield* readFrames(res.body.getReader());
}
