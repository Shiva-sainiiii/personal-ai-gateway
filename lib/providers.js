// Central registry: what each provider needs, and how to call it.
// This is where phase-2 "task-based routing" will read model capability tags from.

// Every provider call goes through this instead of raw fetch(). A single slow/
// hung provider request used to be able to eat the entire 30-60s function
// budget, starving the fallback loop of any chance to try other keys/providers.
// 15s balances that against not killing genuinely slow-but-working large
// free-tier models (e.g. 550B-parameter models can take 10s+ to respond).
const PROVIDER_TIMEOUT_MS = 15000;

async function fetchWithTimeout(url, options = {}) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), PROVIDER_TIMEOUT_MS);
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
      "inclusionai/ling-3.0-flash:free",
      "nvidia/nemotron-3-super-120b-a12b:free",
      "poolside/laguna-s-2.1:free",
      "poolside/laguna-xs-2.1:free",
      "google/gemma-4-26b-a4b-it:free",
      "google/gemma-4-31b-it:free",
      "cohere/north-mini-code:free",
      "nvidia/nemotron-3-nano-30b-a3b:free",
      "nvidia/nemotron-3-nano-omni-30b-a3b-reasoning:free",
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
  },

  googleAiStudio: {
    name: "googleAiStudio",
    kind: "mixed", // text + vision (Gemini accepts inline_data image parts)
    baseUrl: "https://generativelanguage.googleapis.com/v1beta/models",
    freeModels: [
      "gemini-3.7-flash",
      "gemini-3.6-flash",
      "gemini-2.5-flash",
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
      return { ok: true, text, raw: json };
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
      embedding: ["@cf/baai/bge-large-en-v1.5"],
    },
    async call({ apiKey, accountId, model, messages, prompt }) {
      const url = this.baseUrlFor(accountId, model);
      const isImage = this.freeModels.image.includes(model);
      const body = isImage ? { prompt: prompt || messages?.[messages.length - 1]?.content } : { messages };

      const res = await fetchWithTimeout(url, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${apiKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(body),
      });

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
  return { ok: true, text, raw: json };
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

// Quick lookup: given a model kind, which providers can serve it.
export function providersForKind(kind) {
  return Object.values(PROVIDERS).filter((p) => p.kind === kind || p.kind === "mixed");
}
