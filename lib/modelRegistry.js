// Task-based routing map. Each entry knows which provider it belongs to
// (so orchestrator can find the right key) and its model id in that
// provider's own naming scheme.
//
// gateway_type decides WHICH pool a request draws from:
//   TEXT              -> default text requests (fast, high-reasoning)
//   TEXT_FALLBACK     -> used when TEXT pool is exhausted / needs huge context
//   VISION            -> requests that include an image
//   ADDITIONAL_LIVE_POOL -> extra capacity, tried after TEXT+TEXT_FALLBACK

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
    { provider: "googleAiStudio", model: "gemini-2.5-flash", contextWindow: 1048576, note: "native multimodal" },
    { provider: "googleAiStudio", model: "gemini-2.5-flash-lite", contextWindow: 1048576, note: "low-latency multimodal" },
    { provider: "googleAiStudio", model: "gemini-2.0-flash", contextWindow: 1048576, note: "production multimodal" },
    { provider: "googleAiStudio", model: "gemma-3-27b-it", contextWindow: 8192, note: "advanced text open weights" },
    { provider: "groq", model: "openai/gpt-oss-120b", contextWindow: 131072, note: "reasoning MoE" },
    // Groq deprecated qwen/qwen3-32b (June 2026) — migrated to their
    // recommended replacement, openai/gpt-oss-120b.
    { provider: "groq", model: "openai/gpt-oss-20b", contextWindow: 131072, note: "faster/smaller alternative for simple requests" },
    { provider: "cerebras", model: "zai-glm-4.7", contextWindow: 131072, note: "complex reasoning and tool use" },
    { provider: "cerebras", model: "qwen-3-235b-a22b-instruct-2507", contextWindow: 131072, note: "massive open weight reasoning" },
    { provider: "cloudflare", model: "@cf/meta/llama-3.3-70b-instruct", contextWindow: 24000, note: "FP8 fast version" },
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
