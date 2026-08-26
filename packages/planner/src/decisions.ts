/**
 * The moments in a solve where a solver actually chose something.
 *
 * Used twice, and that is the point. `scripts/build-dataset.ts` calls this to build B3's training
 * data from corpus solves; A5's diff calls it to ask what a user chose in their own solve. If the
 * two assembled decisions even slightly differently, the model would be scoring inputs unlike the
 * ones it learned from — and nothing would fail. The advice would just quietly get worse.
 *
 * The same reasoning that keeps `features.ts` as the only definition of a feature keeps this as
 * the only definition of a decision.
 */
import {
  applyMoves,
  normalizeOrientation,
  type CubeState,
  type Face,
  type Move,
} from "@cubing-companion/engine";
import {
  GEOMETRY,
  isSlotSolved,
  Phase,
  slotName,
  type CrossGeometry,
  type PhaseSpan,
  type Slot,
} from "@cubing-companion/analysis";
import { crossDistance, enumerateF2LInsertion } from "@cubing-companion/solver";
import { pairFeatures, type PairCandidateInput } from "./features.ts";

/**
 * Enough optimal insertions to make `logWays` informative without an exhaustive sweep.
 *
 * Part of the model's input contract rather than a tuning knob: the training data was built with
 * this cap, so changing it shifts a feature the model was fitted against.
 */
export const WAYS_CAP = 60;

const F2L_PHASES = [Phase.F2L1, Phase.F2L2, Phase.F2L3, Phase.F2L4];

export interface PairOption extends PairCandidateInput {
  readonly name: string;
  readonly features: readonly number[];
}

/** One "which pair next" decision, with what was actually done. */
export interface PairDecision {
  /** 0 for the first pair, 1 for the second, 2 for the third. */
  readonly step: number;
  /** Move index in the solution where this decision was acted on. */
  readonly at: number;
  /** The position it was made from — normalised, cross up. */
  readonly state: CubeState;
  readonly options: readonly PairOption[];
  /** Index into `options` of the slot they actually filled. */
  readonly chosen: number;
  /** Moves they actually used to fill it, for comparing execution against the optimum. */
  readonly playedMoves: readonly Move[];
}

/**
 * Every pair-order decision in a segmented solve, in order.
 *
 * Returns nothing rather than a partial list when the solve cannot be read cleanly — a
 * segmentation that lost track of the cross produces positions that are not what they claim to
 * be, and a diff built on those would be confidently wrong.
 *
 * The fourth pair is never included: by then one slot remains and there is no decision to make.
 */
export function pairDecisions(
  start: CubeState,
  solution: readonly Move[],
  spans: readonly PhaseSpan[],
  crossFace: Face,
): PairDecision[] {
  const geometry: CrossGeometry = GEOMETRY[crossFace]!;
  const bySlotName = new Map<string, Slot>(geometry.slots.map((s) => [slotName(s), s]));
  const phases = F2L_PHASES.map((phase) => spans.find((span) => span.phase === phase));
  if (!phases.every((span) => span?.slot)) return [];

  const decisions: PairDecision[] = [];
  for (let step = 0; step < 3; step++) {
    const span = phases[step]!;
    const state = normalizeOrientation(applyMoves(start, solution.slice(0, span.start)));
    if (crossDistance(state, crossFace) !== 0) break;

    const open = geometry.slots.filter((slot) => !isSlotSolved(state, slot));
    if (open.length !== 4 - step) break;
    const chosenSlot = bySlotName.get(span.slot!);
    if (!chosenSlot || !open.includes(chosenSlot)) break;

    const searched = open.map((slot) => {
      const result = enumerateF2LInsertion(state, crossFace, slot, { maxSolutions: WAYS_CAP });
      return {
        slot,
        optimal: result.optimal,
        ways: result.candidates.length,
        bestMoves: result.candidates[0]?.moves ?? [],
      };
    });
    // A slot the search could not reach makes the whole decision unusable: the model would be
    // comparing against an option whose cost is unknown.
    if (searched.some((option) => option.optimal < 0)) break;

    const bestLength = Math.min(...searched.map((option) => option.optimal));
    const previous = step > 0 ? (bySlotName.get(phases[step - 1]!.slot!) ?? null) : null;

    decisions.push({
      step,
      at: span.start,
      state,
      chosen: searched.findIndex((option) => option.slot === chosenSlot),
      playedMoves: [...span.moves],
      options: searched.map((candidate) => ({
        ...candidate,
        name: slotName(candidate.slot),
        features: pairFeatures(state, geometry, candidate, {
          bestLength,
          previous,
          step,
          openCount: open.length,
        }),
      })),
    });
  }

  return decisions;
}

/** What the solver did for the cross, and what the search says was available. */
export interface CrossDecision {
  readonly at: number;
  readonly end: number;
  /** The scrambled position, normalised. */
  readonly state: CubeState;
  /** Turns they spent, rotations excluded. */
  readonly played: number;
  readonly playedMoves: readonly Move[];
  readonly optimal: number;
}

/** The cross, which needs no labelling: the comparison is length against the optimum. */
export function crossDecision(
  start: CubeState,
  solution: readonly Move[],
  spans: readonly PhaseSpan[],
  crossFace: Face,
  optimal: number,
): CrossDecision | null {
  const span = spans.find((s) => s.phase === Phase.Cross);
  if (!span || span.end === span.start) return null;
  return {
    at: span.start,
    end: span.end,
    state: normalizeOrientation(applyMoves(start, solution.slice(0, span.start))),
    played: span.turns,
    playedMoves: [...span.moves],
    optimal,
  };
}
