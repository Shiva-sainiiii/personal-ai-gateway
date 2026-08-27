import { NextResponse } from "next/server";
import crypto from "node:crypto";
import { requireAdmin } from "../../../../lib/auth.js";
import { sha256Hex } from "../../../../lib/crypto.js";
import { db } from "../../../../lib/firebaseAdmin.js";
import { FieldValue } from "firebase-admin/firestore";

export const runtime = "nodejs";

const TYPES = ["text", "image", "audio"];

// GET /api/admin/master-keys — shows which types are configured (never returns the plaintext/hash)
export async function GET(req) {
  const auth = requireAdmin(req);
  if (!auth.ok) return NextResponse.json({ error: auth.error }, { status: auth.status });

  const results = {};
  for (const type of TYPES) {
    const snap = await db().collection("masterKeys").doc(type).get();
    results[type] = snap.exists ? { configured: true, active: snap.data().active !== false } : { configured: false };
  }
  return NextResponse.json({ masterKeys: results });
}

// POST /api/admin/master-keys — generates a fresh random key for each type
// NOT already configured, hashes it, stores the hash in Firestore, and
// returns the PLAINTEXT keys once so you can copy them. They are never
// shown again and never stored in plaintext anywhere.
// Body (optional): { "regenerate": ["text"] } to force-regenerate specific types
// even if already configured (this invalidates the old key for that type).
export async function POST(req) {
  const auth = requireAdmin(req);
  if (!auth.ok) return NextResponse.json({ error: auth.error }, { status: auth.status });

  let body = {};
  try {
    body = await req.json();
  } catch {
    // empty body is fine — means "only create missing ones"
  }
  const regenerate = new Set(body?.regenerate || []);

  const plaintextKeys = {};

  for (const type of TYPES) {
    const ref = db().collection("masterKeys").doc(type);
    const snap = await ref.get();
    const alreadyConfigured = snap.exists;

    if (alreadyConfigured && !regenerate.has(type)) continue;

    const plaintext = crypto.randomBytes(24).toString("hex");
    await ref.set({
      hash: sha256Hex(plaintext),
      active: true,
      createdAt: FieldValue.serverTimestamp(),
    });
    plaintextKeys[type] = plaintext;
  }

  if (Object.keys(plaintextKeys).length === 0) {
    return NextResponse.json({
      message: "All master keys already configured. Pass { regenerate: [\"text\"] } to rotate a specific one.",
      generated: {},
    });
  }

  return NextResponse.json({
    message: "Copy these now — they are shown only once and are not stored in plaintext anywhere.",
    generated: plaintextKeys,
  });
}
