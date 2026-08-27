import crypto from "node:crypto";
import { db } from "./firebaseAdmin.js";
import { FieldValue } from "firebase-admin/firestore";

/**
 * Request coalescing engine.
 *
 * If two identical requests (same pool + same messages) arrive at nearly
 * the same time — e.g. a flaky client retry, or two browser tabs — this
 * makes the second request wait for the first one's result instead of
 * burning a second provider call and a second key.
 *
 * Serverless functions are separate processes, so this can't share an
 * in-memory promise the way a single long-running server could. Instead
 * it uses a short-lived Firestore "lock" doc: the first request claims it
 * and proceeds normally; a near-simultaneous duplicate polls the lock doc
 * briefly for the result rather than calling providers again.
 */

const LOCK_TTL_MS = 20 * 1000; // a lock older than this is considered abandoned
const POLL_INTERVAL_MS = 400;
const MAX_WAIT_MS = 15 * 1000;

function hashKey(poolName, messages) {
  return crypto.createHash("sha256").update(JSON.stringify({ poolName, messages })).digest("hex");
}

/**
 * Attempts to claim the coalescing lock for this request.
 * Returns { claimed: true } if this call should proceed and do the real work,
 * or { claimed: false, wait: () => Promise<result|null> } if another
 * in-flight request should be waited on instead.
 */
export async function claimOrWait(poolName, messages) {
  const key = hashKey(poolName, messages);
  const ref = db().collection("inFlight").doc(key);

  const claimed = await db().runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    if (snap.exists) {
      const data = snap.data();
      const age = Date.now() - (data.claimedAt?.toMillis?.() ?? 0);
      if (age < LOCK_TTL_MS && !data.result) {
        return false; // someone else is actively working on this
      }
    }
    tx.set(ref, { claimedAt: FieldValue.serverTimestamp(), result: null });
    return true;
  });

  if (claimed) {
    return {
      claimed: true,
      async release(result) {
        // Store the result briefly so waiters can pick it up, then let it expire naturally.
        await ref.set({ claimedAt: FieldValue.serverTimestamp(), result }, { merge: true });
      },
    };
  }

  return {
    claimed: false,
    async wait() {
      const start = Date.now();
      while (Date.now() - start < MAX_WAIT_MS) {
        await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
        const snap = await ref.get();
        if (snap.exists && snap.data().result) return snap.data().result;
      }
      return null; // gave up waiting — caller should fall through to its own request
    },
  };
}
