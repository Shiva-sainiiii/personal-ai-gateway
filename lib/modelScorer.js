import { db } from "./firebaseAdmin.js";
import { FieldValue } from "firebase-admin/firestore";

/**
 * Self-healing model scorer.
 *
 * Every model (provider+model pair) gets a rolling score in Firestore
 * ("modelScores" collection, doc id = `${provider}__${model}`). The score
 * decays toward the recent success rate and average latency, so a model
 * that starts failing a lot (rate limits, outages, degraded quality via
 * errors) gets pushed to the back of its pool automatically — no manual
 * intervention needed. A model that recovers climbs back up over time.
 *
 * Score formula: successRate (0-1) weighted heavily, latency as a tiebreaker.
 * Range: 0 (unusable) to 100 (perfect).
 */

const DECAY = 0.85; // how much weight recent outcome carries vs history

export async function recordModelOutcome({ provider, model, ok, latencyMs }) {
  const docId = `${provider}__${model}`.replace(/\//g, "-");
  const ref = db().collection("modelScores").doc(docId);

  await db().runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    const prev = snap.exists ? snap.data() : { score: 80, avgLatencyMs: latencyMs, totalCalls: 0 };

    const outcomeScore = ok ? 100 : 0;
    const newScore = prev.score * (1 - DECAY) + outcomeScore * DECAY;
    const newAvgLatency = prev.avgLatencyMs * (1 - DECAY) + latencyMs * DECAY;

    tx.set(
      ref,
      {
        provider,
        model,
        score: Math.round(newScore * 100) / 100,
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
