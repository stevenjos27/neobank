import { apiFetch } from "@/lib/server/api";
import { NextResponse } from "next/server";

const FORWARDED_PARAMS = ['limit', 'cursor'] as const;

export async function GET(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;

  const incoming = new URL(request.url).searchParams;
  const forwarded = new URLSearchParams();

  for (const key of FORWARDED_PARAMS) {
    const value = incoming.get(key);
    if (value !== null) forwarded.set(key, value);
  }

  const qs = forwarded.toString();
  const res = await apiFetch(`/accounts/${id}/transactions${qs ? `?${qs}` : ''}`);

  let data: unknown;
  try {
    data = await res.json();
  }
  catch {
    return NextResponse.json(
      { message: 'Upstream returned an unreadable response' },
      { status: res.status === 200 ? 502 : res.status },
    );
  }
  return NextResponse.json(data, { status: res.status });
}
