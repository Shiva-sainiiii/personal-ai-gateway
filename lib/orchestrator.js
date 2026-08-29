import { PROVIDERS } from "./providers.js";
import { resolvePoolOrder, modelsInPool } from "./modelRegistry.js";
import {
  getActiveKeysForProvider,
  decryptKeyDoc,
  markKeySuccess,
  markKeyFailure,
  markKeyFailure403,
  isRateLimitError,
  isPermanentError,
  logRequest,
} from "./keyManager.js";
import { recordModelOutcome, rankModelsByScore } from "./modelScorer.js";
import { getCached, setCached } from "./cache.js";
import { claimOrWait } from "./coalescer.js";
import { estimateMessagesTokens, sliceToContextWindow, compressMessages, classifyComplexity } from "./tokenTools.js";
import { filterKeysUnderRateLimit } from "./rateLimitSaver.js";
import { prefetchPoolKeys, getPrefetched } from "./prefetch.js";
import { relayProviderStream } from "./streamTools.js";
import { rankKeysByRemainingQuota, recordUsage } from "./usageLimits.js";

/**
 * Main text/vision routing entrypoint. Runs the full phase-2 pipeline:
 *  1. Compress prompt (strip filler/whitespace)
 *  2. Check smart cache (skip providers entirely on a hit)
 *  3. Coalesce identical concurrent requests
 *  4. Resolve which model pools to try (auto-routing: text vs vision vs huge-context)
 *  5. Within each pool, rank models by self-healing score (best first)
 *  6. For each model, slice messages to fit its context window, then try each
 *     of its provider's keys (fallback loop) until one succeeds
 *  7. Cache the result, update the model's score, log the outcome
 */
