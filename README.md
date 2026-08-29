# Personal AI Gateway

Ek gateway jo 25 free API keys (5 providers x 4 Google accounts) ko manage karta hai
aur 3 master keys (Text/Image/Audio) expose karta hai tere baaki projects ke liye.

## Architecture

```
Tera Project --Bearer MASTER_KEY_TEXT--> /api/v1/chat
                                              |
                                        fallback loop:
                                  groq -> cerebras -> googleAiStudio -> openrouter -> cloudflare
                                    (har provider ke andar 4 keys round-robin)
                                              |
                                        Firestore (apiKeys, requestLogs, masterKeys)
```

- **Provider keys**: AES-256-GCM encrypted, Firestore me `apiKeys` collection, 1 doc per key (25 docs)
- **Master keys**: sirf SHA-256 hash Firestore me (`masterKeys` collection), plaintext kabhi store nahi hota
- **Logs**: har request `requestLogs` collection me permanently log hoti hai (provider, key, success/fail, latency)
- **Firestore rules**: sab client access block — sirf tera server (Admin SDK) padh/likh sakta hai, isliye public firebaseConfig leak ho bhi jaye to koi Firestore access nahi kar sakta

## Step 1 — Firebase Setup

1. Firebase Console me apna existing project kholo (`personal-ai-gateway-5d937`)
2. **Firestore Database** enable karo (agar already nahi hai) — production mode me
3. **Project Settings → Service Accounts → Generate new private key** — ek JSON file download hogi. Isme se `project_id`, `client_email`, `private_key` chahiye honge `.env` ke liye
4. **Firestore → Rules** tab me jaake `firestore.rules` file ka content paste karo aur Publish karo (ye zaroori hai — isके bina tera data kisi ko bhi accessible ho sakta hai agar wo firebaseConfig dekh le)

⚠️ **Important**: Tune jo Firebase web config (apiKey, authDomain, etc.) pehle share kiya tha, wo "public" config hota hai — lekin uski security Firestore Rules par depend karti hai. Rules publish karna mat bhoolna.

### Composite Indexes (zaroori — pehli deploy pe error dega warna)

Ye gateway kai jagah compound Firestore queries use karta hai jinko ek **composite index** chahiye hota hai (Firestore single-field indexes automatically bana deta hai, compound wale nahi). Pehli baar jab in queries me se koi bhi chalegi (chahe API call se ho ya admin panel se), Firestore ek error dega jisme **seedha ek link** hoga jo one-click index create kar deta hai — bas wo link click karo, "Create Index" dabao, 1-2 min wait karo, phir dobara try karo.

Queries jinko index chahiye honge:
- `apiKeys`: `provider ==` + `status in [...]` (har request pe — `getActiveKeysForProvider`)
- `requestLogs`: `createdAt >=` alone (admin stats dashboard ke liye — auto-index ho sakta hai)
- `requestLogs`: `keyId in [...]` + `createdAt >=` (naya — rate-limit-saver ke liye, Groq/OpenRouter par)
- `modelScores`: `orderBy("score", "desc")` (admin stats — auto-index)

Agar chaho to sab pehle se create kar sakte ho `firebase deploy --only firestore:indexes` se (agar Firebase CLI use kar rahe ho) — lekin normally error-link se click-through karna hi sabse aasan raasta hai, koi CLI setup ki zaroorat nahi.

## Step 2 — Generate Secrets

Apne local machine ya any terminal me (Node.js chahiye):

```bash
# Encryption key for API keys at rest
openssl rand -hex 32

# Master keys (run 3 baar, ek Text ke liye, ek Image, ek Audio)
openssl rand -hex 24
```

Ye values safe jagah save kar lo — Vercel env vars me daalni hongi.

## Step 3 — GitHub Upload

1. Is zip ko extract karo
2. Naya GitHub repo banao (private rakhna better hai)
3. Files upload karo (ya `git init && git add . && git commit -m "init" && git push`)
4. `.env` file kabhi upload mat karna — `.gitignore` already isko exclude karta hai

## Step 4 — Vercel Deploy

