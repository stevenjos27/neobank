import { apiFetch } from "@/lib/server/api";
import { NextResponse } from "next/server";

export async function POST(request: Request) {
  const body = await request.json();
  const res = await apiFetch('/payees/verify', {
    method: 'POST',
    body: JSON.stringify({ accountNumber: body.accountNumber, ifsc: body.ifsc }),
  });

  const data = await res.json();
  return NextResponse.json(data, { status: res.status });
}