export async function routeTextRequest({ messages, preferredModel, imageUrl, imageBase64, imageMimeType }) {
  const hasImage = Boolean(imageUrl || imageBase64);
  const compressed = compressMessages(messages);
  const estimatedTokens = estimateMessagesTokens(compressed);
  // Complexity-based routing: a quick chat message and a "debug this race
  // condition" request shouldn't draw from the same pool in the same order
  // — see tokenTools.js's classifyComplexity and modelRegistry.js's
  // resolvePoolOrder for the actual routing logic.
  const complexity = classifyComplexity(compressed, hasImage);

  const poolOrder = resolvePoolOrder({ hasImage, estimatedTokens, complexity });
  const cacheKey = poolOrder[0]; // cache is keyed off the primary pool for this request shape

  // 1. Cache check (skip cache for image requests — low hit value, and
  //    caching binary image data would bloat Firestore for little benefit).
  if (!hasImage) {
    const cached = await getCached(cacheKey, compressed);
    if (cached) return { ...cached, attempts: 0 };
  }

  // 2. Coalesce duplicate concurrent requests.
  let lock = null;
  if (!hasImage) {
    const coalesce = await claimOrWait(cacheKey, compressed);
    if (!coalesce.claimed) {
      const waited = await coalesce.wait();
      if (waited) return { ...waited, attempts: 0, coalesced: true };
      // Fall through and do the work ourselves if waiting timed out.
    } else {
      lock = coalesce;
    }
  }

  const attempts = [];

  for (const [poolIndex, poolName] of poolOrder.entries()) {
    const pool = modelsInPool(poolName);
    if (pool.length === 0) continue;

    // Speculative prefetch: while we work through this pool, warm up the
    // NEXT pool's key availability in the background in case we fall through to it.
    const nextPoolName = poolOrder[poolIndex + 1];
    if (nextPoolName) {
      const nextProviders = [...new Set(modelsInPool(nextPoolName).map((m) => m.provider))];
      prefetchPoolKeys(nextProviders);
    }

    // Self-healing scorer: try the best-performing model in this pool first.
    const rankedModels = await rankModelsByScore(pool);

    for (const entry of rankedModels) {
      const provider = PROVIDERS[entry.provider];
      if (!provider) continue;

      const modelToUse = preferredModel && pool.some((m) => m.model === preferredModel) ? preferredModel : entry.model;
      // Bug fix: prefetchPoolKeys() was called every loop iteration but its
      // result (getPrefetched) was never read anywhere — getActiveKeysForProvider
      // always did its own fresh Firestore query regardless, so the prefetch
      // was a pure wasted read with zero latency benefit (the entire point of
      // having it). Now: check the prefetch cache first (populated by the
      // PREVIOUS pool's iteration warming up THIS pool's providers), and only
      // fall through to a fresh query on a genuine cache miss (first pool tried,
      // or the prefetch hadn't resolved yet by the time we got here).
      let keys = getPrefetched(entry.provider);
      if (!keys) keys = await getActiveKeysForProvider(entry.provider);
      if (keys.length === 0) continue;
      keys = await filterKeysUnderRateLimit(entry.provider, keys);
      // Provider routing by remaining-quota%: among the keys that passed the
      // rate-limit filter, try whichever has the most daily headroom left
      // first. Spreads load proactively across accounts instead of always
      // hammering the least-recently-used one until it 429s.
      keys = await rankKeysByRemainingQuota(entry.provider, keys);

      // Context window slicer: trim old turns so this specific model can accept the request.
      const slicedMessages = sliceToContextWindow(compressed, entry.contextWindow);

      for (const keyDoc of keys) {
        const started = Date.now();
        try {
          const apiKey = decryptKeyDoc(keyDoc);
          let result = await provider.call({
            apiKey,
            accountId: keyDoc.accountId,
            model: modelToUse,
            messages: slicedMessages,
            imageUrl,
            imageBase64,
            imageMimeType,
          });

          // Token recycler: if the provider rejected the request specifically for
          // being too long, recycle the same key/model with a much tighter slice
          // (half the model's window) before giving up on this key entirely.
          if (!result.ok && isContextLengthError(result.error)) {
            const tighterMessages = sliceToContextWindow(compressed, Math.floor(entry.contextWindow / 2));
            result = await provider.call({
              apiKey,
              accountId: keyDoc.accountId,
              model: modelToUse,
              messages: tighterMessages,
              imageUrl,
              imageBase64,
              imageMimeType,
            });
          }

          const latencyMs = Date.now() - started;

          if (result.ok) {
            // Record against the daily quota tracker: token-metered providers
            // (groq, cerebras) count actual tokens used; request-metered
            // providers (openrouter, googleAiStudio) count 1 per call.
            const isTokenMetered = entry.provider === "groq" || entry.provider === "cerebras";
            const usageAmount = isTokenMetered ? result.usage?.totalTokens || 1 : 1;

            await Promise.all([
              markKeySuccess(keyDoc.id),
              recordModelOutcome({ provider: entry.provider, model: modelToUse, ok: true, latencyMs }),
              logRequest({ type: "text", provider: entry.provider, keyId: keyDoc.id, model: modelToUse, ok: true, latencyMs, usage: result.usage }),
              recordUsage(entry.provider, keyDoc.id, usageAmount),
            ]);

            const response = {
              ok: true,
              text: result.text,
              provider: entry.provider,
              model: modelToUse,
              pool: poolName,
              complexity,
              keyUsed: keyDoc.id,
              attempts: attempts.length + 1,
              usage: result.usage || null,
            };

            if (!hasImage) await setCached(cacheKey, compressed, response);
            if (lock) await lock.release(response);

            return response;
          }

          const rateLimited = isRateLimitError(result.status);
          const permanent = isPermanentError(result.status);
          await Promise.all([
            // 403 gets its own consecutive-count-aware path (see keyManager.js) —
            // a flat "403 = always transient rate limit" used to mean a key that's
            // actually permanently forbidden would cool down and get retried
            // forever instead of ever being disabled.
            result.status === 403
              ? markKeyFailure403(keyDoc.id, JSON.stringify(result.error))
              : markKeyFailure(keyDoc.id, JSON.stringify(result.error), rateLimited, permanent),
            recordModelOutcome({ provider: entry.provider, model: modelToUse, ok: false, latencyMs }),
            logRequest({
              type: "text",
              provider: entry.provider,
              keyId: keyDoc.id,
              model: modelToUse,
              ok: false,
              status: result.status,
              latencyMs,
              errorMessage: JSON.stringify(result.error),
            }),
          ]);
          attempts.push({ pool: poolName, provider: entry.provider, model: modelToUse, keyId: keyDoc.id, status: result.status });
        } catch (err) {
          const latencyMs = Date.now() - started;
          await Promise.all([
            markKeyFailure(keyDoc.id, err.message, false),
            recordModelOutcome({ provider: entry.provider, model: modelToUse, ok: false, latencyMs }),
          ]);
          attempts.push({ pool: poolName, provider: entry.provider, model: modelToUse, keyId: keyDoc.id, error: err.message });
        }
      }
    }
  }

  if (lock) await lock.release({ ok: false, error: "exhausted" });
  return { ok: false, error: "All pools, models, and keys exhausted.", attempts };
}

