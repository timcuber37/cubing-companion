/**
 * Exact optimal-distance table for the cross.
 *
 * The cross is small enough that searching it is unnecessary. Four edges across twelve slots
 * with two orientations each is `12P4 × 2⁴ = 190,080` reachable positions — a complete
 * breadth-first sweep from solved gives the *exact* optimal distance for every one of them.
 * `PLAN.md` called for IDA* with pruning tables; for the cross the table simply is the answer,
 * and solutions come from walking down it.
 *
 * The table doubles as an admissible heuristic for the xcross search, where search is genuinely
 * needed: a position six moves from a finished cross is at least six from a finished xcross.
 *
 * Two facts the tests pin, because they are checkable against the outside world: the reachable
 * count is exactly 190,080, and the maximum distance is **8** — the published God's number for
 * the cross in HTM.
 */
import {
  applyMoves,
  CubeState,
  normalizeOrientation,
  type Face,
} from "@cubing-companion/engine";
import { GEOMETRY } from "@cubing-companion/analysis";
import { SEARCH_MOVES } from "./moves.ts";

export const INDEX_SPACE = 12 * 12 * 12 * 12 * 16;
export const REACHABLE_CROSS_POSITIONS = 190_080;
/** Distance of the hardest cross in HTM. */
export const MAX_CROSS_DISTANCE = 8;

export const UNREACHABLE = 255;

/**
 * How each move moves and flips edges, by slot.
 *
 * `EDGE_TO[m][from]` is the slot an edge at `from` lands in; `EDGE_FLIP[m][from]` is whether it
 * is flipped on the way. Derived from the engine rather than tabulated by hand — applying a
 * move to a solved cube says exactly this.
 *
 * This is what makes the whole file fast: the search transitions four integers instead of
 * applying moves to 46-byte cube states, which turns a two-second table build into a brisk one
 * and keeps the xcross search allocation-free.
 */
const EDGE_TO: readonly Uint8Array[] = SEARCH_MOVES.map((move) => {
  const after = applyMoves(CubeState.solved(), [move]);
  const to = new Uint8Array(12);
  // `ep[i] === j` means slot `i` now holds what was at slot `j`, so `j` travelled to `i`.
  for (let i = 0; i < 12; i++) to[after.ep[i]!] = i;
  return to;
});

const EDGE_FLIP: readonly Uint8Array[] = SEARCH_MOVES.map((move) => {
  const after = applyMoves(CubeState.solved(), [move]);
  const flip = new Uint8Array(12);
  for (let i = 0; i < 12; i++) flip[after.ep[i]!] = after.eo[i]!;
  return flip;
});

/** Pack four (slot, orientation) pairs into one index. */
export function packCross(
  slots: readonly number[],
  orientations: readonly number[],
): number {
  let position = 0;
  let orientation = 0;
  for (let i = 0; i < 4; i++) {
    position = position * 12 + slots[i]!;
    orientation = orientation * 2 + orientations[i]!;
  }
  return position * 16 + orientation;
}

/** The inverse of {@link packCross}, writing into caller-supplied arrays. */
export function unpackCross(
  index: number,
  slots: Uint8Array,
  orientations: Uint8Array,
): void {
  let orientation = index % 16;
  let position = (index - orientation) / 16;
  for (let i = 3; i >= 0; i--) {
    slots[i] = position % 12;
    position = (position - slots[i]!) / 12;
    orientations[i] = orientation % 2;
    orientation = (orientation - orientations[i]!) / 2;
  }
}

/** Apply a move to a packed cross position. */
export function stepCross(index: number, moveIndex: number): number {
  const to = EDGE_TO[moveIndex]!;
  const flip = EDGE_FLIP[moveIndex]!;
  let orientation = index % 16;
  let position = (index - orientation) / 16;

  const slots = [0, 0, 0, 0];
  const orientations = [0, 0, 0, 0];
  for (let i = 3; i >= 0; i--) {
    slots[i] = position % 12;
    position = (position - slots[i]!) / 12;
    orientations[i] = orientation % 2;
    orientation = (orientation - orientations[i]!) / 2;
  }

  let nextPosition = 0;
  let nextOrientation = 0;
  for (let i = 0; i < 4; i++) {
    const from = slots[i]!;
    nextPosition = nextPosition * 12 + to[from]!;
    nextOrientation = nextOrientation * 2 + (orientations[i]! ^ flip[from]!);
  }
  return nextPosition * 16 + nextOrientation;
}

export interface CrossTable {
  readonly crossFace: Face;
  /** The four edge pieces forming this cross. */
  readonly edges: readonly number[];
  /** Optimal distance for every position; {@link UNREACHABLE} where there is none. */
  readonly distance: Uint8Array;
  readonly solvedIndex: number;
}

/**
 * Index the cross position of an already-normalised state.
 *
 * The search only ever applies face turns, and face turns do not permute centres — so a state
 * normalised once stays normalised, and the hot path can skip re-normalising entirely.
 */
export function crossIndexNormalised(
  state: CubeState,
  edges: readonly number[],
): number {
  const slots = [0, 0, 0, 0];
  const orientations = [0, 0, 0, 0];
  for (let i = 0; i < 4; i++) {
    const piece = edges[i]!;
    for (let s = 0; s < 12; s++) {
      if (state.ep[s] === piece) {
        slots[i] = s;
        orientations[i] = state.eo[s]!;
        break;
      }
    }
  }
  return packCross(slots, orientations);
}

/** Index the cross position of a state in any orientation. */
export function crossIndexOf(
  state: CubeState,
  edges: readonly number[],
): number {
  return crossIndexNormalised(normalizeOrientation(state), edges);
}

function build(crossFace: Face): CrossTable {
  const edges = GEOMETRY[crossFace]!.crossEdges;
  const distance = new Uint8Array(INDEX_SPACE).fill(UNREACHABLE);

  const solvedIndex = crossIndexNormalised(CubeState.solved(), edges);
  distance[solvedIndex] = 0;

  let frontier = [solvedIndex];
  let depth = 0;
  while (frontier.length > 0) {
    const next: number[] = [];
    for (const index of frontier) {
      for (let m = 0; m < SEARCH_MOVES.length; m++) {
        const child = stepCross(index, m);
        if (distance[child] !== UNREACHABLE) continue;
        distance[child] = depth + 1;
        next.push(child);
      }
    }
    frontier = next;
    depth++;
  }

  return { crossFace, edges, distance, solvedIndex };
}

const cache = new Map<Face, CrossTable>();

/**
 * The table for a cross colour, built on first use and kept.
 *
 * Per colour rather than all six up front: most solvers use one, and paying for the other five
 * would be waste.
 */
export function crossTable(crossFace: Face): CrossTable {
  let table = cache.get(crossFace);
  if (!table) {
    table = build(crossFace);
    cache.set(crossFace, table);
  }
  return table;
}

/** Optimal number of moves to finish this cross, from a state in any orientation. */
export function crossDistance(state: CubeState, crossFace: Face): number {
  const table = crossTable(crossFace);
  return table.distance[crossIndexOf(state, table.edges)]!;
}
