/**
 * Feature extraction — defined here once, and nowhere else.
 *
 * These same functions build the training set and run at inference. That is deliberate and it is
 * the single most important property of this file: if features were computed one way in the
 * dataset builder and another way in the browser, the model would not break loudly, it would just
 * be quietly mediocre forever. Python never sees a cube — it receives numbers produced by this
 * code and returns weights.
 *
 * The order of {@link PAIR_FEATURES} and {@link CROSS_FEATURES} is part of the model contract. A
 * reordering silently permutes the input layer, so both lists are exported and asserted against
 * the vector length in tests.
 */
import { Face, type CubeState, type Move } from "@cubing-companion/engine";
import type { CrossGeometry, Slot } from "@cubing-companion/analysis";
import { slotName } from "@cubing-companion/analysis";
import { pairDistance } from "@cubing-companion/solver";
import { comfortScore, FACE_SHARE } from "./comfort.ts";

/**
 * What the pair-order model sees about one candidate slot.
 *
 * Measured over 1,117 real decisions before any of this was written: on the ~29% where two slots
 * tie on insertion length, the pro takes the one whose **corner is in the last layer** 89.9% of
 * the time against 52.7% by chance. The edge, on its own, is noise (+7.2, inside the error bar).
 * That asymmetry is why the corner and edge get separate features rather than one "pieces are
 * accessible" flag: a move count already prices extraction, but not the cost of not being able to
 * *see* the pair.
 */
export const PAIR_FEATURES = [
  /** Optimal moves to insert this pair, preserving the cross and everything already built. */
  "insertionLength",
  /** How much longer than the cheapest option — what a movecount ranker would use alone. */
  "excessOverBest",
  /** Lower bound ignoring the rest of the cube; separates "far" from "awkwardly placed". */
  "pairDistance",
  /** How many optimal insertions exist. Measured lift is −11.0: *more* ways means less likely. */
  "logWays",
  "cornerOnTop",
  /** Home but twisted — a different situation from buried under another pair. */
  "cornerInOwnSlot",
  "edgeOnTop",
  "edgeInOwnSlot",
  /** Back turns in the cheapest insertion. No measurable lift alone; kept for interactions. */
  "backTurns",
  "adjacentToPrevious",
  "stepIndex",
  "openCount",
] as const;

export type PairFeature = (typeof PAIR_FEATURES)[number];

/** What the caller has already searched for. Kept outside so one search serves both uses. */
export interface PairCandidateInput {
  readonly slot: Slot;
  /** From `enumerateF2LInsertion(...).optimal`. */
  readonly optimal: number;
  /** From `.candidates.length` — how many ways there are at that length. */
  readonly ways: number;
  /** The cheapest insertion's moves, for counting awkward turns. */
  readonly bestMoves: readonly Move[];
}

export interface PairContext {
  /** Cheapest insertion length across all open slots, for the relative feature. */
  readonly bestLength: number;
  /** The slot filled immediately before, or null at the first pair. */
  readonly previous: Slot | null;
  /** 0 for the first pair, 1 for the second, 2 for the third. */
  readonly step: number;
  readonly openCount: number;
}

const positionOf = (piece: number, permutation: Uint8Array): number => {
  for (let i = 0; i < permutation.length; i++) if (permutation[i] === piece) return i;
  return -1;
};

/** Two slots are adjacent when they share a side face — `FR` and `FL` both sit at the front. */
export function slotsAdjacent(a: Slot, b: Slot): boolean {
  const other = slotName(b);
  return [...slotName(a)].some((face) => other.includes(face));
}

/**
 * One candidate slot as a feature vector.
 *
 * `state` must be normalised — piece positions are read against home slots, which only means
 * anything in the normalised frame.
 */
export function pairFeatures(
  state: CubeState,
  geometry: CrossGeometry,
  candidate: PairCandidateInput,
  context: PairContext,
): number[] {
  const cornerAt = positionOf(candidate.slot.corner, state.cp);
  const edgeAt = positionOf(candidate.slot.edge, state.ep);

  const vector = [
    candidate.optimal,
    candidate.optimal - context.bestLength,
    pairDistance(state, candidate.slot),
    Math.log1p(candidate.ways),
    geometry.llCorners.includes(cornerAt) ? 1 : 0,
    cornerAt === candidate.slot.corner ? 1 : 0,
    geometry.llEdges.includes(edgeAt) ? 1 : 0,
    edgeAt === candidate.slot.edge ? 1 : 0,
    candidate.bestMoves.filter((move) => move.family === "B").length,
    context.previous !== null && slotsAdjacent(candidate.slot, context.previous) ? 1 : 0,
    context.step,
    context.openCount,
  ];

  if (vector.length !== PAIR_FEATURES.length) {
    throw new Error(`pair feature vector is ${vector.length}, expected ${PAIR_FEATURES.length}`);
  }
  return vector;
}

/**
 * What the cross model sees about one candidate — a solution *and* the frame it is turned in.
 *
 * The candidate is the pair, not just the sequence. A4 established that choosing how to hold the
 * cube is the dominant decision (it predicts the pro's actual grip 79.4% of the time against 25%
 * chance), so a model that ranked sequences while ignoring frames would be modelling the smaller
 * half of the choice. Every feature below is therefore computed on the moves **as they would be
 * turned in that frame**, which is what makes the same solution score differently held two ways.
 */
export const CROSS_FEATURES = [
  "length",
  /** A4's unigram comfort score, as a strong prior the model can improve on or ignore. */
  "comfort",
  "turnsU",
  "turnsD",
  "turnsL",
  "turnsR",
  "turnsF",
  "turnsB",
  "halfTurns",
  /** How many different faces are involved — a proxy for how much regripping it needs. */
  "distinctFaces",
  /** A final D turn is the cross being squared up, and pros do it constantly. */
  "endsOnDown",
  /** Consecutive turns on the same axis, which chain into one another comfortably. */
  "sameAxisPairs",
] as const;

export type CrossFeature = (typeof CROSS_FEATURES)[number];

const AXIS: Readonly<Record<string, string>> = {
  U: "y",
  D: "y",
  L: "x",
  R: "x",
  F: "z",
  B: "z",
};

/** One cross solution, in the frame it would be turned, as a feature vector. */
export function crossFeatures(moves: readonly Move[]): number[] {
  const count = (family: string) => moves.filter((move) => move.family === family).length;

  let sameAxisPairs = 0;
  for (let i = 1; i < moves.length; i++) {
    if (AXIS[moves[i]!.family] === AXIS[moves[i - 1]!.family]) sameAxisPairs++;
  }

  const vector = [
    moves.length,
    comfortScore(moves),
    count("U"),
    count("D"),
    count("L"),
    count("R"),
    count("F"),
    count("B"),
    moves.filter((move) => move.amount === 2).length,
    new Set(moves.map((move) => move.family)).size,
    moves.length > 0 && moves[moves.length - 1]!.family === "D" ? 1 : 0,
    sameAxisPairs,
  ];

  if (vector.length !== CROSS_FEATURES.length) {
    throw new Error(`cross feature vector is ${vector.length}, expected ${CROSS_FEATURES.length}`);
  }
  return vector;
}

/** Guards against a face appearing in one list and not the other. */
export const MODELLED_FACES = Object.keys(FACE_SHARE) as readonly string[];
export const CROSS_FACES: readonly Face[] = [
  Face.U,
  Face.L,
  Face.F,
  Face.R,
  Face.B,
  Face.D,
];