// Detects provider error responses that indicate "prompt too long for this
// model's context window" across the different error shapes each provider
// uses, so the token recycler knows when a re-slice (not a new key) is the fix.
function isContextLengthError(errorPayload) {
  const text = JSON.stringify(errorPayload || "").toLowerCase();
  return (
    text.includes("context_length") ||
    text.includes("context length") ||
    text.includes("too many tokens") ||
    text.includes("maximum context") ||
    text.includes("token limit")
  );
}

/**
 * Real-streaming version of routeTextRequest. Tries streaming-capable
 * providers (Groq, OpenRouter, Cerebras) first, falling back across keys and
 * pools exactly like the non-streaming path — but ONLY while still at the
 * "connect" stage (HTTP status known, zero bytes relayed yet). Once we start
 * relaying real token chunks to the client, we commit to that stream: there's
 * no way to un-send bytes already flushed to the client, so a mid-stream
 * provider failure ends the stream rather than silently retrying elsewhere.
 *
 * Falls back to the non-streaming routeTextRequest + encodeAsSSE re-chunking
 * ONLY if every streaming-capable attempt fails to even connect (rare — same
 * pools/keys the non-streaming path would have tried anyway).
 *
 * Returns { stream: ReadableStream, meta: {...} } | { ok: false, error, attempts }
 */
export async function routeTextRequestStream({ messages, preferredModel, imageUrl, imageBase64, imageMimeType }) {
  const hasImage = Boolean(imageUrl || imageBase64);
  const compressed = compressMessages(messages);
  const estimatedTokens = estimateMessagesTokens(compressed);
  // Same complexity-based routing as routeTextRequest (see there for why) —
  // this was missed when that was first wired in, which meant streamed
  // requests always got TEXT_POOL_ORDER regardless of how simple or complex
  // the message was, inconsistent with the non-streaming endpoint.
  const complexity = classifyComplexity(compressed, hasImage);
  const poolOrder = resolvePoolOrder({ hasImage, estimatedTokens, complexity });

  const attempts = [];

  for (const [poolIndex, poolName] of poolOrder.entries()) {
    const pool = modelsInPool(poolName);
    if (pool.length === 0) continue;

    const nextPoolName = poolOrder[poolIndex + 1];
    if (nextPoolName) {
      const nextProviders = [...new Set(modelsInPool(nextPoolName).map((m) => m.provider))];
      prefetchPoolKeys(nextProviders);
    }

    const rankedModels = await rankModelsByScore(pool);

    for (const entry of rankedModels) {
      const provider = PROVIDERS[entry.provider];
      if (!provider || !provider.supportsStreaming) continue; // skip non-streaming providers in the streaming path

      const modelToUse = preferredModel && pool.some((m) => m.model === preferredModel) ? preferredModel : entry.model;
      let keys = getPrefetched(entry.provider);
      if (!keys) keys = await getActiveKeysForProvider(entry.provider);
      if (keys.length === 0) continue;
      keys = await filterKeysUnderRateLimit(entry.provider, keys);

      const slicedMessages = sliceToContextWindow(compressed, entry.contextWindow);

      for (const keyDoc of keys) {
        const started = Date.now();
        try {
          const apiKey = decryptKeyDoc(keyDoc);
          const res = await provider.callStream({ apiKey, model: modelToUse, messages: slicedMessages, imageUrl });

          if (!res.ok) {
            // Failed before any bytes were sent to our client — safe to try the next key.
            const errJson = await res.json().catch(() => null);
            const rateLimited = isRateLimitError(res.status);
            const permanent = isPermanentError(res.status);
            await Promise.all([
              res.status === 403
                ? markKeyFailure403(keyDoc.id, JSON.stringify(errJson))
                : markKeyFailure(keyDoc.id, JSON.stringify(errJson), rateLimited, permanent),
              recordModelOutcome({ provider: entry.provider, model: modelToUse, ok: false, latencyMs: Date.now() - started }),
            ]);
            attempts.push({ pool: poolName, provider: entry.provider, model: modelToUse, keyId: keyDoc.id, status: res.status });
            continue;
          }

          // Connected successfully — commit to this stream. Log/score/cache
          // happen in onComplete once the full text has been relayed.
          const meta = { provider: entry.provider, model: modelToUse, pool: poolName, complexity, keyUsed: keyDoc.id, attempts: attempts.length + 1 };
          const stream = relayProviderStream(res, (fullText) => {
            const latencyMs = Date.now() - started;
            markKeySuccess(keyDoc.id).catch(() => {});
            recordModelOutcome({ provider: entry.provider, model: modelToUse, ok: true, latencyMs }).catch(() => {});
            logRequest({ type: "text", provider: entry.provider, keyId: keyDoc.id, model: modelToUse, ok: true, latencyMs }).catch(() => {});
            if (!hasImage && fullText) {
              setCached(poolOrder[0], compressed, { ok: true, text: fullText, provider: entry.provider, model: modelToUse }).catch(() => {});
            }
          });

          return { ok: true, stream, meta };
        } catch (err) {
          // Network-level failure before connecting (DNS, timeout, etc.) — safe to try next key.
          await markKeyFailure(keyDoc.id, err.message, false);
          attempts.push({ pool: poolName, provider: entry.provider, model: modelToUse, keyId: keyDoc.id, error: err.message });
        }
      }
    }
  }

  return { ok: false, error: "All streaming-capable pools, models, and keys failed to connect.", attempts };
}

