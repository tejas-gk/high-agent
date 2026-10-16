import { NextResponse } from "next/server";

export const runtime = "nodejs";

export async function GET() {
  return NextResponse.json({
    ok: true,
    aiConfigured: Boolean(process.env.AI_API_KEY && process.env.AI_API_URL && process.env.AI_MODEL),
    headless: process.env.HEADLESS !== "false",
    humanHandoff: true,
    mutationDemo: true,
    paymentIsolation: true,
  });
}
