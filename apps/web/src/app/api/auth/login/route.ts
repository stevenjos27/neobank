import { setAuthCookies } from "@/lib/server/auth-cookies";
import { cookies } from "next/headers";
import { NextResponse } from "next/server";

export async function POST(request: Request) {
  const body = await request.json();

  const res = await fetch(`${process.env.API_URL}/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    const error = await res.json();
    return NextResponse.json(error, { status: res.status });
  }

  const { accessToken, refreshToken } = await res.json();

  const cookieStore = await cookies();
  setAuthCookies(cookieStore, accessToken, refreshToken);
  return NextResponse.json({ ok: true });
}