// Image providers in priority order.
//
// Pollinations is primary: it's a dedicated free image-generation API (no
// Google-account vision-only restriction applies), works with or without a
// key, and a key just raises the rate limit / drops the watermark.
//
// Cloudflare Workers AI (Stable Diffusion XL) is the fallback.
//
// googleAiStudio is intentionally NOT in this pool. Its gemini-2.5-flash-image
// ("Nano Banana") model was tried as a secondary attempt, but real usage
// confirmed Google's free tier grants a hard 0 quota for image generation
// (generate_content_free_tier_requests limit: 0) on every account tested —
// so it only ever adds a guaranteed-failed attempt and wasted latency here.
// Google AI Studio is still used for image VISION (image input -> text) via
// the /api/v1/chat pipeline, where free tier access is real.
const IMAGE_PROVIDER_ORDER = ["pollinations", "cloudflare"];

export async function routeImageRequest({ prompt }) {
  const attempts = [];

  for (const providerName of IMAGE_PROVIDER_ORDER) {
    const provider = PROVIDERS[providerName];

    // Pollinations works even with zero stored keys (no-key mode), so give
    // it one no-key attempt instead of skipping the provider outright.
    let keys = await getActiveKeysForProvider(providerName);
    if (keys.length === 0 && providerName === "pollinations") {
      keys = [{ id: "pollinations_nokey", encryptedKey: null, noKey: true }];
    }
    if (keys.length === 0) continue;

    const model = provider.freeModels.image[0];

    for (const keyDoc of keys) {
      const started = Date.now();
      try {
        const apiKey = keyDoc.noKey ? null : decryptKeyDoc(keyDoc);
        const result =
          providerName === "pollinations"
            ? await provider.generateImage({ apiKey, prompt, model })
            : await provider.call({ apiKey, accountId: keyDoc.accountId, model, prompt });
        const latencyMs = Date.now() - started;

        if (result.ok) {
          if (!keyDoc.noKey) await markKeySuccess(keyDoc.id);
          await logRequest({ type: "image", provider: providerName, keyId: keyDoc.id, model, ok: true, latencyMs });
          // Cloudflare meters in Neurons rather than tokens/requests; the API
          // doesn't return an exact neuron count per call, so this uses a
          // conservative published estimate for SDXL image generation
          // (~50 neurons/image) to keep the quota tracker roughly honest
          // rather than leaving Cloudflare's usage untracked entirely.
          if (providerName === "cloudflare" && !keyDoc.noKey) await recordUsage("cloudflare", keyDoc.id, 50);
          return { ok: true, imageBase64: result.imageBase64, contentType: result.contentType, provider: providerName, keyUsed: keyDoc.id };
        }

        const rateLimited = isRateLimitError(result.status);
        const permanent = isPermanentError(result.status);
        if (!keyDoc.noKey) {
          await (result.status === 403
            ? markKeyFailure403(keyDoc.id, JSON.stringify(result.error))
            : markKeyFailure(keyDoc.id, JSON.stringify(result.error), rateLimited, permanent));
        }
        await logRequest({
          type: "image",
          provider: providerName,
          keyId: keyDoc.id,
          model,
          ok: false,
          status: result.status,
          latencyMs,
          errorMessage: JSON.stringify(result.error),
        });
        attempts.push({ provider: providerName, keyId: keyDoc.id, status: result.status });
      } catch (err) {
        if (!keyDoc.noKey) await markKeyFailure(keyDoc.id, err.message, false);
        attempts.push({ provider: providerName, keyId: keyDoc.id, error: err.message });
      }
    }
  }

  return { ok: false, error: "All image keys exhausted.", attempts };
}

