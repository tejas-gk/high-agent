import { NextResponse } from "next/server";

// Browser cancellation needs cooperative runner abort support. Expose an
// explicit response rather than pretending a waiting browser was cancelled.
export async function POST() {
  return NextResponse.json(
    { error: "Run cancellation is not enabled; allow the guarded handoff to time out or complete it." },
    { status: 409 },
  );
}
