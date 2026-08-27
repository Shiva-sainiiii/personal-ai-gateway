import { db } from "./firebaseAdmin.js";

/**
 * Adapter rate limit saver.
 *
 * Some providers publish hard per-minute limits (e.g. Groq: 30 RPM on
 * several free models). Rather than waiting to get hit with a 429 and only
 * then cooling the key down, this proactively checks how many requests a
 * key has made in the last 60 seconds and skips it if it's already near
 * the known limit — saving a wasted round trip and getting to a working
 * key faster.
 *
 * This reads the key's own recent successCount deltas via requestLogs,
 * which is already being written by the orchestrator, so no extra writes
 * are needed here — just an extra read+filter before picking a key.
 */

// Known conservative per-minute ceilings for pool-critical providers.
// Missing entries just skip this check (treated as no known limit).
const KNOWN_RPM_LIMITS = {
  groq: 28, // slightly under Groq's published 30 RPM to leave headroom
};

export async function isNearRateLimit(provider, keyId) {
  const limit = KNOWN_RPM_LIMITS[provider];
  if (!limit) return false;

  const oneMinuteAgo = new Date(Date.now() - 60 * 1000);
  const snap = await db()
    .collection("requestLogs")
    .where("keyId", "==", keyId)
    .where("createdAt", ">=", oneMinuteAgo)
    .get();

  return snap.size >= limit;
}

/**
 * Filters a list of key docs down to ones that aren't currently near their
 * provider's known rate limit. If ALL keys are near the limit, returns the
 * original list unfiltered (better to try and possibly 429 than to return
 * nothing at all).
 */
export async function filterKeysUnderRateLimit(provider, keyDocs) {
  const limit = KNOWN_RPM_LIMITS[provider];
  if (!limit) return keyDocs;

  const checks = await Promise.all(keyDocs.map((k) => isNearRateLimit(provider, k.id)));
  const underLimit = keyDocs.filter((_, i) => !checks[i]);
  return underLimit.length > 0 ? underLimit : keyDocs;
}
