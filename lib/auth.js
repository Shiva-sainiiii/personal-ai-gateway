import { db } from "./firebaseAdmin.js";
import { sha256Hex } from "./crypto.js";

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

  if (incomingHash !== hash) {
    return { ok: false, status: 401, error: "Invalid master key." };
  }

  return { ok: true };
}

/**
 * Simple admin-panel guard for /api/admin/* routes.
 * Checks X-Admin-Password header against process.env.ADMIN_PASSWORD.
 */
export function requireAdmin(req) {
  const provided = req.headers.get("x-admin-password") || "";
  const expected = process.env.ADMIN_PASSWORD || "";
  if (!expected) {
    return { ok: false, status: 500, error: "ADMIN_PASSWORD not configured on the server." };
  }
  if (provided !== expected) {
    return { ok: false, status: 401, error: "Invalid admin password." };
  }
  return { ok: true };
}
