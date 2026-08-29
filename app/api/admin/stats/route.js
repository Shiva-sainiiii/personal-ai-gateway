import { NextResponse } from "next/server";
import { requireAdmin } from "../../../../lib/auth.js";
import { db } from "../../../../lib/firebaseAdmin.js";
import { DAILY_FREE_LIMITS, PER_MODEL_LIMITS } from "../../../../lib/usageLimits.js";
import { MODEL_REGISTRY } from "../../../../lib/modelRegistry.js";

export const runtime = "nodejs";

// All (provider, model) pairs currently listed anywhere in MODEL_REGISTRY —
// used to flag modelScores docs whose model has since been removed from the
// registry (e.g. deprecated by the provider) so the admin UI can offer to
// prune them instead of them accumulating as permanent dead entries.
function knownModelIds() {
  const ids = new Set();
  for (const pool of Object.values(MODEL_REGISTRY)) {
    for (const entry of pool) ids.add(`${entry.provider}__${entry.model}`.replace(/\//g, "-"));
  }
  return ids;
}

// GET /api/admin/stats — summary for the tracking dashboard:
// key counts per provider, active/cooldown/disabled breakdown, recent request logs.
export async function GET(req) {
  const auth = await requireAdmin(req);
  if (!auth.ok) return NextResponse.json({ error: auth.error }, { status: auth.status });

  const keysSnap = await db().collection("apiKeys").get();
  const byProvider = {};
  keysSnap.forEach((doc) => {
    const d = doc.data();
    byProvider[d.provider] ??= { total: 0, active: 0, cooldown: 0, disabled: 0 };
    byProvider[d.provider].total += 1;
    byProvider[d.provider][d.status] = (byProvider[d.provider][d.status] || 0) + 1;
  });

  const recentLogsSnap = await db()
    .collection("requestLogs")
    .orderBy("createdAt", "desc")
    .limit(50)
    .get();
  const recentLogs = recentLogsSnap.docs.map((doc) => ({ id: doc.id, ...doc.data() }));

  const last24hCutoff = new Date(Date.now() - 24 * 60 * 60 * 1000);
  const last24hSnap = await db()
    .collection("requestLogs")
    .where("createdAt", ">=", last24hCutoff)
    .get();

  let successCount = 0;
  let failCount = 0;
  // Rolling per-provider usage over the same last-24h window — reuses this
  // snapshot instead of a second query. Token counts only exist on rows
  // logged after usage tracking was added; older rows just contribute 0.
  const usageByProvider = {};
  last24hSnap.forEach((doc) => {
    const d = doc.data();
    if (d.ok) successCount += 1;
    else failCount += 1;

    if (!d.ok) return; // only successful calls consume real quota
    usageByProvider[d.provider] ??= { requests: 0, totalTokens: 0 };
    usageByProvider[d.provider].requests += 1;
    usageByProvider[d.provider].totalTokens += d.totalTokens || 0;
  });

  // How many non-disabled accounts each provider has — free-tier daily caps
  // are per-account, so effective capacity = limit × active account count.
  const activeAccountsByProvider = {};
  Object.entries(byProvider).forEach(([provider, counts]) => {
    activeAccountsByProvider[provider] = counts.active + counts.cooldown; // cooldown keys still count today's usage against their own bucket
  });

  const modelScoresSnap = await db().collection("modelScores").orderBy("score", "desc").get();
  const known = knownModelIds();
  const modelScores = modelScoresSnap.docs.map((doc) => ({ id: doc.id, ...doc.data(), isKnownModel: known.has(doc.id) }));

  // Per-key remaining quota % (today, UTC) — this is the live data that now
  // actually drives routing order (see lib/usageLimits.js's
  // rankKeysByRemainingQuota, wired into orchestrator.js), surfaced here so
  // the dashboard shows the SAME numbers the router is acting on, not a
  // separate display-only estimate.
  const todayStr = new Date().toISOString().slice(0, 10);
  const keyIds = keysSnap.docs.map((doc) => doc.id);
  const usageDocIds = keyIds.map((id) => `${id}_${todayStr}`);
  const usageRefs = usageDocIds.map((id) => db().collection("usageCounters").doc(id));
  const usageSnaps = usageRefs.length ? await db().getAll(...usageRefs) : [];
  const remainingQuotaByKey = {};
  usageSnaps.forEach((snap, i) => {
    const keyId = keyIds[i];
    const keyDoc = keysSnap.docs.find((d) => d.id === keyId);
    const provider = keyDoc?.data().provider;
    const limitInfo = DAILY_FREE_LIMITS[provider];
    const used = snap.exists ? snap.data().used || 0 : 0;
    const remainingPct =
      !limitInfo || limitInfo.amount == null ? null : Math.max(0, Math.round(((limitInfo.amount - used) / limitInfo.amount) * 100));
    remainingQuotaByKey[keyId] = { used, limit: limitInfo?.amount ?? null, remainingPct };
  });

  return NextResponse.json({
    byProvider,
    last24h: { success: successCount, failed: failCount, total: successCount + failCount },
    recentLogs,
    modelScores,
    usageByProvider,
    activeAccountsByProvider,
    dailyFreeLimits: DAILY_FREE_LIMITS,
    // Per-model ceilings for "per-model"/"mixed" scope providers (e.g. Groq)
    // where dailyFreeLimits above has no single account-wide number to show —
    // the dashboard needs this to display real per-model headroom instead of
    // a blank/null limit for those providers.
    perModelLimits: PER_MODEL_LIMITS,
    remainingQuotaByKey,
  });
}

// DELETE /api/admin/stats?pruneDeadModels=true
// Removes modelScores docs whose (provider, model) pair is no longer in
// MODEL_REGISTRY — e.g. a model the provider deprecated and that was
// migrated away from in the registry, but whose old score doc was never
// cleaned up (previously there was no cleanup path for this at all).
export async function DELETE(req) {
  const auth = await requireAdmin(req);
  if (!auth.ok) return NextResponse.json({ error: auth.error }, { status: auth.status });

  const pruneDeadModels = new URL(req.url).searchParams.get("pruneDeadModels") === "true";
  if (!pruneDeadModels) {
    return NextResponse.json({ error: "Nothing to do — pass ?pruneDeadModels=true." }, { status: 400 });
  }

  const known = knownModelIds();
  const snap = await db().collection("modelScores").get();
  const deletable = snap.docs.filter((doc) => !known.has(doc.id));

  await Promise.all(deletable.map((doc) => doc.ref.delete()));

  return NextResponse.json({ ok: true, deletedCount: deletable.length, deletedIds: deletable.map((d) => d.id) });
}

