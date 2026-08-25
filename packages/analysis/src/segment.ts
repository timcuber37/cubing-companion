/**
 * CFOP phase segmentation from cube state.
 *
 * Input-agnostic by construction: it takes a scramble and a move list, and never learns
 * whether they came from a smart cube, a pasted reconstruction, or a file. That is the
 * boundary `PLAN.md` asks for, and it is why this package depends on the engine alone.
 *
 * The ordering of the algorithm matters, and was arrived at by measuring against the
 * corpus rather than by reasoning alone:
 *
 * - Identifying the **cross colour first, from F2L completion**, then finding the cross,
 *   rather than the other way round. Looking for the cross first is ambiguous — several
 *   faces' crosses are incidentally complete at various points — while "exactly one face's
 *   layer is left unsolved" happens once and means one thing.
 * - Never scanning *backwards* from the solved state. Last-layer algorithms transiently
 *   break the cross, so a backward scan stops inside OLL. An earlier attempt at this scored
 *   0% against the corpus labels.
 */
import {
  applyMoveInPlace,
  applyMoves,
  CubeState,
  Face,
  isSolvedIgnoringOrientation,
  normalizeOrientation,
  type Move,
} from "@cubing-companion/engine";
import { GEOMETRY, slotName, type CrossGeometry, type Slot } from "./geometry.ts";
import {
  alignCross,
  crossOffset,
  isF2LComplete,
  isLastLayerOriented,
  isSlotSolved,
  isSolvedIgnoringAUF,
} from "./phases.ts";
import {
  Phase,
  type PhaseSpan,
  type SegmentationResult,
  type SolveSegmentation,
} from "./types.ts";

const ROTATIONS = new Set(["x", "y", "z"]);
const isRotation = (move: Move) => ROTATIONS.has(move.family);

export interface SegmentOptions {
  /**
   * Whether a rotation sitting between two phases belongs to the phase that just ended.
   *
   * True by default, matching how reconstructors write them, which keeps per-phase rotation
   * counts comparable with the pro corpus. Setting this false puts the boundary at the
   * state change instead, treating such a rotation as setup for what follows.
   */
  readonly trailingRotationsEndPhase?: boolean;
}

/**
 * Replay a solution, normalising orientation at every step.
 *
 * Computed once and reused for all six candidate cross colours: the trace does not depend
 * on which colour we are testing, only the predicates do. Normalising is the expensive part,
 * so doing it once rather than six times matters over thousands of solves.
 */
function normalisedTrace(
  scrambled: CubeState,
  moves: readonly Move[],
): CubeState[] {
  const trace: CubeState[] = [];
  const running = scrambled.clone();
  trace.push(normalizeOrientation(running));
  for (const move of moves) {
    applyMoveInPlace(running, move);
    trace.push(normalizeOrientation(running));
  }
  return trace;
}

/** First index satisfying `predicate`, or `-1`. */
function firstIndex(
  trace: readonly CubeState[],
  predicate: (state: CubeState) => boolean,
  from = 0,
): number {
  for (let i = from; i < trace.length; i++) {
    if (predicate(trace[i]!)) return i;
  }
  return -1;
}

/**
 * Work out which colour the cross was on.
 *
 * Tries all six and takes the one whose F2L completes earliest. Ties cannot happen in
 * practice — F2L completion for two different colours at the same instant would mean the
 * cube was solved — but the earliest wins regardless.
 */
function findCrossFace(
  trace: readonly CubeState[],
): { geometry: CrossGeometry; f2lIndex: number } | null {
  let best: { geometry: CrossGeometry; f2lIndex: number } | null = null;
  for (const geometry of GEOMETRY) {
    const index = firstIndex(trace, (s) => isF2LComplete(s, geometry));
    if (index === -1) continue;
    if (best === null || index < best.f2lIndex) best = { geometry, f2lIndex: index };
  }
  return best;
}

