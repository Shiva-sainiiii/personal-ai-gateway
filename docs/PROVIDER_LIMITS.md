# Provider Free-Tier Limits — Verified Aug 2026

Source-of-truth research trail for the numbers hardcoded in `lib/usageLimits.js`,
`lib/providers.js`, and `lib/rateLimitSaver.js`. Collected against each
provider's own official docs/pricing pages (not blogs/Reddit/cached info) —
see `perplexity-research-prompt.md`-style research if you need to re-run this.

**Re-verify this periodically.** Providers change free-tier shape without
notice — this snapshot is Aug 2026, and by the time you're reading it, some
of it may already be stale. Anything marked `"unverified"` below was NOT
independently confirmed against the provider's own docs in this pass —
treat it as a starting guess, not a fact.

## Quota Scope — the concept that matters most for routing

- **account-wide**: one shared quota pool for the whole account, no matter
  which model you call. Exhausting the pool on Model A blocks Model B too.
- **per-model**: each model has its OWN separate quota, same account/key.
  Exhausting Model A's quota leaves Model B (same account) still fresh.
- **mixed**: some models in the provider's catalog share one pool, others
  have their own — must be handled per model-group, not as a single flag.

| Provider | Quota Scope | Notes |
|---|---|---|
| OpenRouter | account-wide | All `:free` models share one bucket per account/key |
| Google AI Studio | per-model | Each Gemini/Gemma model has its own RPM+TPM+RPD bucket |
| Groq | per-model | Each model has its own RPM/RPD/TPM/TPD bucket |
| Cerebras | account-wide | Free-trial credit balance shared across all free models |
| Cloudflare Workers AI | account-wide | 10,000 Neurons/day shared across text/image/audio |

## 1. OpenRouter

- Rate limit shape: RPM + RPD (no published TPM/TPD on the free tier)
- Quota scope: **account-wide**
- Without any lifetime credits ever purchased: **20 RPM, 50 RPD**
- After $10+ lifetime credits have ever been purchased (one-time, not
  recurring): **20 RPM, 1,000 RPD**
- Confirmed free models carry a `:free` suffix; OpenRouter rotates this
  list without notice — re-check `openrouter.ai/models` periodically.
  Snapshot list is in `lib/providers.js`'s `PROVIDERS.openrouter.freeModels`.

## 2. Google AI Studio (Gemini)

- Rate limit shape: **RPM + TPM + RPD** — confirmed NOT an "RPM-only, no
  daily cap" tier for any free model. RPD resets at midnight Pacific time.
- Quota scope: **per-model** — each model has its own bucket on the same
  project/API key.
- As of Aug 2026, Google removed the public per-model RPM/TPM/RPD tables
  from `ai.google.dev/gemini-api/docs/rate-limits`. Exact current numbers
  are only visible per-project inside the AI Studio console itself — there
  is no reliable number to hardcode anymore.
- Free-tier model list is itself **unverified** for Aug 2026 — Google
  rotates this without notice same as everyone else.

## 3. Groq

- Rate limit shape: RPM + RPD + TPM + TPD, all per-model
- Quota scope: **per-model**
- Confirmed numbers (Developer/free plan, Aug 2026):

| Model ID | RPM | RPD | TPM | TPD |
|---|---|---|---|---|
| `openai/gpt-oss-120b` | 30 | 1,000 | 8,000 | 200,000 |
| `openai/gpt-oss-20b` | 30 | 1,000 | 8,000 | 200,000 |
| `llama-3.3-70b-versatile` | 30 | 1,000 | 12,000 | 100,000 |
| `llama-3.1-8b-instant` | 30 | 14,400 | 6,000 | 500,000 |
| `groq/compound` | 30 | 250 | 70,000 | — |
| `groq/compound-mini` | 30 | 250 | 70,000 | — |
| Whisper (audio) | — | ~2,000 audio requests/day | — | — |

Models in the gateway's list without a re-verified number this pass
(`deepseek-r1-distill-llama-70b`, `qwen-2.5-coder-32b`, `mixtral-8x7b-32768`,
`gemma-2-9b-it`, `qwen/qwen3.6-27b`) are marked `unverified: true` in
`PER_MODEL_LIMITS.groq` — check `console.groq.com/docs/rate-limits` directly
before relying on specific numbers for these.

## 4. Cerebras

- **No standing free tier as of Aug 2026.** Signup grants a **$5 free-trial
  credit that expires 30 days after issuance** — not a recurring/permanent
  allowance.
- **A verified payment method is now MANDATORY** to activate API/Playground
  access at all. Without one, the account sits "inactive."
- Rate limit shape (free-trial tier): **5 RPM, 30,000 TPM, 1,000,000
  tokens/hour, 1,000,000 TPD** — account-wide, shared across whichever free
  model you call.
- Confirmed model during the trial: `gpt-oss-120b` (65K context on free
  trial vs 131K on paid).
- Practical implication for this gateway: a Cerebras key that suddenly
  401s/402s is more likely "trial expired" or "payment method never
  verified" than "key revoked" — check the Cerebras dashboard first.

## 5. Cloudflare Workers AI

- Rate limit shape: proprietary **Neurons/day** unit (not RPM/RPD/TPM in
  the usual sense)
- Quota scope: **account-wide** — 10,000 Neurons/day, shared across every
  model type (text/image/audio) on the account
- Resets daily at **00:00 UTC**
- No credit card required for the free tier
- Text model IDs cross-checked this pass: `@cf/meta/llama-3.3-70b-instruct-fp8-fast`,
  `@cf/meta/llama-4-scout-17b-16e-instruct` (vision-capable), `@cf/openai/gpt-oss-120b`,
  `@cf/google/gemma-3-12b-it`. The older `@cf/meta/llama-3.3-70b-instruct` id
  (without the `-fp8-fast` suffix) was NOT independently re-confirmed as
  still live and is kept only as an unverified fallback — check
  `developers.cloudflare.com/workers-ai/models` before assuming either id.

## Known gaps / things intentionally NOT changed this pass

- Cloudflare's vision-capable model (`@cf/meta/llama-4-scout-17b-16e-instruct`)
  is listed in `providers.js` but deliberately **not** added to
  `modelRegistry.js`'s `VISION` pool yet — `providers.cloudflare.call()`
  doesn't forward `imageUrl`/`imageBase64` to the API, so it would silently
  drop the image today. Needs that wiring first.
- Google AI Studio and Groq's free-tier model *lists* (which specific model
  ids are currently live, as opposed to their rate-limit *shape*) were not
  exhaustively re-verified against provider docs this pass — only the shape
  (per-model vs account-wide, RPM+TPM+RPD dimensions) was confirmed with
  high confidence. Treat specific model ids for these two providers as
  carrying the same staleness risk they always have.
