// Published free-tier daily limits, verified against each provider's own
// docs/pricing pages as of Aug 2026 (see docs/PROVIDER_LIMITS.md for the
// full research trail this was built from).
//
// unit: "tokens" | "requests" | "neurons" — Cloudflare doesn't meter in
// tokens, it uses its own normalized "Neuron" compute unit, so it's kept
// separate rather than forced into a token comparison that wouldn't be
// accurate.
//
// QUOTA SCOPE — this is the part that actually changes routing behavior,
// not just the displayed number:
//   "account-wide": one shared bucket for the whole account, no matter
//                    which model you call. Burning this bucket on Model A
//                    blocks Model B on the SAME key too.
//   "per-model":    each model gets its OWN separate bucket, same
//                    account/key. Exhausting Model A's quota leaves
//                    Model B on that same key completely fresh.
// Getting this wrong in one specific direction is the expensive mistake:
// treating a "per-model" provider as "account-wide" makes the router think
// a key is dead (and skip it) when actually only ONE model on that key is
// exhausted — the other models are still fully usable. The account-wide
// DAILY_FREE_LIMITS entries below are still meaningful as a single flat
// per-key cap; the per-model providers instead carry their real ceiling in
// PER_MODEL_LIMITS (lib/providers.js's freeModels / modelRegistry.js
// entries), and DAILY_FREE_LIMITS.amount is left null for them so nothing
// here silently double-tracks against the wrong bucket.
//
// These are PER-ACCOUNT numbers. The gateway's actual effective daily
// capacity for a provider = this number × how many active accounts/keys
// you have for that provider (since each account gets its own bucket).
export const DAILY_FREE_LIMITS = {
  // Per-model scope — Groq gives each model (openai/gpt-oss-120b,
  // llama-3.1-8b-instant, etc.) its own RPM/RPD/TPM/TPD bucket. There is no
  // single account-wide number to track here; see PER_MODEL_LIMITS.groq.
  groq: { unit: "tokens", amount: null, scope: "per-model", note: "no flat account cap — every model has its own RPM/RPD/TPM/TPD, see PER_MODEL_LIMITS.groq" },
  // Cerebras' free *trial* (not a permanent free tier) is a flat $5-credit,
  // 30-day-expiring allowance, account-wide across whichever free model you
  // call. As of Aug 2026 a verified payment method is REQUIRED to activate
  // it at all — see requiresPaymentMethod below.
  cerebras: {
    unit: "requests",
    amount: null,
    scope: "account-wide",
    requiresPaymentMethod: true,
    note: "Free TRIAL (not a standing free tier): $5 credit, expires 30 days after issuance. 5 RPM / 30,000 TPM / 1,000,000 TPM-per-hour / 1,000,000 TPD, shared across the account. Verified payment method is mandatory to activate — bare signup leaves API/Playground access inactive.",
  },
  // Account-wide — every :free model on an OpenRouter key shares one pool.
  openrouter: {
    unit: "requests",
    amount: 50,
    scope: "account-wide",
    note: "20 RPM / 50 RPD per account on :free models with no lifetime credits. Rises to 20 RPM / 1,000 RPD once $10+ lifetime credits have EVER been purchased on that account (a one-time unlock, not a recurring spend).",
  },
  // Per-model scope — Google removed its public per-model RPM/TPM/RPD tables
  // from the rate-limits doc in Aug 2026; exact numbers now only show up in
  // each project's own AI Studio console, so no reliable flat number exists
  // to put here. What IS confirmed: every free-tier model carries its own
  // RPM *and* TPM *and* a daily RPD cap (RPD resets at midnight Pacific) —
  // it is NOT "RPM only, no daily cap" for any model.
  googleAiStudio: {
    unit: "requests",
    amount: null,
    scope: "per-model",
    note: "Google pulled the public per-model rate-limit tables from docs in Aug 2026 — exact RPM/TPM/RPD now only visible per-project in the AI Studio console itself. Confirmed shape: RPM + TPM + RPD all apply per model (RPD resets midnight Pacific); this is NOT an RPM-only/no-daily-cap tier for any model. Treat any specific number here as unverified until checked in-console.",
  },
  // Account-wide — Cloudflare's Neuron pool is shared across every model
  // type (text/image/audio) on the account.
  cloudflare: { unit: "neurons", amount: 10000, scope: "account-wide", note: "10,000 Neurons/day, shared across all model types (text/image/audio). Resets daily at 00:00 UTC. No credit card required." },
  pollinations: { unit: "requests", amount: null, scope: "account-wide", note: "no published daily cap — billed per-request in \"pollen\" balance instead" },
};

// Per-model free-tier limits for providers whose quota_scope is "per-model"
// or "mixed" — i.e. providers where DAILY_FREE_LIMITS above can't express a
// single meaningful account-wide number. Keyed by the exact model id as
// used in the API call (matches providers.js's freeModels / modelRegistry.js
// entries). rpm/rpd/tpm/tpd are null where that dimension doesn't apply or
// isn't published for that model.
//
// Groq numbers below are the Developer/free-tier limits confirmed against
// Groq's own docs as of Aug 2026 (console.groq.com/docs/rate-limits).
export const PER_MODEL_LIMITS = {
  groq: {
    "openai/gpt-oss-120b": { rpm: 30, rpd: 1000, tpm: 8000, tpd: 200000 },
    "openai/gpt-oss-20b": { rpm: 30, rpd: 1000, tpm: 8000, tpd: 200000 },
    "llama-3.3-70b-versatile": { rpm: 30, rpd: 1000, tpm: 12000, tpd: 100000 },
    "llama-3.1-8b-instant": { rpm: 30, rpd: 14400, tpm: 6000, tpd: 500000 },
    "groq/compound": { rpm: 30, rpd: 250, tpm: 70000, tpd: null },
    "groq/compound-mini": { rpm: 30, rpd: 250, tpm: 70000, tpd: null },
    // Not independently re-verified against Groq's Aug 2026 docs in this
    // pass — kept from the prior config but treat as unverified until
    // checked against console.groq.com/docs/rate-limits directly.
    "deepseek-r1-distill-llama-70b": { rpm: null, rpd: null, tpm: null, tpd: null, unverified: true },
    "qwen-2.5-coder-32b": { rpm: null, rpd: null, tpm: null, tpd: null, unverified: true },
    "mixtral-8x7b-32768": { rpm: null, rpd: null, tpm: null, tpd: null, unverified: true },
    "gemma-2-9b-it": { rpm: null, rpd: null, tpm: null, tpd: null, unverified: true },
    "qwen/qwen3.6-27b": { rpm: null, rpd: null, tpm: null, tpd: null, unverified: true },
  },
};

/**
 * Looks up a model's own rate-limit numbers for per-model/mixed-scope
 * providers. Returns null if the provider isn't per-model-scoped or the
 * specific model has no recorded entry (callers should treat null as
 * "unknown, don't assume a specific ceiling" rather than "unlimited").
 */
export function getPerModelLimit(provider, model) {
  return PER_MODEL_LIMITS[provider]?.[model] ?? null;
}

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
