// Central registry: what each provider needs, and how to call it.
// This is where phase-2 "task-based routing" will read model capability tags from.

// Every provider call goes through this instead of raw fetch(). A single slow/
// hung provider request used to be able to eat the entire 30-60s function
// budget, starving the fallback loop of any chance to try other keys/providers.
// 15s balances that against not killing genuinely slow-but-working large
// free-tier models (e.g. 550B-parameter models can take 10s+ to respond).
const PROVIDER_TIMEOUT_MS = 15000;
// Image generation (Pollinations, Cloudflare SDXL) routinely takes longer
// than a text completion — 15s was cutting off otherwise-successful Pollinations
// calls mid-render, which looked identical to a hang from the caller's side.
const IMAGE_TIMEOUT_MS = 45000;

async function fetchWithTimeout(url, options = {}, timeoutMs = PROVIDER_TIMEOUT_MS) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } finally {
    clearTimeout(timeout);
  }
}

export const PROVIDERS = {
  openrouter: {
    name: "openrouter",
    kind: "mixed", // text + vision depending on model (e.g. gemma-4-31b-it supports images)
    baseUrl: "https://openrouter.ai/api/v1/chat/completions",
    freeModels: [
      "nvidia/nemotron-3-ultra-550b-a55b:free",
      "z-ai/glm-5.2:free",
      "minimax/minimax-m3:free",
      "poolside/laguna-s-2.1:free",
      "poolside/laguna-xs-2.1:free",
      "nvidia/nemotron-3-super-120b-a12b:free",
      "cohere/north-mini-code:free",
      "inclusionai/ling-3.0-flash:free",
      "google/gemma-4-31b-it:free",
      "google/gemma-4-26b-a4b-it:free",
      "nvidia/nemotron-3-nano-omni-30b-a3b-reasoning:free",
      "nvidia/nemotron-3-nano-30b-a3b:free",
      "openai/gpt-oss-20b:free",
      "nvidia/nemotron-nano-12b-v2-vl:free",
      "nvidia/nemotron-nano-9b-v2:free",
      "openrouter/free",
    ],
    async call({ apiKey, model, messages, imageUrl }) {
      const finalMessages = imageUrl ? injectImageIntoMessages(messages, imageUrl) : messages;
      const res = await fetchWithTimeout(this.baseUrl, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${apiKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ model, messages: finalMessages }),
      });
      return normalizeOpenAIShape(res, await safeJson(res));
    },
    // Real token-level streaming — OpenRouter is OpenAI-compatible and
    // supports `stream: true`, returning `data: {...}\n\n` SSE chunks with
    // `choices[0].delta.content`. Returns the raw fetch Response so the
    // caller can pipe/parse the body stream directly.
    supportsStreaming: true,
    async callStream({ apiKey, model, messages, imageUrl }) {
      const finalMessages = imageUrl ? injectImageIntoMessages(messages, imageUrl) : messages;
      return fetchWithTimeout(this.baseUrl, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${apiKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ model, messages: finalMessages, stream: true }),
      });
    },
  },

  googleAiStudio: {
    name: "googleAiStudio",
    kind: "mixed", // text + vision (Gemini accepts inline_data image parts)
    baseUrl: "https://generativelanguage.googleapis.com/v1beta/models",
    freeModels: [
      "gemini-3.7-flash",
      "gemini-3.6-flash",
      "gemini-2.5-flash-lite",
      "gemini-2.0-flash",
      "gemma-2-27b-it",
      "gemma-2-9b-it",
      "gemma-3-27b-it",
    ],
    async call({ apiKey, model, messages, imageUrl, imageBase64, imageMimeType }) {
      const url = `${this.baseUrl}/${model}:generateContent?key=${apiKey}`;
      const contents = messages.map((m) => ({
        role: m.role === "assistant" ? "model" : "user",
        parts: [{ text: m.content }],
      }));

      // Attach image (as base64 inline data) to the last content entry, Gemini-style.
      if (imageBase64 && contents.length) {
        contents[contents.length - 1].parts.push({
          inline_data: { mime_type: imageMimeType || "image/jpeg", data: imageBase64 },
        });
      }

      const res = await fetchWithTimeout(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ contents }),
      });
      const json = await safeJson(res);
      if (!res.ok) return { ok: false, status: res.status, error: json };
      const text = json?.candidates?.[0]?.content?.parts?.map((p) => p.text).join("") ?? "";
      const usage = json?.usageMetadata
        ? {
            promptTokens: json.usageMetadata.promptTokenCount ?? 0,
            completionTokens: json.usageMetadata.candidatesTokenCount ?? 0,
            totalTokens: json.usageMetadata.totalTokenCount ?? 0,
          }
        : null;
      return { ok: true, text, raw: json, usage };
    },
    // gemini-2.5-flash-image ("Nano Banana") — free tier, up to 500 images/day
    // per Google's published limits. Uses the same generateContent endpoint
    // as text, but the response comes back as inlineData (base64) instead of text.
    imageModel: "gemini-2.5-flash-image",
    async generateImage({ apiKey, prompt }) {
      const url = `${this.baseUrl}/${this.imageModel}:generateContent?key=${apiKey}`;
      const res = await fetchWithTimeout(
        url,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ contents: [{ parts: [{ text: prompt }] }] }),
        },
        IMAGE_TIMEOUT_MS
      );
      const json = await safeJson(res);
      if (!res.ok) return { ok: false, status: res.status, error: json };

      const parts = json?.candidates?.[0]?.content?.parts || [];
      const imagePart = parts.find((p) => p.inlineData || p.inline_data);
      if (!imagePart) {
        return { ok: false, status: 502, error: { message: "No image data in Gemini response.", raw: json } };
      }
      const inline = imagePart.inlineData || imagePart.inline_data;
      return { ok: true, imageBase64: inline.data, contentType: inline.mimeType || inline.mime_type || "image/png" };
    },
    // Audio transcription piggybacks on the same free-tier text models
    // (gemini-2.5-flash etc.) — no separate paid speech-to-text endpoint
    // needed. Audio is sent as inline base64 data alongside a text prompt.
    async transcribeAudio({ apiKey, model, audioBase64, mimeType }) {
      const url = `${this.baseUrl}/${model}:generateContent?key=${apiKey}`;
      const res = await fetchWithTimeout(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          contents: [
            {
              parts: [
                { text: "Transcribe this audio exactly. Return only the transcript, no commentary." },
                { inline_data: { mime_type: mimeType || "audio/wav", data: audioBase64 } },
              ],
            },
          ],
        }),
      });
      const json = await safeJson(res);
      if (!res.ok) return { ok: false, status: res.status, error: json };
      const text = json?.candidates?.[0]?.content?.parts?.map((p) => p.text).join("") ?? "";
      return { ok: true, text };
    },
  },

  groq: {
    name: "groq",
    kind: "mixed", // text + vision (qwen3.6-27b accepts image_url content blocks)
    baseUrl: "https://api.groq.com/openai/v1/chat/completions",
    // Groq deprecated llama-3.3-70b-versatile, llama-3.1-8b-instant,
    // qwen/qwen3-32b, and meta-llama/llama-4-scout-17b-16e-instruct in June
    // 2026. Replaced here with their officially recommended migrations.
    freeModels: [
      "openai/gpt-oss-120b",
      "openai/gpt-oss-20b",
      "deepseek-r1-distill-llama-70b",
      "qwen-2.5-coder-32b",
      "mixtral-8x7b-32768",
      "gemma-2-9b-it",
      "qwen/qwen3.6-27b",
    ],
    async call({ apiKey, model, messages, imageUrl }) {
      // If an image is attached, fold it into the last user message as an
      // OpenAI-style multimodal content array (Groq's vision models expect this).
      const finalMessages = imageUrl ? injectImageIntoMessages(messages, imageUrl) : messages;
      const res = await fetchWithTimeout(this.baseUrl, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${apiKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ model, messages: finalMessages }),
      });
      return normalizeOpenAIShape(res, await safeJson(res));
    },
    // Groq is also OpenAI-compatible and supports `stream: true`.
    supportsStreaming: true,
    async callStream({ apiKey, model, messages, imageUrl }) {
      const finalMessages = imageUrl ? injectImageIntoMessages(messages, imageUrl) : messages;
      return fetchWithTimeout(this.baseUrl, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${apiKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ model, messages: finalMessages, stream: true }),
      });
    },
  },

  cerebras: {
    name: "cerebras",
    kind: "text",
    baseUrl: "https://api.cerebras.ai/v1/chat/completions",
    freeModels: ["gpt-oss-120b", "gemma-4-31b", "llama-4-scout", "qwen3-32b", "deepseek-r1-distill", "zai-glm-4.7", "qwen-3-235b-a22b-instruct-2507"],
    async call({ apiKey, model, messages }) {
      const res = await fetchWithTimeout(this.baseUrl, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${apiKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ model, messages }),
      });
      return normalizeOpenAIShape(res, await safeJson(res));
    },
    // Cerebras is also OpenAI-compatible and supports `stream: true`.
    supportsStreaming: true,
    async callStream({ apiKey, model, messages }) {
      return fetchWithTimeout(this.baseUrl, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${apiKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ model, messages, stream: true }),
      });
    },
  },

  pollinations: {
    name: "pollinations",
    kind: "image", // dedicated free image-generation provider — Google AI Studio free keys don't get image-gen access, only vision-input
    baseUrl: "https://gen.pollinations.ai/image",
    // Legacy no-key mirror — kept as a last-resort path if the unified gen.
    // endpoint ever rejects a request for a key-related reason.
    legacyBaseUrl: "https://image.pollinations.ai/prompt",
    freeModels: { image: ["flux", "turbo", "flux-realism"] },
    // No API key is strictly required by Pollinations for the legacy endpoint,
    // but a key (sk_/pk_ from enter.pollinations.ai) raises rate limits and
    // removes the watermark, so we treat it like any other provider key —
    // stored/rotated the same way as the other 4 providers.
    async generateImage({ apiKey, prompt, model = "flux" }) {
      const encoded = encodeURIComponent(prompt);
      const params = new URLSearchParams({ model, nologo: "true", safe: "false" });
      if (apiKey) params.set("key", apiKey);

      const url = `${this.baseUrl}/${encoded}?${params.toString()}`;
      const res = await fetchWithTimeout(url, { method: "GET" }, IMAGE_TIMEOUT_MS);

      if (!res.ok) {
        // Try to read a JSON error envelope if present, otherwise fall back to status text.
        const errJson = await safeJson(res);
        return { ok: false, status: res.status, error: errJson || { message: res.statusText } };
      }

      const contentType = res.headers.get("content-type") || "";
      if (!contentType.startsWith("image/")) {
        // Pollinations returns JSON errors with a 200 in some edge cases (e.g. moderation blocks).
        const json = await safeJson(res);
        return { ok: false, status: 502, error: json || { message: "Pollinations did not return image bytes." } };
      }

      const arrayBuffer = await res.arrayBuffer();
      const base64 = Buffer.from(arrayBuffer).toString("base64");
      return { ok: true, imageBase64: base64, contentType: contentType.split(";")[0] };
    },
  },

  cloudflare: {
    name: "cloudflare",
    kind: "mixed", // text + image + audio depending on model
    // Cloudflare needs accountId baked into the URL — stored alongside the key in Firestore.
    baseUrlFor(accountId, model) {
      return `https://api.cloudflare.com/client/v4/accounts/${accountId}/ai/run/${model}`;
    },
    freeModels: {
      text: ["@cf/meta/llama-3.1-8b-instruct", "@cf/meta/llama-3.3-70b-instruct", "@cf/qwen/qwen1.5-14b-chat", "@cf/mistral/mistral-7b-instruct-v0.2"],
      image: ["@cf/stabilityai/stable-diffusion-xl-base-1.0"],
      audio: ["@cf/openai/whisper"],
      tts: ["@cf/myshell-ai/melotts"],
      embedding: ["@cf/baai/bge-large-en-v1.5"],
    },
    async call({ apiKey, accountId, model, messages, prompt }) {
      const url = this.baseUrlFor(accountId, model);
      const isImage = this.freeModels.image.includes(model);
      const body = isImage ? { prompt: prompt || messages?.[messages.length - 1]?.content } : { messages };

      const res = await fetchWithTimeout(
        url,
        {
          method: "POST",
          headers: {
            Authorization: `Bearer ${apiKey}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify(body),
        },
        isImage ? IMAGE_TIMEOUT_MS : PROVIDER_TIMEOUT_MS
      );

      if (isImage) {
        // SDXL on Workers AI returns raw image bytes, not JSON.
        if (!res.ok) return { ok: false, status: res.status, error: await safeJson(res) };
        const arrayBuffer = await res.arrayBuffer();
        const base64 = Buffer.from(arrayBuffer).toString("base64");
        return { ok: true, imageBase64: base64, contentType: res.headers.get("content-type") || "image/png" };
      }

      const json = await safeJson(res);
      if (!res.ok) return { ok: false, status: res.status, error: json };
      const text = json?.result?.response ?? "";
      return { ok: true, text, raw: json };
    },
    // Text-to-speech via MeloTTS. Returns base64-encoded MP3 audio in
    // result.audio (per Cloudflare's documented response shape), unlike the
    // SDXL image endpoint which returns raw bytes directly — worth keeping
    // as its own method rather than overloading `call()`'s isImage branch.
    async generateSpeech({ apiKey, accountId, model, text, lang }) {
      const url = this.baseUrlFor(accountId, model);
      const res = await fetchWithTimeout(
        url,
        {
          method: "POST",
          headers: {
            Authorization: `Bearer ${apiKey}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({ prompt: text, lang: lang || "en" }),
        },
        PROVIDER_TIMEOUT_MS
      );

      const json = await safeJson(res);
      if (!res.ok) return { ok: false, status: res.status, error: json };

      const audioBase64 = json?.result?.audio;
      if (!audioBase64) {
        return { ok: false, status: 502, error: { message: "No audio data in MeloTTS response.", raw: json } };
      }
      return { ok: true, audioBase64, contentType: "audio/mpeg" };
    },
    // Text embeddings via BAAI's bge-large-en-v1.5. Accepts one string or an
    // array of strings, matching Cloudflare's own `text` field shape, and
    // returns one vector per input in the same order.
    async generateEmbedding({ apiKey, accountId, model, input }) {
      const url = this.baseUrlFor(accountId, model);
      const textArray = Array.isArray(input) ? input : [input];
      const res = await fetchWithTimeout(
        url,
        {
          method: "POST",
          headers: {
            Authorization: `Bearer ${apiKey}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({ text: textArray }),
        },
        PROVIDER_TIMEOUT_MS
      );

      const json = await safeJson(res);
      if (!res.ok) return { ok: false, status: res.status, error: json };

      const vectors = json?.result?.data;
      if (!Array.isArray(vectors)) {
        return { ok: false, status: 502, error: { message: "No embedding data in bge response.", raw: json } };
      }
      return { ok: true, embeddings: vectors, shape: json.result.shape || null };
    },
  },
};

async function safeJson(res) {
  try {
    return await res.json();
  } catch {
    return null;
  }
}

function normalizeOpenAIShape(res, json) {
  if (!res.ok) return { ok: false, status: res.status, error: json };
  const text = json?.choices?.[0]?.message?.content ?? "";
  const usage = json?.usage
    ? {
        promptTokens: json.usage.prompt_tokens ?? 0,
        completionTokens: json.usage.completion_tokens ?? 0,
        totalTokens: json.usage.total_tokens ?? (json.usage.prompt_tokens ?? 0) + (json.usage.completion_tokens ?? 0),
      }
    : null;
  return { ok: true, text, raw: json, usage };
}

// Converts the last user message into an OpenAI-style multimodal content
// array with an image_url block appended — used by Groq and OpenRouter.
function injectImageIntoMessages(messages, imageUrl) {
  const copy = messages.map((m) => ({ ...m }));
  const lastUserIdx = [...copy].reverse().findIndex((m) => m.role === "user");
  if (lastUserIdx === -1) return copy;
  const idx = copy.length - 1 - lastUserIdx;
  const original = copy[idx];
  copy[idx] = {
    role: "user",
    content: [
      { type: "text", text: typeof original.content === "string" ? original.content : "" },
      { type: "image_url", image_url: { url: imageUrl } },
    ],
  };
  return copy;
}

// NOTE: a providersForKind(kind) helper used to live here as a "quick lookup:
// given a model kind, which providers can serve it" utility. It was dead
// code — never called anywhere — and would have been misleading if it had
// been used as-is: it matched on `kind === "image" || kind === "mixed"`,
// which would incorrectly include openrouter/groq/googleAiStudio (all
// "mixed") even though none of them implement generateImage(). Image routing
// is correctly hardcoded as an explicit provider list in orchestrator.js's
// IMAGE_PROVIDER_ORDER instead — removed here rather than leaving unused,
// subtly-wrong code around.
