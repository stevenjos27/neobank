import { NextRequest, NextResponse } from "next/server";
import { setAuthCookies } from "@/lib/server/auth-cookies";

/**
 * Pages that require a session.
 *
 * A list rather than "everything except /login and /register". Protecting by
 * exclusion makes every new page private by default, which sounds safer until
 * the page you forgot to exclude is /login itself and the result is a redirect
 * loop.
 *
 * /accounts was absent before /assistant was added, so an unauthenticated
 * visitor to an account page got a rendered shell whose server fetch 401'd —
 * "Could not load your accounts" instead of the login screen. Fixed here
 * rather than left out to keep the diff narrow: a security-relevant list that
 * is knowingly incomplete is worse than a slightly wider change.
 */
const PROTECTED = ['/dashboard', '/accounts', '/assistant'];

export async function proxy(request: NextRequest) {
  const accessToken = request.cookies.get('accessToken')?.value;
  const refreshToken = request.cookies.get('refreshToken')?.value;

  const needsSession = PROTECTED.some((prefix) =>
    request.nextUrl.pathname.startsWith(prefix),
  );

  if (needsSession && !accessToken && !refreshToken) {
    return NextResponse.redirect(new URL('/login', request.url));
  }

  if (accessToken || !refreshToken) return NextResponse.next();

  const res = await fetch(`${process.env.API_URL}/auth/refresh`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ refreshToken }),
  });

  if (!res.ok) {
    const response = NextResponse.next();
    response.cookies.delete('refreshToken');
    return response;
  }

  const tokens = await res.json();

  const headers = new Headers(request.headers);
  headers.set('cookie', `${headers.get('cookie') ?? ''}; accessToken=${tokens.accessToken}`);

  const response = NextResponse.next({ request: { headers } });
  setAuthCookies(response.cookies, tokens.accessToken, tokens.refreshToken);
  return response;
}

export const config = {
  matcher: ['/((?!_next/static|_next/image|favicon.ico).*)'],
};
