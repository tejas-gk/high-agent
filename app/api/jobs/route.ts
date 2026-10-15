import { NextResponse } from "next/server";

import { listJobs } from "@/lib/jobs";

export const runtime = "nodejs";

export async function GET() {
  return NextResponse.json(listJobs());
}
