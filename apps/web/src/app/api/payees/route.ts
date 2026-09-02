import { apiFetch } from "@/lib/server/api";
import { NextResponse } from "next/server";

export async function GET() {
  const res = await apiFetch('/payees');
  const data = await res.json();
  return NextResponse.json(data, { status: res.status });
}

export async function POST(request: Request) {
  const body = await request.json();

  const res = await apiFetch('/payees', {
    method: 'POST',
    body: JSON.stringify({ accountNumber: body.accountNumber, ifsc: body.ifsc }),
  });

  const data = await res.json();
  return NextResponse.json(data, { status: res.status });
}
