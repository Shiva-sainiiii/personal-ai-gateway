import { requireMasterKey } from "../../../../lib/auth.js";
import { routeImageRequest } from "../../../../lib/orchestrator.js";
import { corsJson, corsPreflight } from "../../../../lib/cors.js";

export const runtime = "nodejs";

export async function OPTIONS() {
  return corsPreflight();
}

// POST /api/v1/image
// Headers: Authorization: Bearer <MASTER_KEY_IMAGE>
// Body: { "prompt": "a cat riding a bike" }
// Response: { "imageBase64": "...", "contentType": "image/png" }
export async function POST(req) {
  const auth = await requireMasterKey(req, "image");
  if (!auth.ok) {
    return corsJson({ error: auth.error }, { status: auth.status });
  }

  let body;
  try {
    body = await req.json();
  } catch {
    return corsJson({ error: "Invalid JSON body." }, { status: 400 });
  }

  const { prompt } = body || {};
  if (!prompt || typeof prompt !== "string") {
    return corsJson({ error: "`prompt` (string) is required." }, { status: 400 });
  }

  const result = await routeImageRequest({ prompt });

  if (!result.ok) {
    return corsJson({ error: result.error, attempts: result.attempts }, { status: 502 });
  }

  return corsJson({ imageBase64: result.imageBase64, contentType: result.contentType, provider: result.provider });
}
