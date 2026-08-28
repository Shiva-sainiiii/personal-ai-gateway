// Task-based routing map. Each entry knows which provider it belongs to
// (so orchestrator can find the right key) and its model id in that
// provider's own naming scheme.
//
// gateway_type decides WHICH pool a request draws from:
//   TEXT              -> default text requests (fast, high-reasoning)
//   TEXT_FALLBACK     -> used when TEXT pool is exhausted / needs huge context
//   VISION            -> requests that include an image
//   ADDITIONAL_LIVE_POOL -> extra capacity, tried after TEXT+TEXT_FALLBACK
//
// DESIGN PRINCIPLE — models vs accounts:
// Some free tiers (OpenRouter, Google AI Studio) rate-limit at the ACCOUNT
// level: one shared bucket across every model you call, so listing 10
// models from the same account buys nothing — it only adds dead attempts
// before the loop falls through to a provider that can actually help.
// Other tiers (Groq) grant a SEPARATE bucket per model within one account,
// so a second/third Groq model here is genuine extra capacity, not clutter.
// Real extra headroom for account-limited providers comes from adding more
// *accounts* (keyManager/Firestore), not more models in this file. Keep
// each pool to the smallest set of models that's actually load-bearing.

export const MODEL_REGISTRY = {
  TEXT: [
    // Groq deprecated llama-3.3-70b-versatile (June 2026) — migrated to their
    // recommended replacement, openai/gpt-oss-120b.
    { provider: "groq", model: "openai/gpt-oss-120b", contextWindow: 131072, note: "coding/reasoning, Groq's post-deprecation default" },
    { provider: "cerebras", model: "gpt-oss-120b", contextWindow: 131072, note: "extreme speed MoE, ~3000 tok/s" },
  ],
  TEXT_FALLBACK: [
    { provider: "openrouter", model: "nvidia/nemotron-3-ultra-550b-a55b:free", contextWindow: 1000000, note: "1M context king" },
    { provider: "openrouter", model: "openrouter/free", contextWindow: 131072, note: "auto router fallback" },
  ],
  VISION: [
    // Groq deprecated meta-llama/llama-4-scout-17b-16e-instruct (June 2026) —
    // migrated to their recommended multimodal replacement, qwen/qwen3.6-27b.
    { provider: "groq", model: "qwen/qwen3.6-27b", contextWindow: 131072, note: "multimodal, Groq's post-deprecation vision model (preview)" },
    { provider: "openrouter", model: "google/gemma-4-31b-it:free", contextWindow: 262144, note: "dense multimodal with reasoning" },
  ],
  ADDITIONAL_LIVE_POOL: [
    // One model per provider is intentional here, not an oversight.
    // OpenRouter/Google AI Studio free tiers rate-limit at the ACCOUNT level,
    // not per-model — so listing 4 Google models or 3 OpenRouter models adds
    // zero extra headroom, it just makes a dead request try 3 more times
    // before falling through to a provider that can actually help. Multiple
    // *accounts* (handled by keyManager, not this list) are what actually
    // buys extra capacity for those providers. Groq is the one provider
    // whose free tier grants separate RPM/TPD buckets per model, so a
    // second Groq entry here is a genuine capacity add, not just clutter.
    { provider: "googleAiStudio", model: "gemini-2.5-flash", contextWindow: 1048576, note: "best balance of quality/speed/context on the free tier" },
    { provider: "groq", model: "openai/gpt-oss-20b", contextWindow: 131072, note: "separate per-model quota bucket from openai/gpt-oss-120b in the TEXT pool" },
    { provider: "cerebras", model: "zai-glm-4.7", contextWindow: 131072, note: "complex reasoning and tool use" },
    { provider: "cloudflare", model: "@cf/meta/llama-3.3-70b-instruct", contextWindow: 24000, note: "FP8 fast version, different account pool entirely" },
  ],
};

// Order in which pools are tried for a plain text request (no image attached).
export const TEXT_POOL_ORDER = ["TEXT", "TEXT_FALLBACK", "ADDITIONAL_LIVE_POOL"];

// Order in which pools are tried when the request includes an image.
export const VISION_POOL_ORDER = ["VISION", "ADDITIONAL_LIVE_POOL", "TEXT_FALLBACK"];

/**
 * Picks the right pool order based on whether the request needs vision
 * and whether it needs a big context window (auto-routing).
 */
export function resolvePoolOrder({ hasImage, estimatedTokens }) {
  if (hasImage) return VISION_POOL_ORDER;
  // Auto route to the 1M-context fallback pool first if the prompt is huge.
  if (estimatedTokens && estimatedTokens > 100000) {
    return ["TEXT_FALLBACK", "TEXT", "ADDITIONAL_LIVE_POOL"];
  }
  return TEXT_POOL_ORDER;
}

export function modelsInPool(poolName) {
  return MODEL_REGISTRY[poolName] || [];
}
