import { NextResponse } from "next/server";

import { getJob } from "@/lib/jobs";

export const runtime = "nodejs";

export async function GET(
  _: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  const job = getJob(id);

  if (!job) {
    return NextResponse.json({ error: "Job not found" }, { status: 404 });
  }

  // The primary page predates the explicit paused status and only keeps
  // polling while a job reports running/waiting. Keep its live trace polling
  // active during a cooperative pause; the dedicated run-control overlay reads
  // the real paused status from /api/jobs.
  return NextResponse.json(job.status === "paused" ? { ...job, status: "running" } : job);
}
