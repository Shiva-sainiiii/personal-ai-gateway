import { PROVIDERS } from "./providers.js";
import {
  getActiveKeysForProvider,
  decryptKeyDoc,
  markKeySuccess,
  markKeyFailure,
  isRateLimitError,
  logRequest,
} from "./keyManager.js";

// Provider order = fallback order. Tune this list to change priority
// (e.g. put your highest-limit provider first).
const TEXT_PROVIDER_ORDER = ["groq", "cerebras", "googleAiStudio", "openrouter", "cloudflare"];

/**
 * Runs the fallback loop for a text/chat request:
 * for each provider in order -> for each active key on that provider (round-robin)
 * -> try the request. First success wins. Every attempt is logged.
 */
export async function routeTextRequest({ messages, preferredModel }) {
  const attempts = [];

  for (const providerName of TEXT_PROVIDER_ORDER) {
    const provider = PROVIDERS[providerName];
    const keys = await getActiveKeysForProvider(providerName);
    if (keys.length === 0) continue;

    const model = pickModel(provider, preferredModel);

    for (const keyDoc of keys) {
      const started = Date.now();
      try {
        const apiKey = decryptKeyDoc(keyDoc);
        const result = await provider.call({
          apiKey,
          accountId: keyDoc.accountId, // only used by cloudflare
          model,
          messages,
        });
        const latencyMs = Date.now() - started;

        if (result.ok) {
          await markKeySuccess(keyDoc.id);
          await logRequest({
            type: "text",
            provider: providerName,
            keyId: keyDoc.id,
            model,
            ok: true,
            latencyMs,
          });
          return {
            ok: true,
            text: result.text,
            provider: providerName,
            model,
            keyUsed: keyDoc.id,
            attempts: attempts.length + 1,
          };
        }

        const rateLimited = isRateLimitError(result.status);
        await markKeyFailure(keyDoc.id, JSON.stringify(result.error), rateLimited);
        await logRequest({
          type: "text",
          provider: providerName,
          keyId: keyDoc.id,
          model,
          ok: false,
          status: result.status,
          latencyMs,
          errorMessage: JSON.stringify(result.error),
        });
        attempts.push({ provider: providerName, keyId: keyDoc.id, status: result.status });
        // continue to next key / next provider
      } catch (err) {
        const latencyMs = Date.now() - started;
        await markKeyFailure(keyDoc.id, err.message, false);
        await logRequest({
          type: "text",
          provider: providerName,
          keyId: keyDoc.id,
          model,
          ok: false,
          latencyMs,
          errorMessage: err.message,
        });
        attempts.push({ provider: providerName, keyId: keyDoc.id, error: err.message });
      }
    }
  }

  return { ok: false, error: "All providers and keys exhausted.", attempts };
}

export async function routeImageRequest({ prompt }) {
  // Currently only Cloudflare Workers AI serves free image generation in this setup.
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
  // Whisper on Cloudflare Workers AI for transcription.
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

function pickModel(provider, preferredModel) {
  const list = Array.isArray(provider.freeModels) ? provider.freeModels : provider.freeModels.text;
  if (preferredModel && list.includes(preferredModel)) return preferredModel;
  return list[0];
}
