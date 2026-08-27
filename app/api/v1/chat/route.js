import { NextResponse } from "next/server";
import { requireMasterKey } from "../../../../lib/auth.js";
import { routeTextRequest } from "../../../../lib/orchestrator.js";

export const runtime = "nodejs";

// POST /api/v1/chat
// Headers: Authorization: Bearer <MASTER_KEY_TEXT>
// Body: {
//   "messages": [{"role":"user","content":"hi"}],
//   "model": "optional-preferred-model",
//   "imageUrl": "optional-https-url-of-an-image",       // for vision requests
//   "imageBase64": "optional-base64-image-data",         // alternative to imageUrl
//   "imageMimeType": "image/jpeg"                        // only used with imageBase64
// }
export async function POST(req) {
  const auth = await requireMasterKey(req, "text");
  if (!auth.ok) {
    return NextResponse.json({ error: auth.error }, { status: auth.status });
  }

  let body;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body." }, { status: 400 });
  }

  const { messages, model, imageUrl, imageBase64, imageMimeType } = body || {};
  if (!Array.isArray(messages) || messages.length === 0) {
    return NextResponse.json({ error: "`messages` must be a non-empty array." }, { status: 400 });
  }

  const result = await routeTextRequest({
    messages,
    preferredModel: model,
    imageUrl,
    imageBase64,
    imageMimeType,
  });

  if (!result.ok) {
    return NextResponse.json({ error: result.error, attempts: result.attempts }, { status: 502 });
  }

  return NextResponse.json({
    text: result.text,
    provider: result.provider,
    model: result.model,
    pool: result.pool,
    cached: result.cached || false,
    coalesced: result.coalesced || false,
    attempts: result.attempts,
  });
}
