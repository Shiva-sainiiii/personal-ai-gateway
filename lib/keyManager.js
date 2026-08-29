import { db } from "./firebaseAdmin.js";
import { decrypt } from "./crypto.js";
import { FieldValue } from "firebase-admin/firestore";
import { checkAndAlertIfProviderDown } from "./alerts.js";

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
      consecutive403: 0, // a real success proves the key isn't permanently forbidden
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
    update.consecutive403 = 0;
    update.disabledAt = FieldValue.serverTimestamp();
  } else if (isRateLimit) {
    update.status = "cooldown";
    update.cooldownUntil = new Date(Date.now() + COOLDOWN_MS);
  }
  await db().collection("apiKeys").doc(keyId).update(update);

  if (isPermanentFailure) {
    // keyId is always "{provider}_{accountLabel}" by our own doc-ID
    // convention (see seed-keys.mjs / the admin add-key route) — cheaper
    // than an extra Firestore read just to get the provider name back.
    const provider = keyId.split("_")[0];
    checkAndAlertIfProviderDown(provider).catch(() => {}); // fire-and-forget, never block the caller
  }
}

// Same as markKeyFailure, but specifically for a 403 response: 403 is
// ambiguous across providers (some send it for "rate limited", others for
// "this key/project will never be allowed to do this"), so instead of
// guessing from the status code alone, this tracks how many *consecutive*
// 403s a key has taken. A single 403 still just cools the key down like any
// other rate limit — but if it keeps happening every single time (never
// broken up by a success), that's the signal of a genuinely permanent
// restriction, and the key gets disabled instead of retried forever.
const CONSECUTIVE_403_DISABLE_THRESHOLD = 5;

export async function markKeyFailure403(keyId, errorMessage) {
  const ref = db().collection("apiKeys").doc(keyId);
  const snap = await ref.get();
  const prevConsecutive = snap.exists ? snap.data().consecutive403 || 0 : 0;
  const nextConsecutive = prevConsecutive + 1;

  const update = {
    lastUsedAt: FieldValue.serverTimestamp(),
    failCount: FieldValue.increment(1),
    lastError: String(errorMessage).slice(0, 500),
    consecutive403: nextConsecutive,
  };

  if (nextConsecutive >= CONSECUTIVE_403_DISABLE_THRESHOLD) {
    update.status = "disabled";
    update.disabledAt = FieldValue.serverTimestamp();
  } else {
    update.status = "cooldown";
    update.cooldownUntil = new Date(Date.now() + COOLDOWN_MS);
  }

  await ref.update(update);

  if (nextConsecutive >= CONSECUTIVE_403_DISABLE_THRESHOLD) {
    const provider = keyId.split("_")[0];
    checkAndAlertIfProviderDown(provider).catch(() => {});
  }
}

export function isRateLimitError(status) {
  return status === 429 || status === 403;
}

// 401 (bad key), 402 (payment required / plan issue), 404 (model not found
// or decommissioned) are not transient — cooling down and retrying later
// wastes an attempt every single request until someone fixes the root cause.
// 403 is intentionally NOT included here — see markKeyFailure403 above for
// why it needs a consecutive-count check instead of a flat classification.
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
