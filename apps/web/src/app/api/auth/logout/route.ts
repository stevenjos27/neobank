import { cookies } from "next/headers";
import { NextResponse } from "next/server";

/**
 * Logs out on BOTH sides: revokes the session on the API, then clears this
 * browser's cookies. Until Phase 4 Step 1 it only did the second half — the
 * session stayed live on the server and the API never knew.
 *
 * If the API call fails (down, unreachable, timed out), the cookies are
 * cleared ANYWAY and the failure is logged. Logging out of a device must
 * never depend on a remote service being up. The cost is bounded: the
 * session stays live server-side until it expires, but the only copy of its
 * token was in this browser's httpOnly cookie, which is now gone. That gap
 * matters only if the token was already stolen — which is what logout-all
 * (from another device) is for.
 */
const API_LOGOUT_TIMEOUT_MS = 10_000;

export async function POST() {
  const cookieStore = await cookies();
  const refreshToken = cookieStore.get('refreshToken')?.value;

  if (refreshToken) {
    try {
      const res = await fetch(`${process.env.API_URL}/auth/logout`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ refreshToken }),
        signal: AbortSignal.timeout(API_LOGOUT_TIMEOUT_MS),
      });
      // The API answers 204 for every token by design, so anything else is
      // an infrastructure problem, not a verdict on the token.
      if (!res.ok) {
        console.error(`logout: API answered ${res.status}; session not revoked server-side`);
      }
    } catch (err) {
      console.error('logout: API unreachable; session not revoked server-side', err);
    }
  }

  cookieStore.delete('accessToken');
  cookieStore.delete('refreshToken');
  return NextResponse.json({ ok: true });
}
