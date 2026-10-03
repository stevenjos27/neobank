/**
 * Reads the assistant's SSE stream from the BFF.
 *
 * THE TRANSPORT ONLY. The event types and the frame parser — the part with
 * real boundary conditions (a frame split across chunks, a multi-byte
 * character split across chunks, a malformed frame) — moved to
 * @neobank/contracts in Phase 4 Step 0b, so the mobile app parses the same
 * stream with the same code. What stays here is specific to this client: the
 * request goes to this app's own BFF route, authenticated by cookie, which the
 * mobile app will not use.
 */
import { readFrames } from '@neobank/contracts';
import type { AskEvent } from '@neobank/contracts';

// Re-exported so assistant-chat.tsx, which imports AskSource from here, does
// not have to change in the commit that introduces the library.
export type { AskEvent, AskSource } from '@neobank/contracts';

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
