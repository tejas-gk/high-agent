import fs from "node:fs/promises";
import path from "node:path";

import { NextResponse } from "next/server";

export const runtime = "nodejs";

export async function GET(
  _: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  const previewPath = path.resolve("artifacts", id, "live.png");

  try {
    const file = await fs.readFile(previewPath);

    return new NextResponse(file, {
      headers: {
        "Content-Type": "image/png",
        "Cache-Control": "no-store, no-cache, must-revalidate, max-age=0",
      },
    });
  } catch {
    return NextResponse.json(
      { error: "Preview not available yet" },
      { status: 404 },
    );
  }
}
