/**
 * Why the model preferred a different pair.
 *
 * `PLAN.md` A5 asks for "interpretable features → plain-language reasons", and the interpretable
 * half is the harder one. Listing which feature values differ is easy and nearly useless: two
 * options usually differ in most of their features, and only one or two of those differences
 * actually moved the decision.
 *
 * So the attribution is local and counterfactual. Take the option you played and the option the
 * model preferred, give yours **one** of the model's feature values, and re-score. However much
 * of the gap that closes is what that feature was worth *here*. It is a small, honest question —
 * "would this alone have changed the answer?" — and the model answers it directly.
 *
 * Sampled over real disagreements, this picks out `cornerOnTop` again and again, which is what
 * the corpus measurement said it should: on decisions where move count ties, pros take the pair
 * with the reachable corner 89.9% of the time against 52.7% by chance.
 *
 * **Rank by the raw score delta, per decision.** Averaging each feature's *share* across many
 * decisions looks like the same thing and is not: a single swap can overshoot the gap, and the
 * average then crowns `backTurns`, whose permutation importance is ~0.005. Per-decision deltas
 * give the right answer; the tidy-looking aggregate is an artifact.
 */
import { PAIR_FEATURES, type PairFeature } from "./features.ts";
import type { ScoreFn } from "./rank.ts";

export interface Attribution {
  readonly feature: PairFeature;
  /** Score gained by giving your option this one value from the model's pick. */
  readonly delta: number;
  /** Share of the gap it closes. Capped at 1: a single feature cannot explain more than all. */
  readonly share: number;
  readonly yours: number;
  readonly theirs: number;
}

/**
 * What the model was reacting to, strongest first.
 *
 * One batched call: the two options plus one swapped variant per feature.
 */
export async function attribute(
  yours: readonly number[],
  theirs: readonly number[],
  score: ScoreFn,
): Promise<Attribution[]> {
  const rows: number[][] = [[...yours], [...theirs]];
  for (let i = 0; i < yours.length; i++) {
    const swapped = [...yours];
    swapped[i] = theirs[i]!;
    rows.push(swapped);
  }

  const scores = await score(rows);
  const mine = scores[0]!;
  const gap = scores[1]! - mine;
  // The model does not actually prefer theirs, so there is nothing to explain.
  if (!(gap > 0)) return [];

  return PAIR_FEATURES.map((feature, i) => {
    const delta = scores[i + 2]! - mine;
    return {
      feature,
      delta,
      share: Math.max(0, Math.min(1, delta / gap)),
      yours: yours[i]!,
      theirs: theirs[i]!,
    };
  })
    .filter((entry) => entry.delta > 0 && entry.yours !== entry.theirs)
    .sort((a, b) => b.delta - a.delta);
}

/** Both slots by name, for phrasing that can point at them. */
export interface Named {
  readonly yours: string;
  readonly theirs: string;
}

/**
 * How each feature reads in a sentence.
 *
 * One entry per feature, so a decision can never render an empty reason — a test asserts the map
 * is complete against `PAIR_FEATURES`. `stepIndex` and `openCount` are constant across the
 * options of a single decision and so can never be attributed, but they are phrased anyway rather
 * than left to throw if that ever stops being true.
 */
const PHRASINGS: Record<PairFeature, (a: Attribution, names: Named) => string> = {
  cornerOnTop: (a, n) =>
    a.theirs > a.yours
      ? `${n.theirs}'s corner was already up top where you can see it, while ${n.yours}'s was buried in a slot`
      : `${n.yours}'s corner was buried, and ${n.theirs}'s was not`,
  edgeOnTop: (a, n) =>
    a.theirs > a.yours
      ? `${n.theirs}'s edge was up top rather than stuck in a slot`
      : `${n.yours}'s edge was the one still in a slot`,
  cornerInOwnSlot: (a, n) =>
    a.theirs > a.yours
      ? `${n.theirs}'s corner was already home, only twisted`
      : `${n.yours}'s corner was sitting in the wrong slot`,
  edgeInOwnSlot: (a, n) =>
    a.theirs > a.yours
      ? `${n.theirs}'s edge was already home, only flipped`
      : `${n.yours}'s edge was in the wrong slot`,
  insertionLength: (a, n) =>
    a.theirs < a.yours
      ? `it goes in in ${a.theirs} moves against ${a.yours} for ${n.yours}`
      : `it costs ${a.theirs} moves to ${n.yours}'s ${a.yours}, and is still the one to take`,
  excessOverBest: (a) =>
    a.theirs < a.yours
      ? `it was the cheapest pair on the cube; yours cost ${a.yours} more`
      : `it was not the cheapest, by ${a.theirs} moves`,
  pairDistance: (a, n) =>
    a.theirs < a.yours
      ? `${n.theirs}'s two pieces were closer to being joined`
      : `${n.theirs}'s pieces were further apart, and it was still worth doing first`,
  logWays: (a, n) =>
    a.theirs < a.yours
      ? `there was one clear way to insert ${n.theirs}, rather than several to choose between`
      : `${n.theirs} could be inserted more ways, leaving room to pick a comfortable one`,
  backTurns: (a, n) =>
    a.theirs < a.yours
      ? `it needs no back-face turns, while ${n.yours} needs ${a.yours}`
      : `it needs ${a.theirs} back turns and is still the better pair`,
  adjacentToPrevious: (a, n) =>
    a.theirs > a.yours
      ? `${n.theirs} sits beside the pair you had just finished, so your hands were already there`
      : `it moves away from the pair you had just finished`,
  stepIndex: (a) => `it was pair ${a.theirs + 1} rather than pair ${a.yours + 1}`,
  openCount: (a) => `there were ${a.theirs} slots open rather than ${a.yours}`,
};

/** One reason, in words. */
export function phrase(attribution: Attribution, names: Named): string {
  return PHRASINGS[attribution.feature](attribution, names);
}

/**
 * The reasons worth showing — at most two.
 *
 * A third reason is almost always a feature that moved the score a little and would move a
 * reader not at all. Anything under a twentieth of the gap is noise dressed as insight.
 */
export function reasons(
  attributions: readonly Attribution[],
  names: Named,
  limit = 2,
): string[] {
  return attributions
    .filter((entry) => entry.share > 0.05)
    .slice(0, limit)
    .map((entry) => phrase(entry, names));
}

/**
 * How firmly to put it.
 *
 * The model agrees with a pro's actual choice 69.6% of the time. That is a good ranker and a poor
 * oracle, so nothing here is allowed to say "you should have". The wording tracks the model's own
 * confidence, and where it is nearly split it says so instead of inventing a winner.
 */
export function confidenceWording(confidence: number): string {
  if (confidence >= 0.6) return "would most likely take";
  if (confidence >= 0.4) return "would more often take";
  return "leans slightly towards";
}
