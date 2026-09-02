/**
 * Which way was the cube being held?
 *
 * A smart cube reports turns against its own centres and cannot see your hands, so the grip is
 * invisible — and a cross-down replay still has to choose one of four frames to face you, which
 * until now it did arbitrarily.
 *
 * It is recoverable, because solvers do not turn faces uniformly. Once the cross is built the
 * distribution is extremely peaked: **46% U, 37% R, and 0.02% B**. So a run of turns that reads
 * as B in the cube's frame is strong evidence the cube was rotated so that face was somewhere a
 * person can actually reach.
 *
 * ## What this is for, and what it is not
 *
 * Measured against corpus solves with their real rotations stripped out — simulating exactly what
 * a smart cube would have reported — picking one fixed grip per solve matches the grip actually
 * held longest **68% of the time**, against 94% for merely getting the down colour right.
 *
 * It is used only to choose the camera for replay, where the down colour is already known exactly
 * from segmentation and the choice is between four frames that differ solely in what faces you.
 * A wrong guess is a differently-rotated but still correct cross-down view, which costs the
 * viewer nothing. That is the whole reason this is safe to use.
 *
 * **It is deliberately not used to count rotations.** Tracking the grip move by move recovers
 * rotation counts at a correlation of only 0.46, with a typical error of ±1.5 against a mean of
 * 3.3 — so a rotation *score* built on this would be mostly inference noise, which is why A3
 * still leaves rotations unscored for a cube that cannot report them.
 */
import type { Move } from "@cubing-companion/engine";
import { Phase } from "@cubing-companion/analysis";
import type { Orientation } from "./orientation.ts";

/** The three stretches of a solve whose move distributions differ enough to be worth separating. */
export type PhaseGroup = "cross" | "f2l" | "lastLayer";

/**
 * How often a solver turns each face, by stage, named as *they* see it.
 *
 * Measured over 5,475 clean corpus reconstructions — which are written in the solver's own frame,
 * so the counts are already what a person would call the face they turned. Laplace-smoothed, so a
 * face nobody was recorded turning is unlikely rather than impossible.
 *
 * Regenerate by counting move families per phase over `data/corpus.jsonl`, excluding wide and
 * slice moves, which this model does not score.
 *
 * The stages really are this different, and getting it wrong matters: a first attempt at this
 * used the cross figures for the whole solve and inferred grips at chance, because it expected
 * a solver to keep turning D long after the cross was built.
 */
export const PHASE_FACE_SHARE: Readonly<Record<PhaseGroup, Readonly<Record<string, number>>>> = {
  // n = 32,061 turns
  cross: { U: 0.1774, D: 0.285, L: 0.0937, R: 0.2843, F: 0.1404, B: 0.0192 },
  // n = 155,615 turns. Note D and B: once the cross is down, nobody touches either.
  f2l: { U: 0.4608, D: 0.0083, L: 0.1378, R: 0.3684, F: 0.0245, B: 0.0002 },
  // n = 110,384 turns
  lastLayer: { U: 0.4421, D: 0.0348, L: 0.0253, R: 0.4079, F: 0.088, B: 0.002 },
};

/** Which distribution a phase draws from. */
export function phaseGroup(phase: Phase): PhaseGroup | null {
  if (phase === Phase.Cross) return "cross";
  if (phase === Phase.F2L1 || phase === Phase.F2L2 || phase === Phase.F2L3 || phase === Phase.F2L4) {
    return "f2l";
  }
  if (phase === Phase.OLL || phase === Phase.PLL) return "lastLayer";
  // An AUF is a single U turn by definition and says nothing about the grip.
  return null;
}

/** One turn, as the cube reported it, with the stage it belongs to. */
export interface GripObservation {
  /** The move's family in the recorded frame — `U`, `R`, and so on. */
  readonly face: string;
  readonly group: PhaseGroup;
}

/** Everything the model can weigh in, from a solve's spans. */
export function gripObservations(
  spans: readonly { readonly phase: Phase; readonly moves: readonly Move[] }[],
): GripObservation[] {
  const observations: GripObservation[] = [];
  for (const span of spans) {
    const group = phaseGroup(span.phase);
    if (group === null) continue;
    for (const move of span.moves) {
      // Rotations say nothing on their own, and wide and slice moves are not in the model.
      if (PHASE_FACE_SHARE[group][move.family] !== undefined) {
        observations.push({ face: move.family, group });
      }
    }
  }
  return observations;
}

/**
 * The candidate grip that best explains the turns, by total log-likelihood.
 *
 * Every candidate is scored over the whole solve and the best is taken — one fixed answer rather
 * than a path through changing grips. That is the estimate the evidence supports: a single hidden
 * value against a hundred-odd observations, where tracking it move by move would be twenty-four
 * states deep and, measured, no more useful for anything this feeds.
 *
 * Returns the first candidate when there is nothing to go on, so a solve with no usable turns
 * degrades to the caller's own ordering rather than to nothing.
 */
export function inferGrip(
  observations: readonly GripObservation[],
  candidates: readonly Orientation[],
): Orientation {
  if (candidates.length === 0) throw new RangeError("no candidate grips to choose between");
  if (observations.length === 0) return candidates[0]!;

  let best = candidates[0]!;
  let bestScore = -Infinity;
  for (const candidate of candidates) {
    let score = 0;
    for (const { face, group } of observations) {
      // What this turn would have been called, seen from this grip.
      const seen = candidate.rename[face];
      const share = seen === undefined ? undefined : PHASE_FACE_SHARE[group][seen];
      score += Math.log(share ?? Number.MIN_VALUE);
    }
    if (score > bestScore) {
      bestScore = score;
      best = candidate;
    }
  }
  return best;
}
