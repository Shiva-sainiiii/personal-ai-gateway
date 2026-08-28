import { NextResponse } from "next/server";
import { requireAdmin } from "../../../../lib/auth.js";
import { db } from "../../../../lib/firebaseAdmin.js";
import { DAILY_FREE_LIMITS } from "../../../../lib/usageLimits.js";

export const runtime = "nodejs";

// GET /api/admin/stats — summary for the tracking dashboard:
// key counts per provider, active/cooldown/disabled breakdown, recent request logs.
export async function GET(req) {
  const auth = requireAdmin(req);
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
  const modelScores = modelScoresSnap.docs.map((doc) => ({ id: doc.id, ...doc.data() }));

  return NextResponse.json({
    byProvider,
    last24h: { success: successCount, failed: failCount, total: successCount + failCount },
    recentLogs,
    modelScores,
    usageByProvider,
    activeAccountsByProvider,
    dailyFreeLimits: DAILY_FREE_LIMITS,
  });
}

