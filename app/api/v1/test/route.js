import { requireMasterKey } from "../../../../lib/auth.js";
import { routeForcedRequest } from "../../../../lib/orchestrator.js";
import { corsJson, corsPreflight } from "../../../../lib/cors.js";

export const runtime = "nodejs";

export async function OPTIONS() {
  return corsPreflight();
}

// POST /api/v1/test
// Manual provider/model test endpoint for the Test page's "pick exactly
// this provider + model" picker — bypasses auto-routing (pool selection,
// self-healing scorer, cache, coalescing) entirely and hits exactly what
// was chosen, falling back only across that same provider's own keys.
//
// Headers: Authorization: Bearer <MASTER_KEY_TEXT|IMAGE|AUDIO> (matching `type`)
// Body (JSON for text/image):
//   {
//     "type": "text" | "image",
//     "provider": "groq",
//     "model": "openai/gpt-oss-120b",
//     "messages": [...],           // type: "text"
//     "prompt": "...",             // type: "image"
//     "imageUrl" / "imageBase64" / "imageMimeType" // optional, type: "text" vision test
//   }
// Body (raw audio bytes) for type "audio": send ?provider=&model= as query
// params instead (can't mix a JSON envelope with a raw-bytes body), with
// Content-Type set to the audio's real mime type.
export async function POST(req) {
  const url = new URL(req.url);
  const isAudio = url.searchParams.get("type") === "audio";

  if (isAudio) {
    const auth = await requireMasterKey(req, "audio");
    if (!auth.ok) return corsJson({ error: auth.error }, { status: auth.status });

    const provider = url.searchParams.get("provider");
    const model = url.searchParams.get("model");
    if (!provider || !model) {
      return corsJson({ error: "`provider` and `model` query params are required for audio tests." }, { status: 400 });
    }

    const contentType = req.headers.get("content-type") || "application/octet-stream";
    const arrayBuffer = await req.arrayBuffer();
    if (!arrayBuffer || arrayBuffer.byteLength === 0) {
      return corsJson({ error: "Empty audio body." }, { status: 400 });
    }

    const result = await routeForcedRequest({
      type: "audio",
      provider,
      model,
      audioBuffer: Buffer.from(arrayBuffer),
      contentType,
    });

    if (!result.ok) return corsJson({ error: result.error, attempts: result.attempts }, { status: 502 });
    return corsJson(result);
  }

  const auth = await requireMasterKey(req, url.searchParams.get("type") === "image" ? "image" : "text");
  if (!auth.ok) return corsJson({ error: auth.error }, { status: auth.status });

  let body;
  try {
    body = await req.json();
  } catch {
    return corsJson({ error: "Invalid JSON body." }, { status: 400 });
  }

  const { type, provider, model, messages, prompt, imageUrl, imageBase64, imageMimeType } = body || {};

  if (!provider || !model) {
    return corsJson({ error: "`provider` and `model` are required." }, { status: 400 });
  }
  if (type === "text" && (!Array.isArray(messages) || messages.length === 0)) {
    return corsJson({ error: "`messages` must be a non-empty array for type \"text\"." }, { status: 400 });
  }
  if (type === "image" && !prompt) {
    return corsJson({ error: "`prompt` is required for type \"image\"." }, { status: 400 });
  }

  const result = await routeForcedRequest({
    type,
    provider,
    model,
    messages,
    prompt,
    imageUrl,
    imageBase64,
    imageMimeType,
  });

  if (!result.ok) return corsJson({ error: result.error, attempts: result.attempts }, { status: 502 });
  return corsJson(result);
}
