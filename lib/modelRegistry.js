// Task-based routing map. Each entry knows which provider it belongs to
// (so orchestrator can find the right key) and its model id in that
// provider's own naming scheme.
//
// gateway_type decides WHICH pool a request draws from:
//   SIMPLE            -> short, plain-language, conversational requests
//                        (greetings, quick facts, small rewrites) — fast,
//                        cheap models that also happen to have separate
//                        quota buckets from the TEXT pool, so simple chat
//                        traffic doesn't eat into coding-task headroom
//   TEXT              -> standard requests: not trivial chat, not flagged
//                        complex either (default middle ground)
//   TEXT_COMPLEX      -> coding, debugging, multi-step reasoning, or
//                        anything classifyComplexity() flags as needing a
//                        stronger/more careful model
//   TEXT_FALLBACK     -> used when the above pools are exhausted / request
//                        needs huge context (>100K tokens)
//   VISION            -> requests that include an image
//   ADDITIONAL_LIVE_POOL -> extra capacity, tried after everything else
//
// DESIGN PRINCIPLE — models vs accounts:
// Some free tiers rate-limit at the ACCOUNT level: one shared bucket across
// every model you call, so listing 10 models from the same account buys
// nothing — it only adds dead attempts before the loop falls through to a
// provider that can actually help. OpenRouter and Cloudflare work this way
// (verified Aug 2026 — see usageLimits.js's DAILY_FREE_LIMITS scope field).
// Other tiers grant a SEPARATE bucket per model within one account, so a
// second/third model from that SAME provider here is genuine extra
// capacity, not clutter. Groq works this way, and — corrected from an
// earlier assumption — so does Google AI Studio: each Gemini/Gemma model
// has its own RPM/TPM/RPD bucket on the same project/key, it is NOT one
// shared account-wide pool. (Google removed its public per-model limit
// tables from docs in Aug 2026, so exact numbers aren't hardcoded here, but
// the per-model SHAPE is confirmed.) Real extra headroom for account-scoped
// providers comes from adding more *accounts* (keyManager/Firestore), not
// more models in this file; for per-model providers, adding another model
// from the SAME account is also genuine extra capacity. Keep each pool to
// the smallest set of models that's actually load-bearing.
//
// COMPLEXITY-BASED ROUTING (new): resolvePoolOrder() below picks a
// different pool ORDER depending on classifyComplexity()'s verdict on the
// request (see tokenTools.js). A "hi" doesn't need the same model as "debug
// this race condition in my async queue" — sending both to the same pool
// either wastes a strong model's quota on trivial chat, or under-serves a
// genuinely hard request. SIMPLE and TEXT_COMPLEX intentionally draw from
// mostly-overlapping-but-differently-ordered provider sets rather than
// fully separate accounts — the point isn't "less total capacity for
// complex work", it's "don't burn the same quota bucket on both kinds of
// traffic when a cheaper option exists for the easy kind".

export const MODEL_REGISTRY = {
  SIMPLE: [
    // Cerebras' small/fast model and Groq's 20B variant both sit in
    // DIFFERENT quota buckets from the TEXT_COMPLEX pool's heavier models
    // below (Cerebras is a flat per-account token pool either way, but
    // routing light traffic here still means the 120B-class models spend
    // fewer cycles idle-processing "hi" style requests and stay fresher
    // for when a complex request actually needs them first-try).
    { provider: "groq", model: "openai/gpt-oss-20b", contextWindow: 131072, note: "fast + cheap, separate quota bucket from gpt-oss-120b" },
    { provider: "cerebras", model: "gpt-oss-120b", contextWindow: 131072, note: "extreme speed MoE, ~3000 tok/s — overkill for chat but very fast" },
  ],
  TEXT: [
    // Groq deprecated llama-3.3-70b-versatile (June 2026) — migrated to their
    // recommended replacement, openai/gpt-oss-120b.
    { provider: "groq", model: "openai/gpt-oss-120b", contextWindow: 131072, note: "coding/reasoning, Groq's post-deprecation default" },
    { provider: "cerebras", model: "gpt-oss-120b", contextWindow: 131072, note: "extreme speed MoE, ~3000 tok/s" },
  ],
  TEXT_COMPLEX: [
    // Models chosen specifically for coding/agentic/multi-step strength —
    // Z.ai GLM 5.2 and Poolside Laguna S 2.1 are both purpose-built for
    // project-level software engineering and long-horizon agent workflows
    // (see providers.js freeModels list), not general chat. Cerebras'
    // zai-glm-4.7 stays here too — "complex reasoning and tool use" per its
    // own note, moved up from ADDITIONAL_LIVE_POOL since that's exactly
    // this pool's purpose.
    { provider: "openrouter", model: "z-ai/glm-5.2:free", contextWindow: 1000000, note: "project-level software engineering, long-horizon agent workflows" },
    { provider: "cerebras", model: "zai-glm-4.7", contextWindow: 131072, note: "complex reasoning and tool use" },
    { provider: "openrouter", model: "poolside/laguna-s-2.1:free", contextWindow: 262144, note: "coding agent model, strong on Terminal-Bench/DeepSWE" },
  ],
  TEXT_FALLBACK: [
    { provider: "openrouter", model: "nvidia/nemotron-3-ultra-550b-a55b:free", contextWindow: 1000000, note: "1M context, agent orchestration + coding agents" },
    { provider: "openrouter", model: "minimax/minimax-m3:free", contextWindow: 1000000, note: "1M context, long-horizon agentic work + coding + tool use" },
    { provider: "openrouter", model: "openrouter/free", contextWindow: 131072, note: "auto router fallback" },
  ],
  VISION: [
    // Groq deprecated meta-llama/llama-4-scout-17b-16e-instruct (June 2026) —
    // migrated to their recommended multimodal replacement, qwen/qwen3.6-27b.
    { provider: "groq", model: "qwen/qwen3.6-27b", contextWindow: 131072, note: "multimodal, Groq's post-deprecation vision model (preview)" },
    { provider: "openrouter", model: "google/gemma-4-31b-it:free", contextWindow: 262144, note: "dense multimodal with reasoning" },
    // NOTE: Cloudflare now also has a vision-capable free model
    // (@cf/meta/llama-4-scout-17b-16e-instruct, see providers.js) that would
    // be a genuine extra fallback here — but providers.cloudflare's call()
    // only forwards `messages`/`prompt`, not `imageUrl`/`imageBase64`, so
    // adding it to this pool today would silently drop the image and return
    // a text-only answer. Wire image support into cloudflare.call() first
    // (mirroring injectImageIntoMessages or Gemini's inline_data approach)
    // before listing it here.
  ],
  ADDITIONAL_LIVE_POOL: [
    // One OpenRouter/Cloudflare model here is intentional, not an oversight
    // — both are account-wide scope, so extra models from THOSE two
    // providers wouldn't add headroom, only dead retries. Google AI Studio
    // is per-model scope (see note above the registry), so a second/third
    // Gemini model here WOULD be genuine extra capacity if added later —
    // just one is kept for now since Google's own per-model ceilings aren't
    // publicly numbered anymore and this pool is meant as a light last
    // resort, not a primary pool. Multiple *accounts* (handled by
    // keyManager, not this list) are what buys extra capacity for the
    // account-wide providers.
    { provider: "googleAiStudio", model: "gemini-3.6-flash", contextWindow: 1048576, note: "best balance of quality/speed/context on the free tier" },
    { provider: "cloudflare", model: "@cf/meta/llama-3.3-70b-instruct-fp8-fast", contextWindow: 24000, note: "FP8 fast version, different account pool entirely (renamed from llama-3.3-70b-instruct)" },
  ],
};

