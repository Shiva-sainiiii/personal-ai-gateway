import { PROVIDERS } from "./providers.js";
import { resolvePoolOrder, modelsInPool } from "./modelRegistry.js";
import {
  getActiveKeysForProvider,
  decryptKeyDoc,
  markKeySuccess,
  markKeyFailure,
  isRateLimitError,
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
          await Promise.all([
            markKeyFailure(keyDoc.id, JSON.stringify(result.error), rateLimited),
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

export async function routeImageRequest({ prompt }) {
  const provider = PROVIDERS.cloudflare;
  const keys = await getActiveKeysForProvider("cloudflare");
  const model = provider.freeModels.image[0];
  const attempts = [];

  for (const keyDoc of keys) {
    const started = Date.now();
    try {
      const apiKey = decryptKeyDoc(keyDoc);
      const result = await provider.call({ apiKey, accountId: keyDoc.accountId, model, prompt });
      const latencyMs = Date.now() - started;

      if (result.ok) {
        await markKeySuccess(keyDoc.id);
        await logRequest({ type: "image", provider: "cloudflare", keyId: keyDoc.id, model, ok: true, latencyMs });
        return { ok: true, imageBase64: result.imageBase64, contentType: result.contentType, keyUsed: keyDoc.id };
      }

      const rateLimited = isRateLimitError(result.status);
      await markKeyFailure(keyDoc.id, JSON.stringify(result.error), rateLimited);
      await logRequest({
        type: "image",
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

  return { ok: false, error: "All image keys exhausted.", attempts };
}

export async function routeAudioRequest({ audioBuffer, contentType }) {
  const provider = PROVIDERS.cloudflare;
  const keys = await getActiveKeysForProvider("cloudflare");
  const model = provider.freeModels.audio[0];
  const attempts = [];

  for (const keyDoc of keys) {
    const started = Date.now();
    try {
      const apiKey = decryptKeyDoc(keyDoc);
      const url = provider.baseUrlFor(keyDoc.accountId, model);
      const res = await fetch(url, {
        method: "POST",
        headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": contentType || "application/octet-stream" },
        body: audioBuffer,
      });
      const json = await res.json().catch(() => null);
      const latencyMs = Date.now() - started;

      if (res.ok) {
        await markKeySuccess(keyDoc.id);
        await logRequest({ type: "audio", provider: "cloudflare", keyId: keyDoc.id, model, ok: true, latencyMs });
        return { ok: true, text: json?.result?.text ?? "", keyUsed: keyDoc.id };
      }

      const rateLimited = isRateLimitError(res.status);
      await markKeyFailure(keyDoc.id, JSON.stringify(json), rateLimited);
      await logRequest({
        type: "audio",
        provider: "cloudflare",
        keyId: keyDoc.id,
        model,
        ok: false,
        status: res.status,
        latencyMs,
      });
      attempts.push({ provider: "cloudflare", keyId: keyDoc.id, status: res.status });
    } catch (err) {
      await markKeyFailure(keyDoc.id, err.message, false);
      attempts.push({ provider: "cloudflare", keyId: keyDoc.id, error: err.message });
    }
  }

  return { ok: false, error: "All audio keys exhausted.", attempts };
}
