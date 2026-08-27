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

## Image aur Audio Routing (Update)

Image aur Audio dono ab **Google AI Studio ko primary** provider ki tarah use karte hain, Cloudflare fallback hai:

- **Image**: `gemini-2.5-flash-image` ("Nano Banana") — Google ke free tier me ~500 images/day per account milte hain, 4 accounts ke saath ~2000/day tak
- **Audio**: `gemini-2.5-flash` (wahi model jo text ke liye use hota hai) audio ko inline data ke roop me accept karke transcribe kar sakta hai — koi alag speech-to-text API ki zaroorat nahi

Isliye Cloudflare keys add karna ab **optional** hai — sirf extra fallback capacity ke liye chahiye, image/audio kaam karne ke liye zaroori nahi.

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
| Model downgrade | `lib/tokenTools.js` (`isSimpleRequest`) | Chhote prompts ke liye flag (future me chhote model prefer karne ke liye use ho sakta hai) |
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

### Agla Step (Optional, Baad Me)

Agar zaroorat pade to Upstash abhi bhi add kar sakte hain — cache/coalescing/rate-limit ko Firestore se Upstash Redis me move karna latency thoda kam karega (Redis Firestore se fast hai), lekin abhi ke free-tier scale pe Firestore version bilkul theek chalega.

## File Structure

```
app/
  api/v1/chat/route.js       — text endpoint
  api/v1/image/route.js      — image endpoint
  api/v1/audio/route.js      — audio endpoint
  api/admin/keys/route.js    — add/list/delete provider keys
  api/admin/stats/route.js   — tracking dashboard data
  admin/page.js              — admin frontend UI
  page.js, layout.js         — landing page
lib/
  firebaseAdmin.js           — Firestore admin client
  crypto.js                  — AES-256-GCM encrypt/decrypt, SHA-256 hash
  auth.js                    — master key + admin password checks
  providers.js                — per-provider API call adapters
  keyManager.js               — Firestore key fetch/update logic
  orchestrator.js              — the actual fallback loop
scripts/
  seed-keys.mjs               — bulk-seed master keys + provider keys from .env
firestore.rules              — locks Firestore to server-only access
```
