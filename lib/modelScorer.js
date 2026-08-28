import { db } from "./firebaseAdmin.js";
import { FieldValue } from "firebase-admin/firestore";

/**
 * Self-healing model scorer.
 *
 * Every model (provider+model pair) gets a rolling score in Firestore
 * ("modelScores" collection, doc id = `${provider}__${model}`). The score
 * reflects the recent success rate and average latency, so a model that
 * starts failing a lot (rate limits, outages, degraded quality via errors)
 * gets pushed to the back of its pool automatically — no manual
 * intervention needed. A model that recovers climbs back up over time.
 *
 * Score formula: successRate (0-1) over the last WINDOW_SIZE outcomes,
 * weighted heavily, latency as a tiebreaker. Range: 0 (unusable) to 100 (perfect).
 *
 * Bug fix: this used to be a single-sample exponential moving average with
 * DECAY = 0.85 — i.e. newScore = prevScore * 0.15 + outcomeScore * 0.85.
 * That meant ONE failure crashed a perfect 100 score down to 15 in a single
 * call, and a model could never really recover: even a run of successes
 * after a failure only climbed back to ~85 before the next inevitable
 * failure (free-tier APIs are flaky) crashed it again. In practice this
 * showed up as models sitting permanently near 0 after a handful of
 * transient errors, which defeats the whole "self-healing" premise — a
 * model having one bad request an hour ago shouldn't outweigh 20 good
 * requests since then.
 *
 * Fix: track the last WINDOW_SIZE outcomes (true/false) in a small rolling
 * buffer per model and score off their actual success rate, not a
 * heavily-recency-biased EMA. One failure among many successes now barely
 * moves the score; a model that's been failing consistently still drops
 * fast because most/all of the window is failures.
 */

const WINDOW_SIZE = 20; // how many recent outcomes the rolling score is based on

export async function recordModelOutcome({ provider, model, ok, latencyMs }) {
  const docId = `${provider}__${model}`.replace(/\//g, "-");
  const ref = db().collection("modelScores").doc(docId);

  await db().runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    const prev = snap.exists ? snap.data() : { recentOutcomes: [], avgLatencyMs: latencyMs, totalCalls: 0 };

    const recentOutcomes = [...(prev.recentOutcomes || []), ok].slice(-WINDOW_SIZE);
    const successRate = recentOutcomes.filter(Boolean).length / recentOutcomes.length;

    // Latency still uses a light EMA (0.3) — pure smoothing for a display
    // metric, not a health signal, so the crash/no-recovery problem above
    // doesn't apply to it the same way.
    const LATENCY_SMOOTHING = 0.3;
    const newAvgLatency = (prev.avgLatencyMs ?? latencyMs) * (1 - LATENCY_SMOOTHING) + latencyMs * LATENCY_SMOOTHING;

    tx.set(
      ref,
      {
        provider,
        model,
        recentOutcomes,
        score: Math.round(successRate * 10000) / 100, // 0-100, 2 decimal places
        avgLatencyMs: Math.round(newAvgLatency),
        totalCalls: FieldValue.increment(1),
        lastOutcome: ok ? "success" : "failure",
        updatedAt: FieldValue.serverTimestamp(),
      },
      { merge: true }
    );
  });
}

/**
 * Returns scores for a list of (provider, model) pairs, defaulting
 * unseen models to a neutral score of 80 so new models aren't unfairly
 * skipped before they've had a chance to run.
 */
export async function getScoresForModels(pairs) {
  const docIds = pairs.map((p) => `${p.provider}__${p.model}`.replace(/\//g, "-"));
  const scores = {};

  // Firestore getAll for batch reads.
  const refs = docIds.map((id) => db().collection("modelScores").doc(id));
  const snaps = await db().getAll(...refs);

  snaps.forEach((snap, i) => {
    const pair = pairs[i];
    const key = `${pair.provider}::${pair.model}`;
    scores[key] = snap.exists ? snap.data().score : 80;
  });

  return scores;
}

/**
 * Sorts a pool's model list by descending score (best-performing first).
 * Models with no history default to neutral (80) so they still get tried.
 */
export async function rankModelsByScore(modelList) {
  const scores = await getScoresForModels(modelList);
  return [...modelList].sort((a, b) => {
    const scoreA = scores[`${a.provider}::${a.model}`] ?? 80;
    const scoreB = scores[`${b.provider}::${b.model}`] ?? 80;
    return scoreB - scoreA;
  });
}
