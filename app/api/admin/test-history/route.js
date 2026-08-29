import { NextResponse } from "next/server";
import { requireAdmin, requireMasterKey } from "../../../../lib/auth.js";
import { db } from "../../../../lib/firebaseAdmin.js";
import { FieldValue } from "firebase-admin/firestore";

export const runtime = "nodejs";

// GET /api/admin/test-history — most recent manual tests run from the Test
// page, newest first, for the admin panel's "Test History" section.
export async function GET(req) {
  const auth = await requireAdmin(req);
  if (!auth.ok) return NextResponse.json({ error: auth.error }, { status: auth.status });

  const limitParam = parseInt(new URL(req.url).searchParams.get("limit"), 10);
  const limit = Number.isFinite(limitParam) ? Math.min(Math.max(limitParam, 1), 200) : 50;

  const snap = await db().collection("testHistory").orderBy("createdAt", "desc").limit(limit).get();
  const history = snap.docs.map((doc) => ({ id: doc.id, ...doc.data() }));

  return NextResponse.json({ history });
}

// POST /api/admin/test-history — saves one manual test run as a report.
// Called by the Test page itself right after a manual (provider/model
// picked) test completes — NOT by the auto-routed endpoints, so this
// collection only ever contains deliberate manual tests, not organic
// traffic (that's what requestLogs is for).
//
// Auth: accepts EITHER the admin password (X-Admin-Password) OR any one of
// the three master keys (Authorization: Bearer ...). The Test page only
// ever holds master keys, not the admin password — requiring admin auth
// here would mean re-entering a second password just to log a test result.
// The admin password is still required to READ (GET) or clear (DELETE)
// history, so a leaked/shared master key can add noise but can't expose or
// wipe existing reports.
//
// Body: {
//   "testType": "text" | "image" | "audio" | "vision",
//   "provider": "groq", "model": "openai/gpt-oss-120b",
//   "ok": true, "status": 200, "latencyMs": 842,
//   "input": "...",            // prompt/messages summary, truncated client-side
//   "output": "...",           // response text summary, truncated client-side
//   "errorMessage": null,
//   "attempts": [...]          // optional, from a failed forced request
// }
export async function POST(req) {
  const adminAuth = await requireAdmin(req);
  if (!adminAuth.ok) {
    // Fall back to any master key — see auth note above. Tries all three
    // types since the test page doesn't tell us which one it's holding.
    const asText = await requireMasterKey(req, "text");
    const asImage = asText.ok ? asText : await requireMasterKey(req, "image");
    const asAudio = asImage.ok ? asImage : await requireMasterKey(req, "audio");
    if (!asAudio.ok) {
      return NextResponse.json({ error: "Requires admin password or a valid master key." }, { status: 401 });
    }
  }

  let body;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body." }, { status: 400 });
  }

  const { testType, provider, model, ok, status, latencyMs, input, output, errorMessage, attempts } = body || {};
  if (!testType || !provider || !model) {
    return NextResponse.json({ error: "`testType`, `provider`, and `model` are required." }, { status: 400 });
  }

  const docRef = await db()
    .collection("testHistory")
    .add({
      testType,
      provider,
      model,
      ok: Boolean(ok),
      status: status ?? null,
      latencyMs: latencyMs ?? null,
      // Truncated defensively server-side too — the client already trims
      // these, but a saved report shouldn't be able to balloon a Firestore
      // doc past its 1MB limit just because someone pasted a huge prompt.
      input: input ? String(input).slice(0, 2000) : null,
      output: output ? String(output).slice(0, 2000) : null,
      errorMessage: errorMessage ? String(errorMessage).slice(0, 1000) : null,
      attempts: Array.isArray(attempts) ? attempts.slice(0, 20) : null,
      createdAt: FieldValue.serverTimestamp(),
    });

  return NextResponse.json({ ok: true, id: docRef.id });
}

// DELETE /api/admin/test-history — clears saved test reports. Optional
// ?id=<docId> to delete a single report; without it, clears everything.
export async function DELETE(req) {
  const auth = await requireAdmin(req);
  if (!auth.ok) return NextResponse.json({ error: auth.error }, { status: auth.status });

  const id = new URL(req.url).searchParams.get("id");

  if (id) {
    await db().collection("testHistory").doc(id).delete();
    return NextResponse.json({ ok: true, deletedId: id });
  }

  const snap = await db().collection("testHistory").get();
  const batchSize = 400; // Firestore batch limit is 500; leave headroom
  const docs = snap.docs;
  for (let i = 0; i < docs.length; i += batchSize) {
    const batch = db().batch();
    docs.slice(i, i + batchSize).forEach((d) => batch.delete(d.ref));
    await batch.commit();
  }

  return NextResponse.json({ ok: true, deletedCount: docs.length });
}
