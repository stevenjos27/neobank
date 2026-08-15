import { apiFetch } from "@/lib/server/api";
import { NextResponse } from "next/server";

export async function GET(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  const res = await apiFetch(`/accounts/${id}/transactions`);
  const data = await res.json();
  return NextResponse.json(data, { status: res.status });
}
