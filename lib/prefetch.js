import { db } from "./firebaseAdmin.js";

/**
 * Speculative prefetch engine.
 *
 * True token-level speculative decoding isn't available on third-party
 * free APIs, so this implements the part of "prefetch" that actually pays
 * off in a multi-provider gateway: while the primary pool is being tried,
 * kick off a cheap, non-blocking Firestore read to warm up knowledge of
 * the FALLBACK pool's key availability (which keys are active vs in
 * cooldown right now). If the primary pool fails and we fall through,
 * the fallback pool's key list is already resolved instead of costing an
 * extra round trip at the moment we need it.
 *
 * This is intentionally fire-and-forget: it must never slow down or fail
 * the primary request.
 *
 * Bug fix (was dead code): getPrefetched() used to be exported but never
 * called from orchestrator.js — prefetchPoolKeys() fired the background read
 * every loop iteration, but getActiveKeysForProvider() always did its own
 * fresh query regardless, so every prefetch was purely wasted Firestore
 * cost with zero benefit. orchestrator.js now checks getPrefetched() first
 * and only falls through to a fresh read on a genuine miss.
 */

const prefetchCache = new Map(); // module-scope cache, lives for the duration of this invocation
// Guards against serving a stale prefetch that resolved a while ago and may
// no longer reflect a key's real status (e.g. it cooled down or got disabled
// by a different concurrent request in the meantime). A prefetch is only
// ever meant to save the specific round trip immediately after it — past
// this age it's safer to just do a fresh read than trust the cached one.
const PREFETCH_MAX_AGE_MS = 8000;

export function prefetchPoolKeys(providerNames) {
  for (const provider of providerNames) {
    // Don't await — this runs opportunistically alongside the primary call.
    db()
      .collection("apiKeys")
      .where("provider", "==", provider)
      .where("status", "in", ["active", "cooldown"])
      .get()
      .then((snap) => {
        prefetchCache.set(provider, {
          keys: snap.docs.map((d) => ({ id: d.id, ...d.data() })),
          fetchedAt: Date.now(),
        });
      })
      .catch(() => {
        // Prefetch is best-effort; swallow errors silently.
      });
  }
}

export function getPrefetched(provider) {
  const entry = prefetchCache.get(provider);
  if (!entry) return null;
  if (Date.now() - entry.fetchedAt > PREFETCH_MAX_AGE_MS) {
    prefetchCache.delete(provider); // stale — let the caller fall through to a fresh query
    return null;
  }
  return entry.keys;
}
