import crypto from "node:crypto";
import { db } from "./firebaseAdmin.js";
import { FieldValue } from "firebase-admin/firestore";

/**
 * Smart cache engine.
 *
 * Vercel serverless functions don't share memory between invocations, so an
 * in-process cache would almost never hit. Instead this caches in Firestore,
 * keyed by a hash of (pool, messages). Identical requests within the TTL
 * window return instantly without touching any provider — saving tokens
 * and dodging rate limits for repeated/duplicate prompts.
 *
 * Note: this trades a Firestore read/write (fast, free-tier friendly) for
 * an external API call (slower, rate-limited) — a good trade for anything
 * that repeats, like common system prompts or FAQ-style queries.
 */

const DEFAULT_TTL_MS = 10 * 60 * 1000; // 10 minutes

function hashRequest(poolName, messages) {
  const normalized = JSON.stringify({ poolName, messages });
  return crypto.createHash("sha256").update(normalized).digest("hex");
}

export async function getCached(poolName, messages) {
  const key = hashRequest(poolName, messages);
  const ref = db().collection("responseCache").doc(key);
  const snap = await ref.get();
  if (!snap.exists) return null;

  const data = snap.data();
  const expiresAt = data.expiresAt?.toMillis?.() ?? 0;
  if (Date.now() > expiresAt) {
    // Bug fix: an expired doc used to just be treated as a cache miss and
    // left in Firestore forever — every unique prompt that ever passed
    // through the cache became a permanent orphaned document, since nothing
    // ever deleted it. Best-effort delete right here on the read that finds
    // it stale (fire-and-forget, doesn't block the response). This alone
    // only cleans up keys that get looked up again after expiring — a
    // one-off prompt that's never repeated still lingers, which is what the
    // Firestore TTL policy in the README's cleanup section is for; this is
    // the cheap partial fix that needs no extra setup.
    ref.delete().catch(() => {});
    return null;
  }

  // Fire-and-forget hit counter for observability — don't block the response on it.
  ref.update({ hits: FieldValue.increment(1) }).catch(() => {});

  return { text: data.text, provider: data.provider, model: data.model, cached: true };
}

export async function setCached(poolName, messages, { text, provider, model }, ttlMs = DEFAULT_TTL_MS) {
  const key = hashRequest(poolName, messages);
  await db()
    .collection("responseCache")
    .doc(key)
    .set({
      text,
      provider,
      model,
      poolName,
      hits: 0,
      createdAt: FieldValue.serverTimestamp(),
      expiresAt: new Date(Date.now() + ttlMs),
    });
}
