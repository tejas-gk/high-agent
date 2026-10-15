import { NextResponse } from "next/server";

import { startJob } from "@/lib/jobs";

export const runtime = "nodejs";

export async function POST(req: Request) {
  try {
    const body = (await req.json()) as { payload?: unknown; mutate?: boolean };
    const job = startJob(body.payload, Boolean(body.mutate));

    return NextResponse.json(job, { status: 202 });
  } catch (error) {
    return NextResponse.json(
      {
        error: error instanceof Error ? error.message : "Unable to start job",
      },
      { status: 400 },
    );
  }
}
