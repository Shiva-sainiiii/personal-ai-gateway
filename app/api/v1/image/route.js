import { NextResponse } from "next/server";
import { requireMasterKey } from "../../../../lib/auth.js";
import { routeImageRequest } from "../../../../lib/orchestrator.js";

export const runtime = "nodejs";

// POST /api/v1/image
// Headers: Authorization: Bearer <MASTER_KEY_IMAGE>
// Body: { "prompt": "a cat riding a bike" }
// Response: { "imageBase64": "...", "contentType": "image/png" }
export async function POST(req) {
  const auth = await requireMasterKey(req, "image");
  if (!auth.ok) {
    return NextResponse.json({ error: auth.error }, { status: auth.status });
  }

  let body;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body." }, { status: 400 });
  }

  const { prompt } = body || {};
  if (!prompt || typeof prompt !== "string") {
    return NextResponse.json({ error: "`prompt` (string) is required." }, { status: 400 });
  }

  const result = await routeImageRequest({ prompt });

  if (!result.ok) {
    return NextResponse.json({ error: result.error, attempts: result.attempts }, { status: 502 });
  }

  return NextResponse.json({ imageBase64: result.imageBase64, contentType: result.contentType, provider: result.provider });
}