// Cloudflare Workers AI Whisper is a dedicated, purpose-built speech-to-text
// model — it's tried FIRST because it reliably accepts raw audio bytes
// regardless of account tier.
//
// Google AI Studio's chat models (gemini-2.5-flash etc.) CAN transcribe audio
// via inline_data in principle, but free-tier Google AI Studio keys are
// frequently vision-only (image input) and reject audio inline_data with a
// 400/403 — the same restriction that broke image generation. It's kept as
// a second attempt since it costs nothing to try, but is no longer assumed
// to be the reliable path.
const AUDIO_PROVIDER_ORDER = ["cloudflare", "googleAiStudio"];

export async function routeAudioRequest({ audioBuffer, contentType }) {
  const attempts = [];
  const audioBase64 = audioBuffer.toString("base64");

  for (const providerName of AUDIO_PROVIDER_ORDER) {
    const provider = PROVIDERS[providerName];
    const keys = await getActiveKeysForProvider(providerName);
    if (keys.length === 0) continue;

    const model = providerName === "googleAiStudio" ? "gemini-2.5-flash" : provider.freeModels.audio[0];

    for (const keyDoc of keys) {
      const started = Date.now();
      try {
        const apiKey = decryptKeyDoc(keyDoc);

        if (providerName === "googleAiStudio") {
          const result = await provider.transcribeAudio({ apiKey, model, audioBase64, mimeType: contentType });
          const latencyMs = Date.now() - started;

          if (result.ok) {
            await markKeySuccess(keyDoc.id);
            await logRequest({ type: "audio", provider: providerName, keyId: keyDoc.id, model, ok: true, latencyMs });
            return { ok: true, text: result.text, provider: providerName, keyUsed: keyDoc.id };
          }

          const rateLimited = isRateLimitError(result.status);
          const permanent = isPermanentError(result.status);
          await (result.status === 403
            ? markKeyFailure403(keyDoc.id, JSON.stringify(result.error))
            : markKeyFailure(keyDoc.id, JSON.stringify(result.error), rateLimited, permanent));
          await logRequest({
            type: "audio",
            provider: providerName,
            keyId: keyDoc.id,
            model,
            ok: false,
            status: result.status,
            latencyMs,
            errorMessage: JSON.stringify(result.error),
          });
          attempts.push({ provider: providerName, keyId: keyDoc.id, status: result.status });
          continue;
        }

        // Cloudflare Whisper path (raw bytes, not base64/JSON).
        const url = provider.baseUrlFor(keyDoc.accountId, model);
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), 15000);
        let res;
        try {
          res = await fetch(url, {
            method: "POST",
            headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": contentType || "application/octet-stream" },
            body: audioBuffer,
            signal: controller.signal,
          });
        } finally {
          clearTimeout(timeoutId);
        }
        const json = await res.json().catch(() => null);
        const latencyMs = Date.now() - started;

        if (res.ok) {
          await markKeySuccess(keyDoc.id);
          await logRequest({ type: "audio", provider: providerName, keyId: keyDoc.id, model, ok: true, latencyMs });
          // Whisper transcription neuron cost scales with audio length, which
          // isn't returned by the API — a flat conservative estimate (~30
          // neurons/request for typical short clips) keeps this provider's
          // quota tracked rather than invisible to the router entirely.
          await recordUsage("cloudflare", keyDoc.id, 30);
          return { ok: true, text: json?.result?.text ?? "", provider: providerName, keyUsed: keyDoc.id };
        }

        const rateLimited = isRateLimitError(res.status);
        const permanent = isPermanentError(res.status);
        await (res.status === 403
          ? markKeyFailure403(keyDoc.id, JSON.stringify(json))
          : markKeyFailure(keyDoc.id, JSON.stringify(json), rateLimited, permanent));
        await logRequest({
          type: "audio",
          provider: providerName,
          keyId: keyDoc.id,
          model,
          ok: false,
          status: res.status,
          latencyMs,
          errorMessage: JSON.stringify(json),
        });
        attempts.push({ provider: providerName, keyId: keyDoc.id, status: res.status });
      } catch (err) {
        await markKeyFailure(keyDoc.id, err.message, false);
        attempts.push({ provider: providerName, keyId: keyDoc.id, error: err.message });
      }
    }
  }

  return { ok: false, error: "All audio keys exhausted.", attempts };
}

