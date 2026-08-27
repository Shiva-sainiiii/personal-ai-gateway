import { requireMasterKey } from "../../../../../lib/auth.js";
import { routeTextRequest } from "../../../../../lib/orchestrator.js";
import { encodeAsSSE, sseHeaders } from "../../../../../lib/streamTools.js";

export const runtime = "nodejs";

// POST /api/v1/chat/stream
// Same body shape as /api/v1/chat. Response is text/event-stream:
//   data: {"delta": "..."}   (repeated)
//   data: {"done": true}
// The client can abort the fetch (AbortController) at any time to stop
// receiving further chunks — the stream's cancel() handler stops emitting.
export async function POST(req) {
  const auth = await requireMasterKey(req, "text");
  if (!auth.ok) {
    return new Response(JSON.stringify({ error: auth.error }), {
      status: auth.status,
      headers: { "Content-Type": "application/json" },
    });
  }

  let body;
  try {
    body = await req.json();
  } catch {
    return new Response(JSON.stringify({ error: "Invalid JSON body." }), {
      status: 400,
      headers: { "Content-Type": "application/json" },
    });
  }

  const { messages, model, imageUrl, imageBase64, imageMimeType } = body || {};
  if (!Array.isArray(messages) || messages.length === 0) {
    return new Response(JSON.stringify({ error: "`messages` must be a non-empty array." }), {
      status: 400,
      headers: { "Content-Type": "application/json" },
    });
  }

  const result = await routeTextRequest({
    messages,
    preferredModel: model,
    imageUrl,
    imageBase64,
    imageMimeType,
  });

  if (!result.ok) {
    return new Response(JSON.stringify({ error: result.error, attempts: result.attempts }), {
      status: 502,
      headers: { "Content-Type": "application/json" },
    });
  }

  return new Response(encodeAsSSE(result.text), { headers: sseHeaders() });
}
