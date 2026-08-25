/**
 * Distance table for one F2L pair, ignoring everything else on the cube.
 *
 * A corner across eight slots in three orientations, with an edge across twelve slots in two, is
 * 576 positions — every one reachable, with a maximum distance of 6. Small enough to build on
 * demand without noticing.
 *
 * Ignoring the rest of the cube is what makes it a *lower bound* rather than an answer: bringing
 * the pair home while leaving the cross standing can only cost more than bringing it home with a
 * free hand. That is exactly what an admissible heuristic needs to be, and it is used both for
 * the pair being inserted and for every pair that has to survive the insertion — restoring a
 * disturbed pair cannot cost less than its distance either.
 */
import { applyMoves, CubeState } from "@cubing-companion/engine";
import { isSlotSolved, type Slot } from "@cubing-companion/analysis";
import { SEARCH_MOVES } from "./moves.ts";

/** Corner slot × orientation × edge slot × orientation. */
export const PAIR_INDEX_SPACE = 8 * 3 * 12 * 2;
export const MAX_PAIR_DISTANCE = 6;

const UNREACHABLE = 255;

/**
 * Where each move sends a corner or edge, and how it twists or flips it.
 *
 * Read out of the engine by applying each move to a solved cube, the same technique
 * `crossTable.ts` uses — `cp[i] === j` means slot `i` now holds what was at slot `j`, so `j`
 * travelled to `i`.
 */
const CORNER_TO: readonly Uint8Array[] = SEARCH_MOVES.map((move) => {
  const after = applyMoves(CubeState.solved(), [move]);
  const to = new Uint8Array(8);
  for (let i = 0; i < 8; i++) to[after.cp[i]!] = i;
  return to;
});

const CORNER_TWIST: readonly Uint8Array[] = SEARCH_MOVES.map((move) => {
  const after = applyMoves(CubeState.solved(), [move]);
  const twist = new Uint8Array(8);
  for (let i = 0; i < 8; i++) twist[after.cp[i]!] = after.co[i]!;
  return twist;
});

const EDGE_TO: readonly Uint8Array[] = SEARCH_MOVES.map((move) => {
  const after = applyMoves(CubeState.solved(), [move]);
  const to = new Uint8Array(12);
  for (let i = 0; i < 12; i++) to[after.ep[i]!] = i;
  return to;
});

const EDGE_FLIP: readonly Uint8Array[] = SEARCH_MOVES.map((move) => {
  const after = applyMoves(CubeState.solved(), [move]);
  const flip = new Uint8Array(12);
  for (let i = 0; i < 12; i++) flip[after.ep[i]!] = after.eo[i]!;
  return flip;
});

/** Pack a pair position into an index. */
export function packPair(
  cornerSlot: number,
  cornerOrientation: number,
  edgeSlot: number,
  edgeOrientation: number,
): number {
  return ((cornerSlot * 3 + cornerOrientation) * 12 + edgeSlot) * 2 + edgeOrientation;
}

/** Where a pair's two pieces currently sit, in an already-normalised state. */
export function pairIndexOf(state: CubeState, slot: Slot): number {
  let cornerSlot = -1;
  let edgeSlot = -1;
  for (let i = 0; i < 8; i++) {
    if (state.cp[i] === slot.corner) {
      cornerSlot = i;
      break;
    }
  }
  for (let i = 0; i < 12; i++) {
    if (state.ep[i] === slot.edge) {
      edgeSlot = i;
      break;
    }
  }
  return packPair(
    cornerSlot,
    state.co[cornerSlot]!,
    edgeSlot,
    state.eo[edgeSlot]!,
  );
}

/**
 * `pairIndexOf` for a caller that already knows where every piece is.
 *
 * `pairIndexOf` searches `cp` and `ep` for one piece, which is fine once but wasteful in a
 * search that asks about four pairs at every node — four scans of the same two arrays. Inverting
 * the permutations once per node and reading them costs less from the second pair onwards. The
 * inverses are the obvious ones: `inverseCp[p]` is the slot holding piece `p`.
 */
export function pairIndexFrom(
  state: CubeState,
  slot: Slot,
  inverseCp: Uint8Array,
  inverseEp: Uint8Array,
): number {
  const cornerSlot = inverseCp[slot.corner]!;
  const edgeSlot = inverseEp[slot.edge]!;
  return packPair(cornerSlot, state.co[cornerSlot]!, edgeSlot, state.eo[edgeSlot]!);
}

function build(slot: Slot): Uint8Array {
  const distance = new Uint8Array(PAIR_INDEX_SPACE).fill(UNREACHABLE);
  const solvedIndex = packPair(slot.corner, 0, slot.edge, 0);
  distance[solvedIndex] = 0;

  // Breadth-first over the four numbers directly, never touching a cube state.
  let frontier: [number, number, number, number][] = [[slot.corner, 0, slot.edge, 0]];
  let depth = 0;
  while (frontier.length > 0) {
    const next: [number, number, number, number][] = [];
    for (const [cornerSlot, cornerOrientation, edgeSlot, edgeOrientation] of frontier) {
      for (let m = 0; m < SEARCH_MOVES.length; m++) {
        const nextCorner = CORNER_TO[m]![cornerSlot]!;
        const nextTwist = (cornerOrientation + CORNER_TWIST[m]![cornerSlot]!) % 3;
        const nextEdge = EDGE_TO[m]![edgeSlot]!;
        const nextFlip = edgeOrientation ^ EDGE_FLIP[m]![edgeSlot]!;
        const index = packPair(nextCorner, nextTwist, nextEdge, nextFlip);
        if (distance[index] !== UNREACHABLE) continue;
        distance[index] = depth + 1;
        next.push([nextCorner, nextTwist, nextEdge, nextFlip]);
      }
    }
    frontier = next;
    depth++;
  }
  return distance;
}

const cache = new Map<string, Uint8Array>();

/** The table for one slot, built on first use and kept. */
export function pairTable(slot: Slot): Uint8Array {
  const key = `${slot.corner}:${slot.edge}`;
  let table = cache.get(key);
  if (!table) {
    table = build(slot);
    cache.set(key, table);
  }
  return table;
}

/** Lower bound on the moves needed to bring this pair home, from a normalised state. */
export function pairDistance(state: CubeState, slot: Slot): number {
  return pairTable(slot)[pairIndexOf(state, slot)]!;
}

// `isSlotSolved` is re-exported from `analysis` rather than redefined here: two copies of the
// same predicate are two things that can drift apart.
export { isSlotSolved };
