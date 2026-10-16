import { NextResponse } from "next/server";

import { submitHumanInput } from "@/lib/jobs";

export const runtime = "nodejs";

export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;

  try {
    const body = (await request.json()) as { value?: unknown };
    if (typeof body.value !== "string") {
      return NextResponse.json(
        { error: "A string value is required" },
        { status: 400 },
      );
    }

    return NextResponse.json(submitHumanInput(id, body.value));
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : String(error) },
      { status: 409 },
    );
  }
}
