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
 */

const prefetchCache = new Map(); // module-scope cache, lives for the duration of this invocation

export function prefetchPoolKeys(providerNames) {
  for (const provider of providerNames) {
    // Don't await — this runs opportunistically alongside the primary call.
    db()
      .collection("apiKeys")
      .where("provider", "==", provider)
      .where("status", "in", ["active", "cooldown"])
      .get()
      .then((snap) => {
        prefetchCache.set(provider, snap.docs.map((d) => ({ id: d.id, ...d.data() })));
      })
      .catch(() => {
        // Prefetch is best-effort; swallow errors silently.
      });
  }
}

export function getPrefetched(provider) {
  return prefetchCache.get(provider) || null;
}
