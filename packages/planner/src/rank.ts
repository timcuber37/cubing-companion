/**
 * Learned ranking — the inference side of B3.
 *
 * Deliberately knows nothing about ONNX, `fetch`, or where weights come from. It takes a
 * {@link ScoreFn} and applies it to feature vectors built by `features.ts`. That keeps the model
 * out of the pure packages entirely: the worker in `apps/web` owns the runtime and hands a
 * closure in, and every test here runs against a stub with no WASM in sight.
 *
 * If no model is supplied, ranking falls back to what A4 already does — shortest first, comfort
 * breaking ties. A missing or failed model download degrades the advice; it never removes it.
 */
import { Face, type CubeState } from "@cubing-companion/engine";
import type { CrossGeometry, Slot } from "@cubing-companion/analysis";
import {
  crossFeatures,
  pairFeatures,
  type PairCandidateInput,
  type PairContext,
} from "./features.ts";
import { awkwardTurns, comfortScore } from "./comfort.ts";
import {
  orientationsWithColourDown,
  renameMoves,
  renameSlot,
  rotationBetween,
} from "./orientation.ts";
import type { PlannedSolution } from "./plan.ts";

/**
 * Scores a batch of options at once.
 *
 * Batched rather than one at a time because a session round-trip per candidate would dominate
 * the cost of scoring four of them, and because the model is a ranker: the scores are only
 * meaningful relative to the others in the same decision.
 */
export type ScoreFn = (rows: readonly (readonly number[])[]) => Promise<readonly number[]>;

export interface RankedSlot {
  readonly slot: Slot;
  readonly optimal: number;
  /** Model score. Higher is more like what a pro would do; comparable only within a decision. */
  readonly score: number;
  /** Softmax of the scores across this decision, so the UI can say how clear-cut it was. */
  readonly confidence: number;
  readonly features: readonly number[];
}

/** Softmax, shifted by the max so a large score cannot overflow before it is normalised. */
function softmax(scores: readonly number[]): number[] {
  const highest = Math.max(...scores);
  const exponentiated = scores.map((score) => Math.exp(score - highest));
  const total = exponentiated.reduce((a, b) => a + b, 0);
  return exponentiated.map((value) => value / total);
}

/**
 * Rank the open slots by which pair a pro would do next.
 *
 * The caller does the searching, so the same `enumerateF2LInsertion` results feed both the
 * features and whatever else the UI wants to show.
 */
export async function rankNextPair(
  state: CubeState,
  geometry: CrossGeometry,
  candidates: readonly PairCandidateInput[],
  context: Omit<PairContext, "bestLength" | "openCount">,
  score: ScoreFn,
): Promise<readonly RankedSlot[]> {
  if (candidates.length === 0) return [];

  const bestLength = Math.min(...candidates.map((candidate) => candidate.optimal));
  const rows = candidates.map((candidate) =>
    pairFeatures(state, geometry, candidate, {
      ...context,
      bestLength,
      openCount: candidates.length,
    }),
  );

  const scores = await score(rows);
  if (scores.length !== rows.length) {
    throw new Error(`model returned ${scores.length} scores for ${rows.length} options`);
  }
  const confidence = softmax([...scores]);

  return candidates
    .map((candidate, i) => ({
      slot: candidate.slot,
      optimal: candidate.optimal,
      score: scores[i]!,
      confidence: confidence[i]!,
      features: rows[i]!,
    }))
    .sort((a, b) => b.score - a.score);
}

/**
 * Re-rank cross candidates with the learned model, choosing the grip as well as the solution.
 *
 * A4 ranks by length, then by a unigram comfort score. B3's cross head beats that heuristic by
 * **9.6 points** on solvers it has never seen (48.7% against 39.0%), so where the model is
 * available it takes over the second half of that rule.
 *
 * The grip is re-decided too, not just the ordering. Comfort and the model disagree about how to
 * hold the cube often enough to matter, and the model was trained on (solution, grip) pairs
 * precisely because A4's measurements showed the grip is the larger half of the decision.
 *
 * Length still comes first. The model only ever compares candidates of equal length — which is
 * also the only thing it was trained on, every cross candidate in the training set being optimal.
 */
export async function rerankCross(
  solutions: readonly PlannedSolution[],
  score: ScoreFn,
  /** Centres of the state the plan was made from, so the re-picked grip gets a correct setup. */
  startCentres: ArrayLike<number>,
): Promise<readonly PlannedSolution[]> {
  if (solutions.length === 0) return solutions;

  // One flat batch across every (solution, grip) pair, so the model is called once.
  const rows: number[][] = [];
  const owner: { solution: PlannedSolution; frame: ReturnType<typeof orientationsWithColourDown>[number] }[] = [];
  for (const solution of solutions) {
    for (const frame of orientationsWithColourDown(solution.crossFace)) {
      rows.push(crossFeatures(renameMoves(solution.searchMoves, frame)));
      owner.push({ solution, frame });
    }
  }

  const scores = await score(rows);
  if (scores.length !== rows.length) {
    throw new Error(`model returned ${scores.length} scores for ${rows.length} options`);
  }

  const best = new Map<PlannedSolution, { score: number; index: number }>();
  for (const [i, entry] of owner.entries()) {
    const current = best.get(entry.solution);
    if (!current || scores[i]! > current.score) {
      best.set(entry.solution, { score: scores[i]!, index: i });
    }
  }

  return [...best]
    .map(([solution, winner]) => {
      const { frame } = owner[winner.index]!;
      const moves = renameMoves(solution.searchMoves, frame);
      const setup = rotationBetween(startCentres, frame.colourAt);
      return {
        ...solution,
        // Rename from the unrotated name, not from `slot` — that one has already been renamed
        // once into whichever grip comfort picked, and renaming it again would compose the two.
        ...(solution.searchSlot === undefined
          ? {}
          : { slot: renameSlot(solution.searchSlot, frame) }),
        setup,
        setupText: setup
          .map((m) => `${m.family}${m.amount === 2 ? "2" : m.amount === -1 ? "'" : ""}`)
          .join(" "),
        moves,
        text: moves
          .map((m) => `${m.family}${m.amount === 2 ? "2" : m.amount === -1 ? "'" : ""}`)
          .join(" "),
        hold: {
          down: frame.colourAt[Face.D]!,
          front: frame.colourAt[Face.F]!,
          rotation: frame.text,
        },
        comfort: comfortScore(moves),
        awkward: awkwardTurns(moves),
        modelScore: winner.score,
      };
    })
    .sort((a, b) => a.length - b.length || b.modelScore - a.modelScore);
}

/**
 * What "fewest moves wins" would say — the baseline B3 has to beat.
 *
 * Kept in the shipped code, not just in the eval script, so the UI can show both and so the
 * claim stays checkable after training is a distant memory.
 */
export function rankByMoveCount(
  candidates: readonly PairCandidateInput[],
): readonly PairCandidateInput[] {
  return [...candidates].sort((a, b) => a.optimal - b.optimal);
}
