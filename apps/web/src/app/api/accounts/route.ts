import { apiFetch } from "@/lib/server/api";
import { NextResponse } from "next/server";

export async function GET() {
  const res = await apiFetch('/accounts');
  const data = await res.json();
  return NextResponse.json(data, { status: res.status });
}
