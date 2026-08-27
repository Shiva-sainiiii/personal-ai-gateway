import { PROVIDERS } from "./providers.js";
import { resolvePoolOrder, modelsInPool } from "./modelRegistry.js";
import {
  getActiveKeysForProvider,
  decryptKeyDoc,
  markKeySuccess,
  markKeyFailure,
  isRateLimitError,
  isPermanentError,
  logRequest,
} from "./keyManager.js";
import { recordModelOutcome, rankModelsByScore } from "./modelScorer.js";
import { getCached, setCached } from "./cache.js";
import { claimOrWait } from "./coalescer.js";
import { estimateMessagesTokens, sliceToContextWindow, compressMessages } from "./tokenTools.js";
import { filterKeysUnderRateLimit } from "./rateLimitSaver.js";
import { prefetchPoolKeys } from "./prefetch.js";

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

  const poolOrder = resolvePoolOrder({ hasImage, estimatedTokens });
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
      let keys = await getActiveKeysForProvider(entry.provider);
      if (keys.length === 0) continue;
      keys = await filterKeysUnderRateLimit(entry.provider, keys);

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
            await Promise.all([
              markKeySuccess(keyDoc.id),
              recordModelOutcome({ provider: entry.provider, model: modelToUse, ok: true, latencyMs }),
              logRequest({ type: "text", provider: entry.provider, keyId: keyDoc.id, model: modelToUse, ok: true, latencyMs }),
            ]);

            const response = {
              ok: true,
              text: result.text,
              provider: entry.provider,
              model: modelToUse,
              pool: poolName,
              keyUsed: keyDoc.id,
              attempts: attempts.length + 1,
            };

            if (!hasImage) await setCached(cacheKey, compressed, response);
            if (lock) await lock.release(response);

            return response;
          }

          const rateLimited = isRateLimitError(result.status);
          const permanent = isPermanentError(result.status);
          await Promise.all([
            markKeyFailure(keyDoc.id, JSON.stringify(result.error), rateLimited, permanent),
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

// Image providers in priority order. Google AI Studio's gemini-2.5-flash-image
// ("Nano Banana") gives ~500 free images/day PER ACCOUNT — with 4 accounts
// that's up to ~2000/day, far more than Cloudflare's free Workers AI quota.
// Cloudflare is kept as a fallback for when Google's daily quota is exhausted.
const IMAGE_PROVIDER_ORDER = ["googleAiStudio", "cloudflare"];

export async function routeImageRequest({ prompt }) {
  const attempts = [];

  for (const providerName of IMAGE_PROVIDER_ORDER) {
    const provider = PROVIDERS[providerName];
    const keys = await getActiveKeysForProvider(providerName);
    if (keys.length === 0) continue;

    const model = providerName === "googleAiStudio" ? provider.imageModel : provider.freeModels.image[0];

    for (const keyDoc of keys) {
      const started = Date.now();
      try {
        const apiKey = decryptKeyDoc(keyDoc);
        const result =
          providerName === "googleAiStudio"
            ? await provider.generateImage({ apiKey, prompt })
            : await provider.call({ apiKey, accountId: keyDoc.accountId, model, prompt });
        const latencyMs = Date.now() - started;

        if (result.ok) {
          await markKeySuccess(keyDoc.id);
          await logRequest({ type: "image", provider: providerName, keyId: keyDoc.id, model, ok: true, latencyMs });
          return { ok: true, imageBase64: result.imageBase64, contentType: result.contentType, provider: providerName, keyUsed: keyDoc.id };
        }

        const rateLimited = isRateLimitError(result.status);
        const permanent = isPermanentError(result.status);
        await markKeyFailure(keyDoc.id, JSON.stringify(result.error), rateLimited, permanent);
        await logRequest({
          type: "image",
          provider: providerName,
          keyId: keyDoc.id,
          model,
          ok: false,
          status: result.status,
          latencyMs,
        });
        attempts.push({ provider: providerName, keyId: keyDoc.id, status: result.status });
      } catch (err) {
        await markKeyFailure(keyDoc.id, err.message, false);
        attempts.push({ provider: providerName, keyId: keyDoc.id, error: err.message });
      }
    }
  }

  return { ok: false, error: "All image keys exhausted.", attempts };
}

// Google AI Studio's existing free-tier chat models (gemini-2.5-flash etc.)
// can transcribe audio directly via inline data — no separate speech API or
// quota needed, so it's tried first; Cloudflare Whisper is the fallback.
const AUDIO_PROVIDER_ORDER = ["googleAiStudio", "cloudflare"];

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
          await markKeyFailure(keyDoc.id, JSON.stringify(result.error), rateLimited, permanent);
          await logRequest({
            type: "audio",
            provider: providerName,
            keyId: keyDoc.id,
            model,
            ok: false,
            status: result.status,
            latencyMs,
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
          return { ok: true, text: json?.result?.text ?? "", provider: providerName, keyUsed: keyDoc.id };
        }

        const rateLimited = isRateLimitError(res.status);
        const permanent = isPermanentError(res.status);
        await markKeyFailure(keyDoc.id, JSON.stringify(json), rateLimited, permanent);
        await logRequest({
          type: "audio",
          provider: providerName,
          keyId: keyDoc.id,
          model,
          ok: false,
          status: res.status,
          latencyMs,
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
