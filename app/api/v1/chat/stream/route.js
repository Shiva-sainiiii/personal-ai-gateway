import { requireMasterKey } from "../../../../../lib/auth.js";
import { routeTextRequest, routeTextRequestStream } from "../../../../../lib/orchestrator.js";
import { encodeAsSSE, sseHeaders } from "../../../../../lib/streamTools.js";
import { withCors, corsPreflight } from "../../../../../lib/cors.js";

export const runtime = "nodejs";

// Bug fix: this route was the only one of the 4 API routes with no CORS
// headers and no OPTIONS handler — every other route already used
// corsJson/corsPreflight from lib/cors.js. A browser calling this endpoint
// cross-origin (the exact use case CORS was added for — bots, hosted
// clients, mobile app shells) would get a silent "Failed to fetch" on the
// preflight before the request even reached this code. Now wired the same
// way as the other 3 routes: withCors() wraps every Response, OPTIONS
// answers the preflight.
export async function OPTIONS() {
  return corsPreflight();
}

// POST /api/v1/chat/stream
// Same body shape as /api/v1/chat. Response is text/event-stream:
//   data: {"delta": "..."}   (repeated)
//   data: {"done": true}
// The client can abort the fetch (AbortController) at any time to stop
// receiving further chunks — the stream's cancel() handler stops emitting.
export async function POST(req) {
  const auth = await requireMasterKey(req, "text");
  if (!auth.ok) {
    return withCors(
      new Response(JSON.stringify({ error: auth.error }), {
        status: auth.status,
        headers: { "Content-Type": "application/json" },
      })
    );
  }

  let body;
  try {
    body = await req.json();
  } catch {
    return withCors(
      new Response(JSON.stringify({ error: "Invalid JSON body." }), {
        status: 400,
        headers: { "Content-Type": "application/json" },
      })
    );
  }

  const { messages, model, imageUrl, imageBase64, imageMimeType } = body || {};
  if (!Array.isArray(messages) || messages.length === 0) {
    return withCors(
      new Response(JSON.stringify({ error: "`messages` must be a non-empty array." }), {
        status: 400,
        headers: { "Content-Type": "application/json" },
      })
    );
  }

  // Real streaming first: tries Groq/OpenRouter/Cerebras' actual `stream:
  // true` endpoints, relaying real tokens as they arrive (see
  // lib/streamTools.js for why this replaced the old fake-typewriter
  // approach). Only falls back to the non-streaming path + artificial
  // re-chunking if every streaming-capable provider fails to even connect.
  const streamResult = await routeTextRequestStream({
    messages,
    preferredModel: model,
    imageUrl,
    imageBase64,
    imageMimeType,
  });

  if (streamResult.ok) {
    // Routing transparency headers — mirrors what the non-streaming /chat
    // response includes in its JSON body (pool/model/complexity), so a
    // client can see how this request got routed without parsing the SSE
    // stream itself. Custom headers are prefixed X-Gateway- to avoid any
    // collision with standard/CORS headers.
    const headers = {
      ...sseHeaders(),
      "X-Gateway-Pool": streamResult.meta?.pool || "",
      "X-Gateway-Complexity": streamResult.meta?.complexity || "",
      "X-Gateway-Provider": streamResult.meta?.provider || "",
      "X-Gateway-Model": streamResult.meta?.model || "",
    };
    return withCors(new Response(streamResult.stream, { headers }));
  }

  const result = await routeTextRequest({
    messages,
    preferredModel: model,
    imageUrl,
    imageBase64,
    imageMimeType,
  });

  if (!result.ok) {
    return withCors(
      new Response(JSON.stringify({ error: result.error, attempts: [...streamResult.attempts, ...result.attempts] }), {
        status: 502,
        headers: { "Content-Type": "application/json" },
      })
    );
  }

  return withCors(
    new Response(encodeAsSSE(result.text), {
      headers: {
        ...sseHeaders(),
        "X-Gateway-Pool": result.pool || "",
        "X-Gateway-Complexity": result.complexity || "",
        "X-Gateway-Provider": result.provider || "",
        "X-Gateway-Model": result.model || "",
      },
    })
  );
}
