import { requireMasterKey } from "../../../../lib/auth.js";
import { routeAudioRequest } from "../../../../lib/orchestrator.js";
import { corsJson, corsPreflight } from "../../../../lib/cors.js";

export const runtime = "nodejs";

export async function OPTIONS() {
  return corsPreflight();
}

// POST /api/v1/audio
// Headers: Authorization: Bearer <MASTER_KEY_AUDIO>
// Body: raw audio bytes (audio/mpeg, audio/wav, etc.) with matching Content-Type
// Response: { "text": "transcribed text" }
export async function POST(req) {
  const auth = await requireMasterKey(req, "audio");
  if (!auth.ok) {
    return corsJson({ error: auth.error }, { status: auth.status });
  }

  const contentType = req.headers.get("content-type") || "application/octet-stream";
  const arrayBuffer = await req.arrayBuffer();

  if (!arrayBuffer || arrayBuffer.byteLength === 0) {
    return corsJson({ error: "Empty audio body." }, { status: 400 });
  }

  const result = await routeAudioRequest({ audioBuffer: Buffer.from(arrayBuffer), contentType });

  if (!result.ok) {
    return corsJson({ error: result.error, attempts: result.attempts }, { status: 502 });
  }

  return corsJson({ text: result.text, provider: result.provider });
}
