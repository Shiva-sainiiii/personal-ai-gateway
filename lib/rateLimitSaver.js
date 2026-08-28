import { db } from "./firebaseAdmin.js";

/**
 * Adapter rate limit saver.
 *
 * Some providers publish hard limits over a specific time window (e.g.
 * Groq: 30 RPM on several free models; OpenRouter: 50 requests/day per
 * account on :free models). Rather than waiting to get hit with a 429 and
 * only then cooling the key down, this proactively checks how many requests
 * a key has made within its provider's known window and skips it if it's
 * already near the limit — saving a wasted round trip and getting to a
 * working key faster.
 *
 * This reads the key's own recent successCount deltas via requestLogs,
 * which is already being written by the orchestrator, so no extra writes
 * are needed here — just an extra read+filter before picking a key.
 *
 * Bug fix: OpenRouter was missing from this entirely, despite its 50
 * requests/day per-account cap being exactly the kind of hard, predictable
 * limit this module exists to catch early — every OpenRouter key kept
 * getting tried even once its daily quota was exhausted, guaranteeing a
 * wasted 429 attempt on every fallback into the TEXT_FALLBACK pool for the
 * rest of the day. Now included with a 24h window instead of Groq's 60s one.
 *
 * Bug fix (scale): this used to run one Firestore query PER KEY, PER
 * REQUEST (isNearRateLimit called once per key doc in filterKeysUnderRateLimit's
 * Promise.all) — with 4 Groq accounts that's 4 extra reads on every single
 * text request just for this check, and it only gets worse as more
 * rate-limited providers are added (like OpenRouter now). Replaced with one
 * batched query per provider (all of that provider's keys' recent logs in a
 * single `where("keyId", "in", [...])` read), counted client-side per key.
 */

// Known conservative ceilings for pool-critical providers, and the time
// window they reset over. Missing entries just skip this check (treated as
// no known limit).
const KNOWN_LIMITS = {
  groq: { max: 28, windowMs: 60 * 1000 }, // slightly under Groq's published 30 RPM to leave headroom
  openrouter: { max: 45, windowMs: 24 * 60 * 60 * 1000 }, // slightly under OpenRouter's published 50/day to leave headroom
};

/**
 * Filters a list of key docs down to ones that aren't currently near their
 * provider's known rate limit. If ALL keys are near the limit, returns the
 * original list unfiltered (better to try and possibly 429 than to return
 * nothing at all). Does a single batched Firestore read for the whole
 * provider instead of one read per key.
 */
export async function filterKeysUnderRateLimit(provider, keyDocs) {
  const limitConfig = KNOWN_LIMITS[provider];
  if (!limitConfig || keyDocs.length === 0) return keyDocs;

  const windowStart = new Date(Date.now() - limitConfig.windowMs);
  const keyIds = keyDocs.map((k) => k.id);

  // Firestore "in" queries cap at 30 values — with 4 accounts per provider
  // this is nowhere close, but guard against it anyway if that ever changes.
  const idBatches = [];
  for (let i = 0; i < keyIds.length; i += 30) idBatches.push(keyIds.slice(i, i + 30));

  const counts = {};
  for (const id of keyIds) counts[id] = 0;

  await Promise.all(
    idBatches.map(async (batch) => {
      const snap = await db()
        .collection("requestLogs")
        .where("keyId", "in", batch)
        .where("createdAt", ">=", windowStart)
        .get();
      snap.forEach((doc) => {
        const keyId = doc.data().keyId;
        if (keyId in counts) counts[keyId] += 1;
      });
    })
  );

  const underLimit = keyDocs.filter((k) => counts[k.id] < limitConfig.max);
  return underLimit.length > 0 ? underLimit : keyDocs;
}