1. Vercel dashboard → **Add New → Project → Import** apna GitHub repo
2. Framework preset: Next.js (auto-detect ho jayega)
3. **Environment Variables** section me ye sab add karo (Step 2 aur Firebase se):
   - `FIREBASE_PROJECT_ID`
   - `FIREBASE_CLIENT_EMAIL`
   - `FIREBASE_PRIVATE_KEY` (poora multi-line key paste karo, quotes ke saath)
   - `ENCRYPTION_KEY`
   - `MASTER_KEY_TEXT`, `MASTER_KEY_IMAGE`, `MASTER_KEY_AUDIO`
   - `ADMIN_PASSWORD` (admin panel access ke liye)
4. **Deploy** click karo

## Step 5 — Master Keys Firestore Me Seed Karo

Deploy hone ke baad master keys ke hash Firestore me daalne hain. Do tarike hain:

**Option A (recommended, easy)**: Local machine par:
```bash
npm install
cp .env.example .env
# .env me apne values fill karo (Firebase creds, encryption key, master keys)
npm run seed
```
Ye script master key hashes Firestore me daal dega. Chahe to isi script se apni 25 provider keys bhi bulk-seed kar sakta hai (`.env` me `OPENROUTER_ACC1_KEY` jaise fields fill karke).

**Option B**: Provider keys ko frontend admin panel se ek-ek karke add karo (Step 6 dekh).

## Step 6 — Admin Panel Se Keys Add Karo

1. `https://your-app.vercel.app/admin` kholo
2. `ADMIN_PASSWORD` daal ke login karo
3. Har ek key ke liye: provider select karo, accountLabel (`acc1`–`acc4`), apna API key paste karo, aur agar Cloudflare hai to Account ID bhi daalo
4. "Add Key" — key encrypt hoke Firestore me chali jayegi

Yahi panel se tu live stats bhi dekh sakta hai: kaunsi key active hai, kaunsi cooldown me hai, kitne success/fail hue.

## Step 7 — Apne Doosre Projects Se Call Karo

```javascript
// Text
const res = await fetch("https://your-app.vercel.app/api/v1/chat", {
  method: "POST",
  headers: {
    "Authorization": "Bearer YOUR_MASTER_KEY_TEXT",
    "Content-Type": "application/json"
  },
  body: JSON.stringify({
    messages: [{ role: "user", content: "Hello!" }]
  })
});
const data = await res.json();
console.log(data.text, data.provider, data.model);
```

```javascript
// Image
const res = await fetch("https://your-app.vercel.app/api/v1/image", {
  method: "POST",
  headers: {
    "Authorization": "Bearer YOUR_MASTER_KEY_IMAGE",
    "Content-Type": "application/json"
  },
  body: JSON.stringify({ prompt: "a cat riding a bike" })
});
const { imageBase64 } = await res.json();
```

```javascript
// Audio (send raw audio bytes)
const res = await fetch("https://your-app.vercel.app/api/v1/audio", {
  method: "POST",
  headers: {
    "Authorization": "Bearer YOUR_MASTER_KEY_AUDIO",
    "Content-Type": "audio/mpeg"
  },
  body: audioFileBuffer
});
const { text } = await res.json();
```

## Image aur Audio Routing (Update 2)

**Bug jo fix hua**: `gemini-2.5-flash-image` ("Nano Banana") aur raw audio inline-data dono ko
Google AI Studio ke **free-tier keys support nahi karte** — free tier sirf VISION (image ko
*samajhna*) deta hai, image *banana* ya raw audio *transcribe karna* nahi. Isliye pehle image
aur audio dono consistently fail ho rahe the — koi bug nahi tha, ye ek provider-tier limitation
thi jiske against galat model assume kiya gaya tha.

**Naya routing:**

- **Image**: `pollinations` (primary) → `googleAiStudio` (secondary, agar kabhi entitled ho) → `cloudflare` (fallback).
  Pollinations ek dedicated free image-gen API hai (`gen.pollinations.ai/image/{prompt}`), bina
  key ke bhi kaam karta hai — key dene se sirf rate limit badhta hai aur watermark hatta hai.
