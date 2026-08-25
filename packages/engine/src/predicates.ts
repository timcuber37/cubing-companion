/**
 * Piece-location primitives.
 *
 * These are deliberately method-agnostic: no cross, no F2L slots, no OLL/PLL. CFOP phase
 * logic belongs to the segmenter (A2), and the cross/xcross searches (B2) build on the
 * same primitives. Keeping method assumptions out of the engine is what lets both consume
 * it without inheriting the other's opinions.
 */
import { applyMoves, invertMoves } from "./moves.ts";
import type { Move } from "./moves.ts";
import {
  CubeState,
  Face,
  NUM_CENTERS,
  NUM_CORNERS,
  NUM_EDGES,
} from "./state.ts";

/** The slot currently holding corner `piece`. */
export function whereIsCorner(state: CubeState, piece: number): number {
  for (let slot = 0; slot < NUM_CORNERS; slot++) {
    if (state.cp[slot] === piece) return slot;
  }
  throw new RangeError(`no such corner piece: ${piece}`);
}

/** The slot currently holding edge `piece`. */
export function whereIsEdge(state: CubeState, piece: number): number {
  for (let slot = 0; slot < NUM_EDGES; slot++) {
    if (state.ep[slot] === piece) return slot;
  }
  throw new RangeError(`no such edge piece: ${piece}`);
}

/** Whether the corner in `slot` is its home piece, correctly oriented. */
export function isCornerSolved(state: CubeState, slot: number): boolean {
  return state.cp[slot] === slot && state.co[slot] === 0;
}

/** Whether the edge in `slot` is its home piece, correctly oriented. */
export function isEdgeSolved(state: CubeState, slot: number): boolean {
  return state.ep[slot] === slot && state.eo[slot] === 0;
}

/**
 * The colour currently showing on a face, expressed as the {@link Face} whose centre
 * carries that colour on a solved cube.
 *
 * On a solved cube in standard orientation this is the identity; after `y` it is not.
 * This is the primitive that makes colour-neutral cross detection possible.
 */
export function colorOnFace(state: CubeState, face: Face): Face {
  return state.centers[face] as Face;
}

/** Whether the cube is in the standard orientation (white-ish U, green-ish F, etc.). */
export function isStandardOrientation(state: CubeState): boolean {
  for (let i = 0; i < NUM_CENTERS; i++) {
    if (state.centers[i] !== i) return false;
  }
  return true;
}

const X: Move = { family: "x", amount: 1 };
const Y: Move = { family: "y", amount: 1 };
const Z: Move = { family: "z", amount: 1 };

/**
 * The 24 solved-but-rotated states, keyed by centre arrangement.
 *
 * Built by breadth-first search over the three rotations rather than written out, so the
 * count is a consequence of the move tables rather than an assumption. If the tables were
 * wrong this map would not have 24 entries — which a test asserts.
 */
const ORIENTATIONS: ReadonlyMap<string, CubeState> = (() => {
  const byState = new Map<string, CubeState>();
  const queue: CubeState[] = [CubeState.solved()];
  byState.set(queue[0]!.key(), queue[0]!);
  for (let head = 0; head < queue.length; head++) {
    for (const rotation of [X, Y, Z]) {
      const next = applyMoves(queue[head]!, [rotation]);
      const key = next.key();
      if (byState.has(key)) continue;
      byState.set(key, next);
      queue.push(next);
    }
  }
  const byCenters = new Map<string, CubeState>();
  for (const state of byState.values()) {
    byCenters.set(state.centers.join(","), state);
  }
  return byCenters;
})();

/**
 * The rotation that produced each centre arrangement, as a move sequence.
 *
 * Same breadth-first search as {@link ORIENTATIONS}, but keeping the path rather than the
 * state, so an arrangement can be undone rather than merely recognised.
 */
const ROTATION_TO_ORIENTATION: ReadonlyMap<string, readonly Move[]> = (() => {
  const byCenters = new Map<string, readonly Move[]>();
  const seen = new Set<string>();
  const queue: { state: CubeState; path: Move[] }[] = [
    { state: CubeState.solved(), path: [] },
  ];
  seen.add(queue[0]!.state.key());
  byCenters.set(queue[0]!.state.centers.join(","), []);

  for (let head = 0; head < queue.length; head++) {
    const current = queue[head]!;
    for (const rotation of [X, Y, Z]) {
      const next = applyMoves(current.state, [rotation]);
      const key = next.key();
      if (seen.has(key)) continue;
      seen.add(key);
      const path = [...current.path, rotation];
      queue.push({ state: next, path });
      const centersKey = next.centers.join(",");
      // Breadth-first, so the first path to reach an arrangement is a shortest one.
      if (!byCenters.has(centersKey)) byCenters.set(centersKey, path);
    }
  }
  return byCenters;
})();

/**
 * Rotate a state so its centres sit in the standard arrangement.
 *
 * Whole-cube rotations change which slot every piece occupies without changing anything
 * about the solve, so any predicate written against fixed slots — "is this corner home?",
 * "is the cross built?" — gives the wrong answer on a rotated cube. Normalising first makes
 * those predicates orientation-agnostic.
 *
 * This is what lets one segmenter handle both reconstructions, which are full of rotations,
 * and smart-cube streams, which contain none because a cube cannot sense them.
 *
 * A useful consequence: in the normalised frame a face's index *is* its colour, since face
 * `i` holds centre piece `i`. Cross colour therefore needs no separate bookkeeping.
 */
export function normalizeOrientation(state: CubeState): CubeState {
  const rotation = ROTATION_TO_ORIENTATION.get(state.centers.join(","));
  if (rotation === undefined) {
    // Only reachable if the centres are not a legal arrangement, which the engine's own
    // moves cannot produce — so this means the state came from outside and is malformed.
    throw new RangeError(
      `centres are not in any legal orientation: ${state.centers.join(",")}`,
    );
  }
  return applyMoves(state, invertMoves(rotation));
}

/** The number of distinct whole-cube orientations. Exposed for testing. */
export const ORIENTATION_COUNT = ORIENTATIONS.size;

/**
 * Whether the cube is physically solved, allowing for any whole-cube rotation.
 *
 * This is the check reconstructions need: a solve containing `x2` or an odd number of
 * rotations ends solved but not in the orientation it started in, and demanding the
 * standard orientation would reject perfectly valid solves.
 */
export function isSolvedIgnoringOrientation(state: CubeState): boolean {
  const reference = ORIENTATIONS.get(state.centers.join(","));
  return reference !== undefined && reference.equals(state);
}