/** Extend a boundary forward across rotations, so they attach to the phase just ended. */
function absorbTrailingRotations(
  moves: readonly Move[],
  boundary: number,
  limit: number,
): number {
  let end = boundary;
  while (end < limit && isRotation(moves[end]!)) end++;
  return end;
}

function makeSpan(
  phase: Phase,
  start: number,
  end: number,
  moves: readonly Move[],
  slot?: Slot,
): PhaseSpan {
  const span = moves.slice(start, end);
  const rotations = span.filter(isRotation).length;
  return {
    phase,
    start,
    end,
    moves: span,
    turns: span.length - rotations,
    rotations,
    ...(slot ? { slot: slotName(slot) } : {}),
  };
}

/**
 * Segment a solve into CFOP phases.
 *
 * @param scramble moves that produced the starting position.
 * @param solution the solve itself.
 */
export function segmentSolve(
  scramble: readonly Move[],
  solution: readonly Move[],
  options: SegmentOptions = {},
): SegmentationResult {
  return segmentFromState(applyMoves(CubeState.solved(), scramble), solution, options);
}

/**
 * Segment a solve from the position it actually started in.
 *
 * This is the entry point capture uses. A recorded solve knows the state the cube was in, not
 * the scramble somebody meant to apply — and those differ whenever the solver mis-scrambles,
 * adds a correcting turn, or holds the cube rotated so the same written moves reach a
 * conjugated position. The state is always true of the cube; the intended scramble often is
 * not.
 *
 * @param scrambled the position the solve began from.
 * @param solution the solve itself.
 */
