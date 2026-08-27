import { NextResponse } from "next/server";
import { requireAdmin } from "../../../../lib/auth.js";
import { encrypt } from "../../../../lib/crypto.js";
import { db } from "../../../../lib/firebaseAdmin.js";
import { FieldValue } from "firebase-admin/firestore";

export const runtime = "nodejs";

const VALID_PROVIDERS = ["openrouter", "googleAiStudio", "groq", "cerebras", "cloudflare", "pollinations"];
// Pollinations works with zero stored keys (its free no-key tier), so unlike
// every other provider it's allowed to be added with an empty apiKey field —
// this just records "yes, use Pollinations" / lets you upgrade to a real key later.
const KEY_OPTIONAL_PROVIDERS = ["pollinations"];

// GET /api/admin/keys — list all keys (metadata only, never decrypted values)
export async function GET(req) {
  const auth = requireAdmin(req);
  if (!auth.ok) return NextResponse.json({ error: auth.error }, { status: auth.status });

  const snap = await db().collection("apiKeys").get();
  const keys = snap.docs.map((doc) => {
    const { encryptedKey, ...safe } = doc.data();
    return { id: doc.id, ...safe };
  });

  return NextResponse.json({ keys });
}

// POST /api/admin/keys — add a new key from the frontend form
// Body: { provider, accountLabel, apiKey, accountId? }
export async function POST(req) {
  const auth = requireAdmin(req);
  if (!auth.ok) return NextResponse.json({ error: auth.error }, { status: auth.status });

  let body;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body." }, { status: 400 });
  }

  const { provider, accountLabel, apiKey, accountId } = body || {};

  if (!VALID_PROVIDERS.includes(provider)) {
    return NextResponse.json({ error: `provider must be one of: ${VALID_PROVIDERS.join(", ")}` }, { status: 400 });
  }
  if (!accountLabel || typeof accountLabel !== "string") {
    return NextResponse.json({ error: "accountLabel (string, e.g. 'acc1') is required." }, { status: 400 });
  }
  const keyOptional = KEY_OPTIONAL_PROVIDERS.includes(provider);
  if (!keyOptional && (!apiKey || typeof apiKey !== "string")) {
    return NextResponse.json({ error: "apiKey (string) is required." }, { status: 400 });
  }
  if (provider === "cloudflare" && !accountId) {
    return NextResponse.json({ error: "accountId is required for cloudflare keys." }, { status: 400 });
  }

  const docId = `${provider}_${accountLabel}`;
  // Pollinations can be registered with a blank key (uses the free no-key
  // tier); everything else always encrypts a real key.
  const encryptedKey = apiKey ? encrypt(apiKey) : null;

  await db()
    .collection("apiKeys")
    .doc(docId)
    .set({
      provider,
      accountLabel,
      encryptedKey,
      accountId: accountId || null,
      status: "active",
      cooldownUntil: null,
      failCount: 0,
      successCount: 0,
      lastUsedAt: null,
      lastError: null,
      createdAt: FieldValue.serverTimestamp(),
    });

  return NextResponse.json({ ok: true, id: docId });
}

// DELETE /api/admin/keys?id=openrouter_acc1
export async function DELETE(req) {
  const auth = requireAdmin(req);
  if (!auth.ok) return NextResponse.json({ error: auth.error }, { status: auth.status });

  const id = new URL(req.url).searchParams.get("id");
  if (!id) return NextResponse.json({ error: "?id=<docId> query param is required." }, { status: 400 });

  await db().collection("apiKeys").doc(id).delete();
  return NextResponse.json({ ok: true });
}

// PATCH /api/admin/keys — reactivate a disabled/cooldown key without
// deleting and re-adding it (e.g. after fixing a billing issue or rotating
// a key on the provider's side while keeping the same encrypted value here).
// Body: { id: "cerebras_acc1" }
export async function PATCH(req) {
  const auth = requireAdmin(req);
  if (!auth.ok) return NextResponse.json({ error: auth.error }, { status: auth.status });

  let body;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body." }, { status: 400 });
  }

  const { id } = body || {};
  if (!id) return NextResponse.json({ error: "`id` is required." }, { status: 400 });

  await db().collection("apiKeys").doc(id).update({
    status: "active",
    cooldownUntil: null,
    failCount: 0,
    lastError: null,
  });

  return NextResponse.json({ ok: true });
}
