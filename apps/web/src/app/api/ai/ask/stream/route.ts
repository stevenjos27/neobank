import { apiFetch } from "@/lib/server/api";

/**
 * Proxy the assistant's SSE stream from the API to the browser.
 *
 * WHY THIS ROUTE EXISTS AT ALL. The access token lives in an httpOnly cookie,
 * so the browser cannot send it to the API itself — the whole point of the BFF
 * pattern used by every other route here. What is different is that this one
 * must not read the body.
 *
 * NO NextResponse.json, NO res.json(), NO res.text() ON THE SUCCESS PATH.
 * Every sibling route buffers the upstream body and re-serialises it, which is
 * right for a JSON response and fatal for a stream: it would wait for the last
 * token before sending the first, and the API's streaming would be invisible
 * from the browser while working perfectly under curl. `res.body` is a
 * ReadableStream and is handed straight through.
 *
 * The error path DOES buffer, deliberately. A 401 or a 429 from the API is
 * JSON, not SSE, and a client that started parsing it as frames would report a
 * stream error rather than "your session expired". Passing the status and the
 * original body through lets the caller tell the two apart with `res.ok`.
 */
export async function POST(request: Request) {
  const body = await request.json();

  const res = await apiFetch('/ai/ask/stream', {
    method: 'POST',
    body: JSON.stringify(body),
  });

  if (!res.ok || !res.body) {
    return new Response(await res.text(), {
      status: res.status,
      headers: {
        'Content-Type': res.headers.get('content-type') ?? 'application/json',
      },
    });
  }

  return new Response(res.body, {
    status: res.status,
    headers: {
      'Content-Type': 'text/event-stream; charset=utf-8',
      // `no-transform` matters as much as `no-cache`: a proxy that gzips the
      // response buffers it to do so, which reintroduces the exact delay this
      // route exists to avoid.
      'Cache-Control': 'no-cache, no-transform',
      'Connection': 'keep-alive',
      'X-Accel-Buffering': 'no',
    },
  });
}
