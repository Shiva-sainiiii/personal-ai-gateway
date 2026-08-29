import { requireMasterKey } from "../../../../lib/auth.js";
import { routeSpeechRequest } from "../../../../lib/orchestrator.js";
import { corsJson, corsPreflight } from "../../../../lib/cors.js";

export const runtime = "nodejs";

export async function OPTIONS() {
  return corsPreflight();
}

// POST /api/v1/speech
// Headers: Authorization: Bearer <MASTER_KEY_AUDIO> — same key as /api/v1/audio
// (speech-to-text), since both are "audio" in direction, not a separate
// master-key type. If you want independent rate limiting/tracking for TTS
// specifically, add a 4th master key type later; not needed at this scale.
// Body: { "text": "Hello, this will be spoken.", "lang": "en" }  (lang optional, defaults to "en")
// Response: { "audioBase64": "...", "contentType": "audio/mpeg" }
export async function POST(req) {
  const auth = await requireMasterKey(req, "audio");
  if (!auth.ok) {
    return corsJson({ error: auth.error }, { status: auth.status });
  }

  let body;
  try {
    body = await req.json();
  } catch {
    return corsJson({ error: "Invalid JSON body." }, { status: 400 });
  }

  const { text, lang } = body || {};
  if (!text || typeof text !== "string") {
    return corsJson({ error: "`text` (string) is required." }, { status: 400 });
  }
  if (text.length > 2000) {
    return corsJson({ error: "`text` is too long (max 2000 characters for MeloTTS)." }, { status: 400 });
  }

  const result = await routeSpeechRequest({ text, lang });

  if (!result.ok) {
    return corsJson({ error: result.error, attempts: result.attempts }, { status: 502 });
  }

  return corsJson({ audioBase64: result.audioBase64, contentType: result.contentType });
}
