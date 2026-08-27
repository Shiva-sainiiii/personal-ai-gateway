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
  const snap = await db().collection("responseCache").doc(key).get();
  if (!snap.exists) return null;

  const data = snap.data();
  const expiresAt = data.expiresAt?.toMillis?.() ?? 0;
  if (Date.now() > expiresAt) return null; // stale, treat as miss

  // Fire-and-forget hit counter for observability — don't block the response on it.
  db().collection("responseCache").doc(key).update({ hits: FieldValue.increment(1) }).catch(() => {});

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
