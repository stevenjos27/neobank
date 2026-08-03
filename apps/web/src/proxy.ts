import { NextRequest, NextResponse } from "next/server";
import { setAuthCookies } from "@/lib/server/auth-cookies";

export async function proxy(request: NextRequest) {
  const accessToken = request.cookies.get('accessToken')?.value;
  const refreshToken = request.cookies.get('refreshToken')?.value;

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