- **Audio**: `cloudflare` Whisper (primary, purpose-built STT model) → `googleAiStudio` (secondary attempt, agar account allow kare).

Cloudflare ab audio ke liye recommended hai (Whisper reliable STT hai), image ke liye still optional
fallback hai. Pollinations key admin panel se add ki ja sakti hai — provider dropdown me "pollinations"
select karke, apiKey field khaali chhod sakte ho (optional).

## Kaise Kaam Karta Hai Fallback Loop

`lib/orchestrator.js` me provider order hai: `groq → cerebras → googleAiStudio → openrouter → cloudflare`
(chahe to order badal sakta hai — jo provider ka rate limit zyada generous hai use pehle rakh).

Har provider ke andar, uske 4 keys **least-recently-used** order me try hoti hain — matlab
load automatically 4 accounts me evenly spread hota hai. Koi key rate-limit (429/403) khaye
to wo 10 min ke liye "cooldown" me chali jaati hai aur loop agli key/provider try karta hai.
Sab kuch fail ho to client ko clear error milta hai with attempt list.

## Phase 2 — Ab Sab Engines Live Hain

Sab 13 planned engines ab implement ho chuke hain, Firestore-backed (Upstash abhi use nahi kiya — sab kuch already existing Firestore project me chal raha hai, ek aur service add karne ki zaroorat nahi padi):

| Engine | File | Kya karta hai |
|---|---|---|
| Task-based routing | `lib/modelRegistry.js` | TEXT / TEXT_FALLBACK / VISION / ADDITIONAL_LIVE_POOL pools, tere diye gaye model map ke hisaab se |
| Auto routing | `lib/orchestrator.js` (`resolvePoolOrder`) | Image ho to VISION pool, prompt bada ho (>100k tokens) to 1M-context fallback pool pehle |
| Fallback loop | `lib/orchestrator.js` | Pool → model → key, teeno level pe fallback |
| Smart cache engine | `lib/cache.js` | Firestore me exact-match response cache, 10 min TTL |
| Prompt compressor | `lib/tokenTools.js` (`compressPrompt`) | Extra whitespace/filler phrases hata deta hai bina meaning badle |
| Token counter + cutter | `lib/tokenTools.js` | ~4 chars/token approximation se token count |
| Context window slicer | `lib/tokenTools.js` (`sliceToContextWindow`) | Har model ke apne context window ke hisaab se purani messages trim karta hai |
| Stream + stop engine | `lib/streamTools.js`, `/api/v1/chat/stream` | SSE streaming response, client abort kar sakta hai |
| Request coalescing engine | `lib/coalescer.js` | Same time pe aayi identical requests ek hi upstream call share karti hain |
| Speculative prefetch engine | `lib/prefetch.js` | Fallback pool ki key-availability background me warm ho jaati hai |
| Adapter rate limit saver | `lib/rateLimitSaver.js` | Groq jaise known-RPM providers ke liye proactively near-limit keys skip karta hai |
| Token recycler engine | `lib/orchestrator.js` (`isContextLengthError`) | Context-too-long error pe automatically tighter slice se retry |
| Self-healing model scorer | `lib/modelScorer.js` | Har model ka rolling success-rate score, best-performing model pehle try hota hai |

### Naye/Updated API Endpoints

```javascript
// Text (ab vision bhi supported hai)
const res = await fetch("https://your-app.vercel.app/api/v1/chat", {
  method: "POST",
  headers: { "Authorization": "Bearer YOUR_MASTER_KEY_TEXT", "Content-Type": "application/json" },
  body: JSON.stringify({
    messages: [{ role: "user", content: "Is image me kya hai?" }],
    imageUrl: "https://example.com/photo.jpg" // ya imageBase64 + imageMimeType
  })
});
const data = await res.json();
console.log(data.text, data.provider, data.model, data.pool, data.cached);
```

```javascript
// Streaming (stop engine ke saath)
const controller = new AbortController();
const res = await fetch("https://your-app.vercel.app/api/v1/chat/stream", {
  method: "POST",
  headers: { "Authorization": "Bearer YOUR_MASTER_KEY_TEXT", "Content-Type": "application/json" },
  body: JSON.stringify({ messages: [{ role: "user", content: "Hello!" }] }),
  signal: controller.signal
});
const reader = res.body.getReader();
// ... read chunks ...
// controller.abort() koi bhi waqt call karke stream rok sakta hai
```