export function segmentFromState(
  scrambled: CubeState,
  solution: readonly Move[],
  options: SegmentOptions = {},
): SegmentationResult {
  const { trailingRotationsEndPhase = true } = options;

  const final = applyMoves(scrambled, solution);
  if (!isSolvedIgnoringOrientation(final)) {
    return {
      segmentation: null,
      failure: "does-not-solve",
      detail: "scramble + solution does not reach a solved cube",
    };
  }

  const trace = normalisedTrace(scrambled, solution);
  const found = findCrossFace(trace);
  if (found === null) {
    return {
      segmentation: null,
      failure: "no-f2l-found",
      detail: "no cross colour reached a completed F2L",
    };
  }
  const { geometry, f2lIndex } = found;
  const crossFace = geometry.crossFace;

  // Two candidate cross boundaries: the first point the cross is *built at all* (offset
  // allowed) and the first point it is built *and aligned*.
  const builtIndex = firstIndex(trace, (s) => crossOffset(s, geometry) !== null);
  if (builtIndex === -1) {
    return { segmentation: null, failure: "no-cross-found", detail: null };
  }
  const alignedIndex = firstIndex(trace, (s) => crossOffset(s, geometry) === 0);

  // Each slot independently: no assumption about solve order, which is what makes keyhole
  // and out-of-order insertions fall out rather than needing special handling.
  const slotCompletion = geometry.slots.map((slot) => {
    const index = firstIndex(
      trace,
      (state) => {
        const aligned = alignCross(state, geometry);
        return aligned !== null && isSlotSolved(aligned, slot);
      },
      builtIndex,
    );
    return { slot, index: index === -1 ? f2lIndex : index };
  });
  slotCompletion.sort((a, b) => a.index - b.index);

  // Choosing between them is the pseudoslotting question, and it turns on one thing: was a
  // pair inserted while the cross was still offset?
  //
  // Most solvers build the cross efficiently and square it with a final turn of the cross
  // layer. For them the alignment is part of building the cross, and taking the earlier
  // boundary would end the phase a move early — which cost ~45 points of agreement when
  // this was unconditional. A pseudoslotter, by contrast, deliberately works in the offset
  // frame and corrects later, so their cross really was finished at the earlier point.
  const alignPoint = alignedIndex === -1 ? f2lIndex : alignedIndex;
  const earliestPair = slotCompletion[0]?.index ?? f2lIndex;
  const workedOffset = earliestPair < alignPoint;
  const crossIndex = workedOffset ? builtIndex : alignPoint;

  // "Free" pairs are those already standing when the cross is finished *and squared up*.
  //
  // Measured at the alignment point rather than at `crossIndex` on purpose. An xcross is
  // conventionally one block — cross and first pair built together — and within that block
  // the cross is very often left a turn out of place and aligned as the pair goes in. Asking
  // whether the pair was done at the earlier, still-offset boundary would answer a much
  // narrower question ("did the very same move finish both?") and undercount xcrosses
  // roughly threefold against how the corpus labels them.
  const freePairs = slotCompletion.filter((s) => s.index <= alignPoint).length;

  // Reported as a plain fact rather than an inference: the cross phase ended with the cross
  // still offset. That overlaps heavily with xcross, because building a cross offset and
  // squaring it during the first pair is exactly how many xcrosses are executed.
  const crossOffsetAtEnd = crossOffset(trace[crossIndex]!, geometry) ?? 0;
  const pseudoCross = crossOffsetAtEnd !== 0;

  const ollIndex = firstIndex(trace, (s) => isLastLayerOriented(s, geometry), f2lIndex);
  const pllIndex = firstIndex(
    trace,
    (s) => isSolvedIgnoringAUF(s, geometry),
    ollIndex === -1 ? f2lIndex : ollIndex,
  );

  // Boundaries, which come out in order by construction rather than by clamping:
  //
  // - no slot can complete before `crossIndex`, because a slot completing before the cross
  //   is squared up is precisely what makes `workedOffset` true and moves the boundary back
  //   to `builtIndex`;
  // - slot completions are sorted, and none can exceed `f2lIndex`, since every slot is
  //   solved there by definition;
  // - `ollIndex` is searched from `f2lIndex` and `pllIndex` from `ollIndex`.
  //
  // Clamping them into order would turn a violation of that reasoning into a silently empty
  // span instead of a visible fault, so it is left out; the partition property test asserts
  // no span runs backwards.
  const boundaries = [
    crossIndex,
    ...slotCompletion.map((s) => s.index),
    ollIndex === -1 ? f2lIndex : ollIndex,
    pllIndex === -1 ? solution.length : pllIndex,
    solution.length,
  ];

  const adjusted = trailingRotationsEndPhase
    ? boundaries.map((boundary, i) =>
        // The last boundary is the end of the solve; nothing follows to absorb.
        i === boundaries.length - 1
          ? boundary
          : absorbTrailingRotations(solution, boundary, boundaries[i + 1] ?? solution.length),
      )
    : boundaries;

  const phases = [
    Phase.Cross,
    Phase.F2L1,
    Phase.F2L2,
    Phase.F2L3,
    Phase.F2L4,
    Phase.OLL,
    Phase.PLL,
    Phase.AUF,
  ];
  const spans: PhaseSpan[] = [];
  let start = 0;
  phases.forEach((phase, i) => {
    // No clamping here: `boundaries` was already made monotonic above, which is what
    // guarantees the spans partition the move list. Re-clamping would hide a broken
    // boundary calculation behind a silently-empty span.
    const end = adjusted[i] ?? solution.length;
    const slot = i >= 1 && i <= 4 ? slotCompletion[i - 1]?.slot : undefined;
    spans.push(makeSpan(phase, start, end, solution, slot));
    start = end;
  });

  // A skip is "no turns happened", not "the span is empty". Under the trailing-rotation
  // convention a skipped OLL can still absorb the rotation that preceded it, leaving a
  // one-move span that did no work — which an emptiness test would miss.
  const skips = spans.filter((s) => s.turns === 0).map((s) => s.phase);
  const totalRotations = solution.filter(isRotation).length;

  return {
    segmentation: {
      crossFace,
      spans,
      xcross: freePairs >= 1,
      freePairs,
      pseudoCross,
      crossOffsetAtEnd,
      skips,
      totalTurns: solution.length - totalRotations,
      totalRotations,
    },
    failure: null,
    detail: null,
  };
}
