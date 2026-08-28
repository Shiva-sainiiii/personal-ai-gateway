// Published free-tier daily limits, per account/key, as of Aug 2026.
// Sources checked against each provider's own docs/pricing pages.
//
// unit: "tokens" | "requests" | "neurons" — Cloudflare doesn't meter in
// tokens, it uses its own normalized "Neuron" compute unit, so it's kept
// separate rather than forced into a token comparison that wouldn't be
// accurate.
//
// These are PER-ACCOUNT numbers. The gateway's actual effective daily
// capacity for a provider = this number × how many active accounts/keys
// you have for that provider (since each account gets its own bucket).
export const DAILY_FREE_LIMITS = {
  groq: { unit: "tokens", amount: 500000, note: "~500K TPD typical on free-tier text models (varies by model, some up to ~1M)" },
  cerebras: { unit: "tokens", amount: 1000000, note: "1M tokens/day, flat across free-tier models" },
  openrouter: { unit: "requests", amount: 50, note: "50 requests/day per account on :free models (1000/day if $10+ credits ever purchased)" },
  googleAiStudio: { unit: "requests", amount: 1500, note: "~1500 requests/day typical on Gemini Flash-tier free models" },
  cloudflare: { unit: "neurons", amount: 10000, note: "10,000 Neurons/day, shared across all model types (text/image/audio)" },
  pollinations: { unit: "requests", amount: null, note: "no published daily cap — billed per-request in \"pollen\" balance instead" },
};