Admin panel (`/admin`) ab **Model Scores** table bhi dikhata hai — har model ka live score, latency, aur total calls, jisse pata chalega konsa model best perform kar raha hai.

## Bug Fixes Round 2

Deep code review ke baad ye bugs fix hue (koi purana feature hataya nahi, sab existing behavior ke saath backward-compatible hai):

1. **`/api/v1/chat/stream` me CORS missing tha** — baaki 3 routes (`chat`, `image`, `audio`) already `lib/cors.js` use kar rahe the, ye chautha route reh gaya tha. Browser se cross-origin call karne pe preflight silently fail hota tha. Fix ho gaya.
2. **Timing-safe compare wire nahi tha** — `lib/crypto.js` me `safeEqual()` (constant-time compare) pehle se ban chuka tha, lekin `lib/auth.js` plain `!==`/`===` use kar raha tha master-key aur admin-password dono checks me. Ab dono jagah `safeEqual()` use hota hai.
3. **Admin login pe brute-force lockout nahi tha** — koi bhi unlimited password guesses try kar sakta tha. Ab Firestore-backed lockout hai (`adminLockout` collection): 8 galat attempts ke baad 15 min ke liye admin panel lock ho jaata hai. Login form ye message bhi dikhata hai ab.
4. **403 hamesha "rate limit" treat hota tha, kabhi "permanent" nahi** — kuch providers (jaise Google AI Studio) 403 "quota permanently 0 hai is project ke liye" ke liye bhi bhejte hain, na ki sirf rate-limit ke liye. Pehle aisi key har 10 min me dobara try hoti rahti thi forever. Ab consecutive-403 counter hai (`markKeyFailure403`) — 5 lagatar 403 (bina beech me ek bhi success ke) ke baad key automatically disable ho jaati hai, jaisa 401/402/404 ke saath already hota tha.
5. **Prompt compressor context-blind tha** — "Please note that **our meeting is at 5pm**" jaisa real content wala message bhi "please note that" ko blindly strip kar deta tha kahin se bhi match ho, chahe wo real content ka hissa ho. Ab sirf sentence-opening filler transitions strip hoti hain ("Please note that, ..." start of message/sentence me), mid-sentence embedded matches ko chhod diya jaata hai.
6. **Self-healing scorer bahut volatile tha** — pehle ek hi failure se score 100→15 crash ho jaata tha (single-sample exponential moving average, 0.85 decay), aur recovery bhi kabhi stable nahi hota tha. Ab last 20 outcomes ka rolling success-rate use hota hai — ek transient failure ab score ko barely move karta hai, jabki genuinely-failing model still fast drop hota hai.
7. **Speculative prefetch dead code tha** — `prefetchPoolKeys()` call ho raha tha har request pe, lekin uska result kahin consume nahi hota tha — pure wasted Firestore read tha. Ab properly wired hai (8s freshness TTL ke saath safety ke liye), real latency benefit deta hai fallback pool try karte waqt.
8. **`rateLimitSaver` me sirf Groq tha, OpenRouter missing** — OpenRouter ka 50 req/day per-account cap bhi exactly is tarah ka hard limit hai jiske liye ye module bana tha. Ab OpenRouter bhi included hai (24h window). Saath hi, pehle har key ke liye alag Firestore query chalti thi (N reads per request) — ab ek hi batched query provider ke saare keys ke liye.
9. **`responseCache` aur `inFlight` docs kabhi delete nahi hote the** — comment "let it expire naturally" bolta tha lekin koi actual delete code nahi tha. Ab dono jagah best-effort delete add hua hai (expired cache-read pe, aur coalescer lock release ke kuch der baad) — ye partial fix hai; poora fix ke liye Firestore TTL policy console se set karo (niche "Firestore Cleanup" section dekho).
10. **Dead code hataya**: `isSimpleRequest` (kabhi call nahi hota tha) aur `providersForKind` (kabhi call nahi hota tha, aur agar hota to galat result deta — `kind === "mixed"` providers ko bhi image-capable maan leta jabki unme `generateImage` implement hi nahi hai).

