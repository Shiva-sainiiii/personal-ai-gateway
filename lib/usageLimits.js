// Published free-tier daily limits, per account/key, as of Aug 2026.
// Sources checked against each provider's own docs/pricing pages.
//
// unit: "tokens" | "requests" | "neurons" — Cloudflare doesn't meter in
// tokens, it uses its own normalized "Neuron" compute unit, so it's kept
// separate rather than forced into a token comparison that wouldn't be
// accurate.
//
// These are PER-ACCOUNT numbers. The gateway's actual effective daily
// capacity for a provider = this number × how many active accounts/keys
// you have for that provider (since each account gets its own bucket).
export const DAILY_FREE_LIMITS = {
  groq: { unit: "tokens", amount: 500000, note: "~500K TPD typical on free-tier text models (varies by model, some up to ~1M)" },
  cerebras: { unit: "tokens", amount: 1000000, note: "1M tokens/day, flat across free-tier models" },
  openrouter: { unit: "requests", amount: 50, note: "50 requests/day per account on :free models (1000/day if $10+ credits ever purchased)" },
  googleAiStudio: { unit: "requests", amount: 1500, note: "~1500 requests/day typical on Gemini Flash-tier free models" },
  cloudflare: { unit: "neurons", amount: 10000, note: "10,000 Neurons/day, shared across all model types (text/image/audio)" },
  pollinations: { unit: "requests", amount: null, note: "no published daily cap — billed per-request in \"pollen\" balance instead" },
};

// --- Live usage tracking ---------------------------------------------------
//
// The limits above used to be display-only (shown in the admin dashboard
// with zero effect on routing). This section makes them load-bearing: every
// successful request increments a per-key daily counter in Firestore
// ("usageCounters/{keyId}_{YYYY-MM-DD}"), and rankModelsByRemainingQuota can
// then prefer whichever provider/key has the most headroom left today —
// instead of hammering one key until it 429s and only THEN moving on.
//
// This doesn't replace the reactive cooldown/disable logic in keyManager.js
// (a provider can still fail for reasons this can't predict — outages,
// unpublished stricter limits, etc.) — it's a proactive layer on top: spread
// load BEFORE hitting the wall, rather than only reacting after.

import { db } from "./firebaseAdmin.js";
import { FieldValue } from "firebase-admin/firestore";

function todayKey() {
  return new Date().toISOString().slice(0, 10); // YYYY-MM-DD, UTC
}

/**
 * Call after a successful request to record how much quota it used.
 * amount is in whatever unit that provider's DAILY_FREE_LIMITS entry uses
 * (tokens for groq/cerebras, requests for openrouter/googleAiStudio,
 * neurons for cloudflare — pass 1 for a flat per-request count, or the
 * actual token/neuron count when known).
 */
export async function recordUsage(provider, keyId, amount = 1) {
  const docId = `${keyId}_${todayKey()}`;
  await db()
    .collection("usageCounters")
    .doc(docId)
    .set(
      {
        provider,
        keyId,
        date: todayKey(),
        used: FieldValue.increment(amount),
        updatedAt: FieldValue.serverTimestamp(),
      },
      { merge: true }
    );
}

/**
 * Returns { used, limit, remainingPct } for a single key today.
 * remainingPct is null when the provider has no published cap (e.g.
 * Pollinations) — callers should treat null as "unknown, don't deprioritize."
 */
export async function getRemainingQuota(provider, keyId) {
  const limitInfo = DAILY_FREE_LIMITS[provider];
  if (!limitInfo || limitInfo.amount == null) {
    return { used: 0, limit: null, remainingPct: null };
  }

  const docId = `${keyId}_${todayKey()}`;
  const snap = await db().collection("usageCounters").doc(docId).get();
  const used = snap.exists ? snap.data().used || 0 : 0;
  const remainingPct = Math.max(0, Math.round(((limitInfo.amount - used) / limitInfo.amount) * 100));
  return { used, limit: limitInfo.amount, remainingPct };
}

/**
 * Batch version for the orchestrator's hot path — one Firestore getAll()
 * instead of N sequential getRemainingQuota() calls when ranking a pool's
 * worth of keys before picking which to try first.
 */
export async function getRemainingQuotaBatch(pairs) {
  const docIds = pairs.map((p) => `${p.keyId}_${todayKey()}`);
  const refs = docIds.map((id) => db().collection("usageCounters").doc(id));
  const snaps = refs.length ? await db().getAll(...refs) : [];

  const results = {};
  snaps.forEach((snap, i) => {
    const { provider, keyId } = pairs[i];
    const limitInfo = DAILY_FREE_LIMITS[provider];
    const used = snap.exists ? snap.data().used || 0 : 0;
    const remainingPct =
      !limitInfo || limitInfo.amount == null ? null : Math.max(0, Math.round(((limitInfo.amount - used) / limitInfo.amount) * 100));
    results[keyId] = { used, limit: limitInfo?.amount ?? null, remainingPct };
  });
  return results;
}

/**
 * Sorts a list of key docs by descending remaining quota % (most headroom
 * first). Keys with unknown/no-cap quota (remainingPct === null) sort as if
 * they had 100% remaining — no data shouldn't mean "deprioritized."
 */
export async function rankKeysByRemainingQuota(provider, keyDocs) {
  if (keyDocs.length <= 1) return keyDocs; // nothing to reorder
  const pairs = keyDocs.map((k) => ({ provider, keyId: k.id }));
  const quotas = await getRemainingQuotaBatch(pairs);

  return [...keyDocs].sort((a, b) => {
    const pctA = quotas[a.id]?.remainingPct ?? 100;
    const pctB = quotas[b.id]?.remainingPct ?? 100;
    return pctB - pctA;
  });
}
