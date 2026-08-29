import { NextResponse } from "next/server";
import { db } from "../../../../lib/firebaseAdmin.js";

export const runtime = "nodejs";
export const maxDuration = 60;

// Fix for future-scale concern: requestLogs grows unbounded — every text/
// image/audio request adds a doc and nothing ever removes one. Left alone,
// this collection grows forever, making the admin/stats query (which reads
// the last N logs) progressively slower and costlier over months of use.
//
// This route deletes requestLogs older than RETENTION_DAYS. It's meant to
// be called on a schedule via Vercel Cron (see vercel.json's "crons" entry)
// rather than manually — Vercel sends a GET request with a
// CRON_SECRET-bearing Authorization header, which this route verifies so
// the endpoint can't be used to mass-delete logs by anyone who finds the URL.
const RETENTION_DAYS = 14;
const BATCH_SIZE = 400; // Firestore batch writes cap at 500 ops

export async function GET(req) {
  const authHeader = req.headers.get("authorization") || "";
  const expected = `Bearer ${process.env.CRON_SECRET}`;
  if (!process.env.CRON_SECRET || authHeader !== expected) {
    return NextResponse.json({ error: "Unauthorized." }, { status: 401 });
  }

  const cutoff = new Date(Date.now() - RETENTION_DAYS * 24 * 60 * 60 * 1000);
  let totalDeleted = 0;

  // Loop in batches until there's nothing left older than the cutoff, or we
  // hit a safety cap of 20 batches (8000 docs) in a single cron run — a
  // pathological backlog gets cleaned up over a few days' worth of runs
  // rather than risking a single run running past the function timeout.
  for (let i = 0; i < 20; i++) {
    const snap = await db().collection("requestLogs").where("createdAt", "<", cutoff).limit(BATCH_SIZE).get();
    if (snap.empty) break;

    const batch = db().batch();
    snap.forEach((doc) => batch.delete(doc.ref));
    await batch.commit();
    totalDeleted += snap.size;

    if (snap.size < BATCH_SIZE) break; // fewer than a full batch means we're caught up
  }

  // Same unbounded-growth issue applies to the cache/coalescer collections,
  // though at much smaller scale (they're meant to be short-lived). Firestore
  // TTL policies (set via the Console, documented in README) handle ongoing
  // cleanup automatically once configured — this is a one-time/manual-trigger
  // backstop for anyone who hasn't set the TTL policy up yet.
  let cacheDeleted = 0;
  const cacheSnap = await db().collection("responseCache").where("expiresAt", "<", new Date()).limit(BATCH_SIZE).get();
  if (!cacheSnap.empty) {
    const batch = db().batch();
    cacheSnap.forEach((doc) => batch.delete(doc.ref));
    await batch.commit();
    cacheDeleted = cacheSnap.size;
  }

  return NextResponse.json({
    ok: true,
    requestLogsDeleted: totalDeleted,
    cacheDeleted,
    cutoff: cutoff.toISOString(),
  });
}