## Round 5 — Test Page Master Keys Ab Persistent

**Problem**: test page pe master keys `sessionStorage` me save hoti thi — matlab browser tab band karte hi (ya restart pe) clear ho jaati thi, isliye har naye session me teeno keys dobara paste karni padti thi.

**Kyun server-side auto-fill possible nahi hai**: master keys Firestore me sirf **SHA-256 hash** ke roop me store hoti hain, plaintext kabhi nahi (`app/api/admin/master-keys/route.js` dekho) — ye jaan-bujh kar kiya gaya security design hai. Isliye "Vercel env se ya Firestore se dobara fetch kar lo" wala koi seedha raasta nahi hai — hash se plaintext wapas nikalna cryptographically possible hi nahi hota.

**Fix**: `sessionStorage` ki jagah ab `localStorage` use hota hai (`app/test/page.js`) — ek baar teeno keys paste karne ke baad, is browser me hamesha save rahengi (tab close/restart survive karengi), jab tak khud na hataao. Naya **"Clear Saved Keys"** button bhi hai (header me, jab teeno keys filled hon) — agar shared/public device use kar rahe ho to ek click me clear kar sakte ho.

Trust boundary same hai jo pehle thi — keys sirf is browser me, sirf tere gateway ki apni API ko bheji jaati hain, kahin aur nahi.

## Round 4 — Complexity-Based Model Routing + Naye Coding Models