// Order in which pools are tried for a plain SIMPLE (chat-level) request.
export const SIMPLE_POOL_ORDER = ["SIMPLE", "TEXT", "TEXT_FALLBACK", "ADDITIONAL_LIVE_POOL"];

// Order for a STANDARD request — the old default behavior, unchanged.
export const TEXT_POOL_ORDER = ["TEXT", "TEXT_FALLBACK", "ADDITIONAL_LIVE_POOL"];

// Order for a request classifyComplexity() flagged as COMPLEX (coding,
// debugging, multi-step reasoning) — tries the coding-focused pool first.
export const COMPLEX_POOL_ORDER = ["TEXT_COMPLEX", "TEXT_FALLBACK", "TEXT", "ADDITIONAL_LIVE_POOL"];

// Order in which pools are tried when the request includes an image.
export const VISION_POOL_ORDER = ["VISION", "ADDITIONAL_LIVE_POOL", "TEXT_FALLBACK"];

/**
 * Picks the right pool order based on whether the request needs vision,
 * how complex it looks (classifyComplexity in tokenTools.js), and whether
 * it needs a big context window (auto-routing).
 */
export function resolvePoolOrder({ hasImage, estimatedTokens, complexity }) {
  if (hasImage) return VISION_POOL_ORDER;

  // A huge prompt always needs the giant-context pool first regardless of
  // complexity classification — no point starting with a 131K-context model
  // on a 150K-token prompt just because the wording looked simple.
  if (estimatedTokens && estimatedTokens > 100000) {
    return ["TEXT_FALLBACK", "TEXT_COMPLEX", "TEXT", "ADDITIONAL_LIVE_POOL"];
  }

  if (complexity === "simple") return SIMPLE_POOL_ORDER;
  if (complexity === "complex") return COMPLEX_POOL_ORDER;
  return TEXT_POOL_ORDER;
}

export function modelsInPool(poolName) {
  return MODEL_REGISTRY[poolName] || [];
}

/**
 * Every (provider, model) pair the gateway actually knows how to call,
 * grouped by provider — for the manual test-page picker and admin dropdowns.
 * Combines two sources since neither alone is complete:
 *  - MODEL_REGISTRY above (the auto-routing pools) — curated, but only
 *    lists the handful of models actually wired into pool-based routing.
 *  - providers.js's own freeModels lists — the full catalog each provider
 *    module knows about (e.g. openrouter lists 15+ free models, only 5 of
 *    which are in a pool), including image/audio/tts/embedding models that
 *    never appear in MODEL_REGISTRY at all since that file is text/vision-only.
 * Takes PROVIDERS as a param (rather than importing providers.js directly)
 * to avoid a circular import — providers.js doesn't need to know about
 * modelRegistry.js, but this function needs both.
 */
export function allModelsByProvider(PROVIDERS) {
  const byProvider = {};

  for (const pool of Object.values(MODEL_REGISTRY)) {
    for (const entry of pool) {
      byProvider[entry.provider] ??= new Set();
      byProvider[entry.provider].add(entry.model);
    }
  }

  for (const [providerName, provider] of Object.entries(PROVIDERS)) {
    const fm = provider.freeModels;
    if (!fm) continue;
    byProvider[providerName] ??= new Set();
    if (Array.isArray(fm)) {
      fm.forEach((m) => byProvider[providerName].add(m));
    } else {
      // Shape like { text: [...], image: [...], audio: [...] } (cloudflare, pollinations)
      Object.values(fm).forEach((list) => list.forEach((m) => byProvider[providerName].add(m)));
    }
  }

  return Object.fromEntries(Object.entries(byProvider).map(([p, set]) => [p, [...set].sort()]));
}
