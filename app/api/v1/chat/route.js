import { NextResponse } from "next/server";
import { requireMasterKey } from "../../../../lib/auth.js";
import { routeTextRequest } from "../../../../lib/orchestrator.js";

export const runtime = "nodejs";

// POST /api/v1/chat
// Headers: Authorization: Bearer <MASTER_KEY_TEXT>
// Body: { "messages": [{"role":"user","content":"hi"}], "model": "optional-preferred-model" }
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

  const { messages, model } = body || {};
  if (!Array.isArray(messages) || messages.length === 0) {
    return NextResponse.json({ error: "`messages` must be a non-empty array." }, { status: 400 });
  }

  const result = await routeTextRequest({ messages, preferredModel: model });

  if (!result.ok) {
    return NextResponse.json({ error: result.error, attempts: result.attempts }, { status: 502 });
  }

  return NextResponse.json({
    text: result.text,
    provider: result.provider,
    model: result.model,
    attempts: result.attempts,
  });
}