/**
 * Text-to-speech via Cloudflare's MeloTTS. Only one free-tier provider in
 * this gateway offers TTS today, so there's no cross-provider fallback pool
 * here (unlike text/image/audio-transcription) — just fallback across the
 * Cloudflare accounts' keys.
 */
export async function routeSpeechRequest({ text, lang }) {
  const provider = PROVIDERS.cloudflare;
  const keys = await getActiveKeysForProvider("cloudflare");
  const model = provider.freeModels.tts[0];
  const attempts = [];

  for (const keyDoc of keys) {
    const started = Date.now();
    try {
      const apiKey = decryptKeyDoc(keyDoc);
      const result = await provider.generateSpeech({ apiKey, accountId: keyDoc.accountId, model, text, lang });
      const latencyMs = Date.now() - started;

      if (result.ok) {
        await markKeySuccess(keyDoc.id);
        await logRequest({ type: "speech", provider: "cloudflare", keyId: keyDoc.id, model, ok: true, latencyMs });
        // MeloTTS neuron cost scales with output audio length, similar to
        // Whisper — not returned per-call, so a flat conservative estimate
        // keeps it tracked in the quota system rather than invisible.
        await recordUsage("cloudflare", keyDoc.id, 20);
        return { ok: true, audioBase64: result.audioBase64, contentType: result.contentType, keyUsed: keyDoc.id };
      }

      const rateLimited = isRateLimitError(result.status);
      const permanent = isPermanentError(result.status);
      await markKeyFailure(keyDoc.id, JSON.stringify(result.error), rateLimited, permanent);
      await logRequest({
        type: "speech",
        provider: "cloudflare",
        keyId: keyDoc.id,
        model,
        ok: false,
        status: result.status,
        latencyMs,
      });
      attempts.push({ provider: "cloudflare", keyId: keyDoc.id, status: result.status });
    } catch (err) {
      await markKeyFailure(keyDoc.id, err.message, false);
      attempts.push({ provider: "cloudflare", keyId: keyDoc.id, error: err.message });
    }
  }

  return { ok: false, error: "All speech (TTS) keys exhausted.", attempts };
}

/**
 * Embeddings via Cloudflare's bge-large-en-v1.5. Same single-provider
 * fallback shape as TTS — no cross-provider pool since this is the only
 * free embedding model wired into the gateway today.
 */
export async function routeEmbeddingRequest({ input }) {
  const provider = PROVIDERS.cloudflare;
  const keys = await getActiveKeysForProvider("cloudflare");
  const model = provider.freeModels.embedding[0];
  const attempts = [];

  for (const keyDoc of keys) {
    const started = Date.now();
    try {
      const apiKey = decryptKeyDoc(keyDoc);
      const result = await provider.generateEmbedding({ apiKey, accountId: keyDoc.accountId, model, input });
      const latencyMs = Date.now() - started;

      if (result.ok) {
        await markKeySuccess(keyDoc.id);
        await logRequest({ type: "embedding", provider: "cloudflare", keyId: keyDoc.id, model, ok: true, latencyMs });
        // bge embedding neuron cost is small and roughly per-input; a flat
        // estimate per call keeps it tracked without needing an exact figure
        // Cloudflare doesn't return per-request anyway.
        await recordUsage("cloudflare", keyDoc.id, 5);
        return { ok: true, embeddings: result.embeddings, shape: result.shape, keyUsed: keyDoc.id };
      }

      const rateLimited = isRateLimitError(result.status);
      const permanent = isPermanentError(result.status);
      await markKeyFailure(keyDoc.id, JSON.stringify(result.error), rateLimited, permanent);
      await logRequest({
        type: "embedding",
        provider: "cloudflare",
        keyId: keyDoc.id,
        model,
        ok: false,
        status: result.status,
        latencyMs,
      });
      attempts.push({ provider: "cloudflare", keyId: keyDoc.id, status: result.status });
    } catch (err) {
      await markKeyFailure(keyDoc.id, err.message, false);
      attempts.push({ provider: "cloudflare", keyId: keyDoc.id, error: err.message });
    }
  }

  return { ok: false, error: "All embedding keys exhausted.", attempts };
}
