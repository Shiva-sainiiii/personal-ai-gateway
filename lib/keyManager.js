import { db } from "./firebaseAdmin.js";
import { decrypt } from "./crypto.js";
import { FieldValue } from "firebase-admin/firestore";

/**
 * Firestore schema (per-key documents), collection "apiKeys":
 * {
 *   provider: "openrouter" | "googleAiStudio" | "groq" | "cerebras" | "cloudflare",
 *   accountLabel: "acc1" | "acc2" | "acc3" | "acc4",
 *   encryptedKey: "<base64 AES-GCM blob>",
 *   accountId: "<only for cloudflare, plaintext, not secret>",
 *   status: "active" | "cooldown" | "disabled",
 *   cooldownUntil: Timestamp | null,
 *   failCount: number,
 *   successCount: number,
 *   lastUsedAt: Timestamp | null,
 *   lastError: string | null,
 *   createdAt: Timestamp
 * }
 *
 * Doc ID convention: `${provider}_${accountLabel}` e.g. "openrouter_acc1"
 */

const COOLDOWN_MS = 10 * 60 * 1000; // 10 min cooldown after a rate-limit/failure before retrying that key

export async function getActiveKeysForProvider(provider) {
  const snap = await db()
    .collection("apiKeys")
    .where("provider", "==", provider)
    .where("status", "in", ["active", "cooldown"])
    .get();

  const now = Date.now();
  const keys = [];
  snap.forEach((doc) => {
    const data = doc.data();
    // A "cooldown" key becomes usable again once its cooldown window has passed.
    const cooldownUntil = data.cooldownUntil?.toMillis?.() ?? 0;
    if (data.status === "cooldown" && cooldownUntil > now) return;
    keys.push({ id: doc.id, ...data });
  });

  // Least-recently-used first — spreads load evenly across the 4 accounts per provider.
  keys.sort((a, b) => (a.lastUsedAt?.toMillis?.() ?? 0) - (b.lastUsedAt?.toMillis?.() ?? 0));
  return keys;
}

export function decryptKeyDoc(keyDoc) {
  // Pollinations rows can be seeded with no key at all (its free no-key
  // tier) — encryptedKey is null in that case, so return null instead of
  // trying to AES-decrypt nothing.
  if (!keyDoc.encryptedKey) return null;
  return decrypt(keyDoc.encryptedKey);
}

export async function markKeySuccess(keyId) {
  await db()
    .collection("apiKeys")
    .doc(keyId)
    .update({
      status: "active",
      lastUsedAt: FieldValue.serverTimestamp(),
      successCount: FieldValue.increment(1),
      lastError: null,
    });
}

export async function markKeyFailure(keyId, errorMessage, isRateLimit, isPermanentFailure) {
  const update = {
    lastUsedAt: FieldValue.serverTimestamp(),
    failCount: FieldValue.increment(1),
    lastError: String(errorMessage).slice(0, 500),
  };
  if (isPermanentFailure) {
    // Invalid key, payment required, or model not found — retrying on a timer
    // won't help, so stop wasting attempts on this key until someone fixes it
    // manually (re-add the key or check the provider account).
    update.status = "disabled";
  } else if (isRateLimit) {
    update.status = "cooldown";
    update.cooldownUntil = new Date(Date.now() + COOLDOWN_MS);
  }
  await db().collection("apiKeys").doc(keyId).update(update);
}

export function isRateLimitError(status) {
  return status === 429 || status === 403;
}

// 401 (bad key), 402 (payment required / plan issue), 404 (model not found
// or decommissioned) are not transient — cooling down and retrying later
// wastes an attempt every single request until someone fixes the root cause.
export function isPermanentError(status) {
  return status === 401 || status === 402 || status === 404;
}

/**
 * Logs every request/response outcome permanently to Firestore ("requestLogs")
 * for the tracking/observability dashboard.
 */
export async function logRequest({ type, provider, keyId, model, ok, status, latencyMs, errorMessage, usage }) {
  await db()
    .collection("requestLogs")
    .add({
      type, // "text" | "image" | "audio"
      provider,
      keyId,
      model,
      ok,
      status: status ?? null,
      latencyMs,
      errorMessage: errorMessage ? String(errorMessage).slice(0, 500) : null,
      promptTokens: usage?.promptTokens ?? null,
      completionTokens: usage?.completionTokens ?? null,
      totalTokens: usage?.totalTokens ?? null,
      createdAt: FieldValue.serverTimestamp(),
    });
}
