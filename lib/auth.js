import { db } from "./firebaseAdmin.js";
import { sha256Hex, safeEqual } from "./crypto.js";
import { FieldValue } from "firebase-admin/firestore";

/**
 * Validates the Authorization: Bearer <masterKey> header against the
 * SHA-256 hash stored in Firestore (masterKeys/{type}). Plaintext master
 * keys are never persisted anywhere in the DB.
 *
 * @param {Request} req
 * @param {"text"|"image"|"audio"} expectedType - which master key this route accepts
 * @returns {Promise<{ok: true} | {ok: false, status: number, error: string}>}
 */
export async function requireMasterKey(req, expectedType) {
  const authHeader = req.headers.get("authorization") || "";
  const [scheme, token] = authHeader.split(" ");

  if (scheme !== "Bearer" || !token) {
    return { ok: false, status: 401, error: "Missing or malformed Authorization header. Use: Bearer <masterKey>" };
  }

  const incomingHash = sha256Hex(token);

  const snap = await db().collection("masterKeys").doc(expectedType).get();
  if (!snap.exists) {
    return { ok: false, status: 500, error: `Master key of type '${expectedType}' is not configured in Firestore.` };
  }

  const { hash, active } = snap.data();
  if (active === false) {
    return { ok: false, status: 403, error: `Master key of type '${expectedType}' has been deactivated.` };
  }

  // Constant-time compare: safeEqual() already existed in crypto.js but was
  // never wired in here — this was doing a plain !== (character-by-character,
  // early-exit) compare, which is a timing-attack side channel on the master
  // key. Low practical risk for a personal gateway, but a one-line fix.
  if (!safeEqual(incomingHash, hash)) {
    return { ok: false, status: 401, error: "Invalid master key." };
  }

  return { ok: true };
}

/**
 * Simple admin-panel guard for /api/admin/* routes.
 * Checks X-Admin-Password header against process.env.ADMIN_PASSWORD.
 *
 * Also enforces a lockout after repeated wrong passwords: previously this
 * was a single string compare with no attempt limit at all, so the admin
 * password (which guards every provider key in the system) could be brute
 * forced with unlimited guesses. Failed attempts are tracked in Firestore
 * (not in-memory) specifically because this runs on Vercel serverless —
 * an in-memory counter resets on every cold start and would protect
 * nothing. The lockout is intentionally simple (single global counter, not
 * per-IP) since this is a single-admin personal system.
 */
const MAX_ADMIN_ATTEMPTS = 8;
const LOCKOUT_WINDOW_MS = 15 * 60 * 1000; // failed attempts older than this don't count
const LOCKOUT_DURATION_MS = 15 * 60 * 1000; // once locked, stay locked this long

export async function requireAdmin(req) {
  const provided = req.headers.get("x-admin-password") || "";
  const expected = process.env.ADMIN_PASSWORD || "";
  if (!expected) {
    return { ok: false, status: 500, error: "ADMIN_PASSWORD not configured on the server." };
  }

  const lockRef = db().collection("adminLockout").doc("global");
  const lockSnap = await lockRef.get();
  const lockData = lockSnap.exists ? lockSnap.data() : null;
  const now = Date.now();

  if (lockData?.lockedUntil?.toMillis?.() > now) {
    const minutesLeft = Math.ceil((lockData.lockedUntil.toMillis() - now) / 60000);
    return { ok: false, status: 429, error: `Too many wrong passwords. Try again in ~${minutesLeft} min.` };
  }

  // safeEqual requires equal-length buffers; different lengths fail fast (no
  // timing signal there since length is not secret), still constant-time
  // for same-length guesses which is the part that actually matters.
  const isCorrect = provided.length === expected.length && safeEqual(provided, expected);

  if (!isCorrect) {
    const recentAttempts = lockData?.windowStart?.toMillis?.() > now - LOCKOUT_WINDOW_MS ? (lockData.attempts || 0) + 1 : 1;
    const update = {
      attempts: recentAttempts,
      windowStart: recentAttempts === 1 ? FieldValue.serverTimestamp() : lockData.windowStart,
    };
    if (recentAttempts >= MAX_ADMIN_ATTEMPTS) {
      update.lockedUntil = new Date(now + LOCKOUT_DURATION_MS);
      update.attempts = 0; // reset counter once locked, next window starts fresh after unlock
    }
    await lockRef.set(update, { merge: true });
    return { ok: false, status: 401, error: "Invalid admin password." };
  }

  // Successful login clears any partial failure count.
  if (lockData?.attempts) {
    await lockRef.set({ attempts: 0, lockedUntil: null }, { merge: true });
  }

  return { ok: true };
}
