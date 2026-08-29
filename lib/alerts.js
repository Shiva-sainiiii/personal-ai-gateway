import { db } from "./firebaseAdmin.js";
import { FieldValue } from "firebase-admin/firestore";

/**
 * Webhook / alerting engine.
 *
 * The admin dashboard already shows a "provider fully down" banner (every
 * key for that provider is disabled), but that's only visible if someone
 * happens to have the dashboard open. This pushes the same alert to
 * Telegram and/or Discord the moment it happens, server-side, so you find
 * out even when you're not looking at the admin panel.
 *
 * Configuration is entirely optional — if neither webhook env var is set,
 * every function here is a silent no-op. Set ONE OR BOTH of:
 *   TELEGRAM_BOT_TOKEN + TELEGRAM_CHAT_ID
 *   DISCORD_WEBHOOK_URL
 */

const ALERT_COOLDOWN_MS = 60 * 60 * 1000; // don't re-alert for the same provider more than once/hour

async function shouldAlert(provider) {
  const ref = db().collection("alertState").doc(provider);
  const snap = await ref.get();
  const lastAlertedAt = snap.exists ? snap.data().lastAlertedAt?.toMillis?.() ?? 0 : 0;
  if (Date.now() - lastAlertedAt < ALERT_COOLDOWN_MS) return false;
  await ref.set({ lastAlertedAt: FieldValue.serverTimestamp() }, { merge: true });
  return true;
}

async function sendTelegram(message) {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  const chatId = process.env.TELEGRAM_CHAT_ID;
  if (!token || !chatId) return;

  try {
    await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chat_id: chatId, text: message, parse_mode: "Markdown" }),
    });
  } catch {
    // Alerting must never break the request that triggered it — swallow errors.
  }
}

async function sendDiscord(message) {
  const url = process.env.DISCORD_WEBHOOK_URL;
  if (!url) return;

  try {
    await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ content: message }),
    });
  } catch {
    // Same as above — best-effort only.
  }
}

/**
 * Call this whenever a key transitions to "disabled". It checks whether
 * that was the LAST active key for the provider (i.e. the provider just
 * went from "degraded" to "fully down") and fires an alert if so — not on
 * every single key disable, only on the provider-wide zero-capacity moment.
 */
export async function checkAndAlertIfProviderDown(provider) {
  if (!process.env.TELEGRAM_BOT_TOKEN && !process.env.DISCORD_WEBHOOK_URL) return; // not configured, skip the Firestore read entirely

  const snap = await db().collection("apiKeys").where("provider", "==", provider).get();
  if (snap.empty) return;

  const total = snap.size;
  const activeOrCooldown = snap.docs.filter((d) => d.data().status !== "disabled").length;

  if (activeOrCooldown > 0) return; // still has capacity, nothing to alert about

  if (!(await shouldAlert(provider))) return; // already alerted recently, avoid spamming

  const message = `🔴 *AI Gateway Alert*\n\nProvider *${provider}* is fully down — all ${total} key(s) are disabled.\nNo requests will succeed through this provider until a key is fixed or reactivated.`;

  await Promise.all([sendTelegram(message), sendDiscord(message)]);
}

/**
 * Optional companion alert for recovery — call this from the Reactivate
 * button's handler (or anywhere a key returns to "active") so you also get
 * a "back online" message instead of only ever hearing about outages.
 */
export async function alertProviderRecovered(provider) {
  if (!process.env.TELEGRAM_BOT_TOKEN && !process.env.DISCORD_WEBHOOK_URL) return;

  const message = `✅ *AI Gateway Recovery*\n\nProvider *${provider}* has at least one active key again.`;
  await Promise.all([sendTelegram(message), sendDiscord(message)]);
}
