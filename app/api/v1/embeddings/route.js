import { requireMasterKey } from "../../../../lib/auth.js";
import { routeEmbeddingRequest } from "../../../../lib/orchestrator.js";
import { corsJson, corsPreflight } from "../../../../lib/cors.js";

export const runtime = "nodejs";

export async function OPTIONS() {
  return corsPreflight();
}

// POST /api/v1/embeddings
// Headers: Authorization: Bearer <MASTER_KEY_TEXT> — embeddings are a
// text-domain operation (semantic search, RAG, clustering), so they use the
// text master key rather than adding a 4th master-key type.
// Body: { "input": "some text" } or { "input": ["text one", "text two"] }
//   (OpenAI's /v1/embeddings convention — accepts a single string or an array)
// Response: { "embeddings": [[...vector], ...], "model": "@cf/baai/bge-large-en-v1.5" }
export async function POST(req) {
  const auth = await requireMasterKey(req, "text");
  if (!auth.ok) {
    return corsJson({ error: auth.error }, { status: auth.status });
  }

  let body;
  try {
    body = await req.json();
  } catch {
    return corsJson({ error: "Invalid JSON body." }, { status: 400 });
  }

  const { input } = body || {};
  if (!input || (typeof input !== "string" && !Array.isArray(input))) {
    return corsJson({ error: "`input` (string or array of strings) is required." }, { status: 400 });
  }
  if (Array.isArray(input) && input.length > 100) {
    return corsJson({ error: "`input` array is too long (max 100 items per request)." }, { status: 400 });
  }

  const result = await routeEmbeddingRequest({ input });

  if (!result.ok) {
    return corsJson({ error: result.error, attempts: result.attempts }, { status: 502 });
  }

  return corsJson({ embeddings: result.embeddings, model: "@cf/baai/bge-large-en-v1.5" });
}
