import { NextResponse } from "next/server";
import { requireAdmin } from "../../../../lib/auth.js";
import { db } from "../../../../lib/firebaseAdmin.js";

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
  last24hSnap.forEach((doc) => {
    if (doc.data().ok) successCount += 1;
    else failCount += 1;
  });

  return NextResponse.json({
    byProvider,
    last24h: { success: successCount, failed: failCount, total: successCount + failCount },
    recentLogs,
  });
}