1. **Complexity-based auto-routing** — har text request ab `classifyComplexity()` (naya, `lib/tokenTools.js`) se guzarti hai jo teen tags deti hai:
   - `simple` — chhota, plain-language message (greeting, quick fact, chhota rewrite) — koi code/engineering keyword nahi, 400 tokens se kam
   - `standard` — na bahut chhota na koi complexity-signal — purana default behavior
   - `complex` — code-block (` ``` `), engineering keywords (function/debug/refactor/api/database/architecture/etc.), multi-step planning language, image attached, ya 8000+ tokens ka prompt

   Har tag ka apna pool-order hai (`lib/modelRegistry.js` — `SIMPLE_POOL_ORDER`, `TEXT_POOL_ORDER`, `COMPLEX_POOL_ORDER`):
   - **Simple** → naya `SIMPLE` pool pehle try hota hai (Groq `gpt-oss-20b` + Cerebras `gpt-oss-120b`) — fast, aur `TEXT`/`TEXT_COMPLEX` pool ka quota bachta hai chhoti chat ke liye
   - **Complex** → naya `TEXT_COMPLEX` pool pehle try hota hai — specifically coding/agentic-strength wale models (neeche dekho)
   - **Standard** → purana `TEXT` pool, koi change nahi

   Ye heuristic-based hai (koi LLM call nahi karta classify karne ke liye — wo khud ek request lagegi, jiska poora point hi ye avoid karna hai). False-positive/negative dono ka cost bas "shayad thoda weak/strong model try hua pehle" hai — model-scorer aur fallback chain wahi se recover kar leti hai, ye ek hard rule nahi hai bas ek smart first-guess hai.

   Response body me ab `complexity` field bhi aata hai (`pool` field ke saath) — test page pe har result ke saath dikh jaata hai kaunse tag/pool se serve hua.

2. **Naye coding-focused free models add hue** (`lib/modelRegistry.js` ka naya `TEXT_COMPLEX` pool):
   - **Z.ai GLM 5.2** (`z-ai/glm-5.2:free`, OpenRouter) — 1M context, explicitly "project-level software engineering, long-horizon agent workflows" ke liye design kiya gaya
   - **Poolside Laguna S 2.1** (`poolside/laguna-s-2.1:free`, OpenRouter) — coding agent model, 70.2% Terminal-Bench 2.1
   - **Cerebras `zai-glm-4.7`** — pehle se tha, `ADDITIONAL_LIVE_POOL` se yahan move kiya (uska hi asli purpose hai)

   Naya `TEXT_FALLBACK` addition: **MiniMax M3** (`minimax/minimax-m3:free`) — 1M context, "long-horizon agentic work, coding, tool use".

   Note: DeepSeek V4 (jo abhi bahut discuss ho raha hai — Opus-level bataya ja raha hai coding benchmarks pe) **is waqt OpenRouter ke free tier me nahi hai** (live check kiya gaya) — sirf paid hai (~$0.44/M input tokens). Free lineup rotate hota rehta hai, isliye future me agar wapas free aaye to yahi teen jagah (`TEXT_COMPLEX` ya `TEXT_FALLBACK`) me `deepseek/...:free` model-id add karna hoga.

3. **Do chhote bugs jo isi kaam ke dauraan mile aur fix hue:**
   - `routeTextRequestStream()` (`/chat/stream` ka backend) complexity-routing use hi nahi kar raha tha — `routeTextRequest()` me wire kiya tha lekin streaming wala function alag hai, wahan miss ho gaya tha. Ab dono jagah same complexity classification apply hoti hai.
   - CORS headers me `Access-Control-Expose-Headers` set nahi tha — matlab agar koi cross-origin client (jaisa koi doosri site ya app se ye gateway call ho, na ki same Vercel deployment se) naye `X-Gateway-Pool`/`X-Gateway-Complexity` response headers padhne ki koshish karta, unhe khaali/null milta chahe response body sahi aata. Same-origin (jaisa admin/test page) pe ye issue nahi tha, isliye pehle test karte waqt miss ho sakta tha. Fix ho gaya.

## Round 3 — Naye Features + Real Streaming

1. **Real streaming (fake typewriter hataya)** — `/api/v1/chat/stream` pehle poora response wait karta tha, phir artificial 20ms/chunk delay ke saath re-chunk karta tha (total time plain `/chat` se bhi zyada, koi real benefit nahi tha). Ab Groq/OpenRouter/Cerebras ke asli `stream: true` (OpenAI-compatible SSE) endpoints use hote hain — first-token latency ab provider ki real TTFT (time-to-first-token) match karti hai. Fallback logic: streaming-capable provider se **connect** hone tak fail-fast fallback chalta hai (agla key/provider try hota hai), lekin ek baar bytes client ko jaane lagen us stream ko complete hone dete hain (mid-stream provider-switch se garbled/duplicate output aata, isliye wo nahi kiya).
2. **Vision preview URL leak fix** — test page pe image preview ke liye `URL.createObjectURL()` use hota hai; pehle sirf next-file-select pe revoke hota tha, ab component unmount pe bhi revoke hota hai.
3. **`requestLogs` ke liye daily cleanup cron** — naya `/api/cron/cleanup-logs` route, Vercel Cron se roz 3 AM UTC pe trigger hota hai, 14 din se purane logs delete karta hai (batched). Setup steps "Firestore Cleanup" section ke baad hai.
4. **Provider routing by remaining-quota%** — `lib/usageLimits.js` me ab live per-key daily usage tracking hai (Firestore `usageCounters` collection). Pehle ye sirf display ke liye tha; ab orchestrator isko actually routing decision me use karta hai — jis key ka aaj ka quota sabse zyada bacha hai, use pehle try kiya jaata hai (rate-limit filter ke baad). Admin panel me naya "Quota Left %" column bhi dikhta hai.
5. **"Run All Tests" button** — test page pe, Text + Stream + Image Generation ko sequentially chalata hai (jinki key di hai). Vision aur Audio-file alag se chalane hote hain kyunki unme manually file choose karni padti hai.
6. **Request Logs filter/search** — admin panel ke "Recent Requests" table me provider/type/status dropdown filters, aur model/error text search.
7. **Dark/Light mode toggle** — navbar me sun/moon icon, localStorage me persist hota hai, page-load pe flash-of-wrong-theme na ho isliye ek inline script layout.js me hai jo theme apply karta hai React hydrate hone se pehle hi.
8. **Text-to-Speech** — naya `/api/v1/speech` route (MASTER_KEY_AUDIO use karta hai — same key jo transcription ke liye hai, kyunki dono "audio" domain me hain). Cloudflare ka `@cf/myshell-ai/melotts` model use hota hai. Body: `{ "text": "...", "lang": "en" }` (lang optional). Response: `{ "audioBase64": "...", "contentType": "audio/mpeg" }`.
9. **`/api/v1/embeddings` route** — naya route, MASTER_KEY_TEXT use karta hai (embeddings text-domain operation hai). Cloudflare ka `@cf/baai/bge-large-en-v1.5` model. Body: `{ "input": "text" }` ya `{ "input": ["text1", "text2"] }` (OpenAI convention). Response: `{ "embeddings": [[...vector], ...] }`.
10. **Key rotation reminder** — disabled hone wali keys ab `disabledAt` timestamp save karti hain. Admin panel me naya "Disabled Since" column — "3d ago" jaisa dikhta hai, 3+ din yellow, 7+ din red, taaki purani-disabled keys nazar-andaz na hon.
11. **Webhook/alerting (Telegram + Discord)** — naya `lib/alerts.js`. Jab koi provider **fully down** ho jaaye (sab keys disabled), automatically ek alert bhejta hai Telegram aur/ya Discord pe (jo bhi configure kiya ho — dono optional hain). Hourly cooldown hai per-provider taaki spam na ho. Jab key reactivate ho to ek "recovered" alert bhi milta hai. Setup: `.env.example` me `TELEGRAM_BOT_TOKEN` + `TELEGRAM_CHAT_ID`, ya `DISCORD_WEBHOOK_URL` (ya dono) daalo — koi bhi na daalo to feature silently disabled rehta hai.

## Firestore Cleanup (TTL Policy Setup — Optional Lekin Recommended)

Code-level best-effort deletes (upar #9) sirf un docs ko clean karte hain jo **dobara** access hote hain (ek expired cache-entry ko doosri baar dhoondha jaaye tab delete hoti hai). Ek prompt jo sirf ek hi baar use hua ho, uska cache-doc kabhi dobara access nahi hoga, isliye wo hamesha reh jaayega — is case ke liye Firestore ka apna **TTL (Time-To-Live) policy** feature use karo, jo automatically purane docs delete karta hai bina kisi code ke:

1. Firebase Console → Firestore Database → **TTL** tab (ya Google Cloud Console → Firestore → TTL Policies)
2. `responseCache` collection ke liye: field `expiresAt` par TTL policy add karo
3. `inFlight` collection ke liye: field `claimedAt` par TTL policy add karo (isse ~1 din purane abandoned locks bhi clean ho jaayenge)
4. Optional: `requestLogs` collection ke liye bhi ek TTL policy add kar sakte ho agar purane logs nahi chahiye (jaise `createdAt` par 30-din TTL) — isse admin stats dashboard bhi fast rahega jaise-jaise data badhega

TTL policy free hai aur setup ke baad kuch bhi extra karne ki zaroorat nahi — Firestore khud background me expired docs clean karta rehta hai (usually 24 ghante ke andar, exact time guaranteed nahi hota lekin eventual hai).

### `requestLogs` Ke Liye Extra Fix — Daily Cron Job

`requestLogs` collection TTL policy se cover nahi hota agar tu chahta hai ki logs **use hone ke baad turant** na katen, balki ek fixed retention window (jaise 14 din) tak rakhe jaayen taaki admin dashboard me recent history dikhti rahe — TTL sirf ek hi expiry-timing de sakta hai poori collection ke liye.

Isliye ek dedicated cron route hai: `app/api/cron/cleanup-logs/route.js`, jo **14 din se purane** `requestLogs` docs delete karta hai (batched deletes, 400 docs per batch), aur saath me expired `responseCache` docs bhi clean karta hai (TTL policy setup na hone ki soorat me backstop).

**Setup**:
1. Vercel env vars me ek naya secret add karo: `CRON_SECRET` (koi bhi random string, `openssl rand -hex 16` se generate kar sakta hai)
2. `vercel.json` me already `crons` entry hai jo isko roz **3 AM UTC** pe trigger karega — Vercel ye automatically schedule kar dega deploy hone par (Hobby plan par cron jobs available hain, lekin sirf ek baar per-day frequency tak — jo yahan already match karta hai)
3. Vercel khud `Authorization: Bearer <CRON_SECRET>` header bhejta hai apne cron requests me — route isi se verify karta hai ki request genuinely Vercel se aayi hai, na ki koi bahar se URL guess karke delete trigger kar raha

Manually bhi test kar sakta hai (deploy hone ke baad):
```bash
curl -H "Authorization: Bearer YOUR_CRON_SECRET" https://your-app.vercel.app/api/cron/cleanup-logs
```
Response me `requestLogsDeleted` aur `cacheDeleted` count milega.

### Agla Step (Optional, Baad Me)

Agar zaroorat pade to Upstash abhi bhi add kar sakte hain — cache/coalescing/rate-limit ko Firestore se Upstash Redis me move karna latency thoda kam karega (Redis Firestore se fast hai), lekin abhi ke free-tier scale pe Firestore version bilkul theek chalega.

## UI Update (Mobile + Admin Session Fix)

- **Admin login ab session-persistent hai**: password ab `sessionStorage` me cache hota hai
  (tab band karne tak rehta hai, disk pe kabhi save nahi hota) aur mount pe silently
  re-validate hota hai. Matlab admin panel se test page pe jaake wapas aane par **dobara
  password nahi maangega** — jab tak tab close na karo ya password galat/rotate na ho jaaye.
- **Shared navbar** `next/link` use karta hai ab (client-side navigation) instead of plain
  `<a>` tags — pehle har navigation full page reload karta tha jo hi admin-login bhi reset
  kar deta tha.
- **Mobile-responsive**: naya `app/globals.css` design system — cards, tables (horizontally
  scrollable on narrow screens), buttons, forms sab chhoti screen ke liye tuned hain.
- **Test page (MVP) strong**: master keys ab yahan bhi `sessionStorage` me cached rehti hain,
  har request ka latency dikhta hai, fail hone par attempt-list table dikhta hai (kaunsa
  provider/status fail hua), image preview aur raw-response collapsible section.

## File Structure

```
app/
  api/v1/chat/route.js         — text endpoint
  api/v1/chat/stream/route.js  — real streaming text endpoint (SSE)
  api/v1/image/route.js        — image generation endpoint
  api/v1/audio/route.js        — audio transcription endpoint
  api/v1/speech/route.js       — text-to-speech endpoint (MeloTTS)
  api/v1/embeddings/route.js   — text embeddings endpoint (bge-large)
  api/admin/keys/route.js      — add/list/delete/reactivate provider keys
  api/admin/stats/route.js     — tracking dashboard data
  api/cron/cleanup-logs/route.js — daily requestLogs + cache pruning (Vercel Cron)
  admin/page.js                — admin frontend UI (session-persistent login)
  test/page.js                 — MVP test console for all master keys + streaming
  page.js, layout.js            — landing page + shared root layout (theme-init script)
  globals.css                   — shared design system (mobile-responsive, dark+light)
components/
  Navbar.js                     — shared navbar (active-route highlighting, theme toggle)
lib/
  firebaseAdmin.js               — Firestore admin client
  crypto.js                      — AES-256-GCM encrypt/decrypt, SHA-256 hash
  auth.js                        — master key + admin password checks (timing-safe)
  providers.js                    — per-provider API call adapters (call + callStream + generateImage/Speech/Embedding)
  keyManager.js                   — Firestore key fetch/update logic, disable/alert wiring
  orchestrator.js                  — the fallback loop (text, stream, image, audio, speech, embeddings)
  usageLimits.js                    — published free-tier limits + live per-key quota tracking
  streamTools.js                    — real SSE relay for streaming responses
  alerts.js                          — Telegram/Discord down-provider alerting
  cors.js, clientExport.js           — CORS headers, client-side report download
scripts/
  seed-keys.mjs               — bulk-seed master keys + provider keys from .env
firestore.rules              — locks Firestore to server-only access
vercel.json                  — function timeouts + daily cron schedule
```
```
