import { apiFetch } from "@/lib/server/api";
import { NextResponse } from "next/server";

export async function POST(request: Request) {
  const body = await request.json();
  const res = await apiFetch(`/accounts/transfer`, {
    method: 'POST',
    body: JSON.stringify(body),
  });

  const data = await res.json();
  return NextResponse.json(data, { status: res.status });
}
