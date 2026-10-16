import { NextResponse } from "next/server";

import { resumeJob } from "@/lib/jobs";

export const runtime = "nodejs";

export async function POST(
  _: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;

  try {
    return NextResponse.json(resumeJob(id));
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : String(error) },
      { status: 409 },
    );
  }
}
