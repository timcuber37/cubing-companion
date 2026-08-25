/**
 * CFOP phase predicates.
 *
 * Everything here runs on an **orientation-normalised** state — centres home, so a piece is
 * solved exactly when `cp[i] === i && co[i] === 0`. That condition does not care which face
 * the cross is on, so the cross, F2L slot and F2L-complete predicates are colour-neutral for
 * free; they just need to be told *which* pieces to look at, which `geometry.ts` supplies.
 *
 * An earlier attempt rotated the cross colour onto D so that fixed slot predicates could be
 * reused. That is self-defeating: rotating moves the centres off home, which destroys the
 * very "slot index equals piece index" property the predicates depend on. Measured against
 * the corpus it identified every solve as a D-cross.
 *
 * OLL is the one genuinely frame-dependent question, because `co`/`eo` are defined about the
 * U/D axis and mean nothing useful for a cross on L. It is expressed instead as "the last
 * layer face shows a single colour", which is what OLL means anyway.
 */
import {
  applyMoves,
  CubeState,
  Face,
  isFaceUniform,
  makeMove,
  type Move,
} from "@cubing-companion/engine";
import type { CrossGeometry, Slot } from "./geometry.ts";

const FACE_LETTERS = "ULFRBD";

/** A quarter turn of a given face. */
function faceTurn(face: Face): Move {
  const move = makeMove(FACE_LETTERS[face]!, 1);
  if (!move) throw new Error(`no turn for face ${face}`);
  return move;
}

const TURNS: readonly Move[] = [
  Face.U,
  Face.L,
  Face.F,
  Face.R,
  Face.B,
  Face.D,
].map(faceTurn);

const isPieceSolved = (
  state: CubeState,
  corners: readonly number[],
  edges: readonly number[],
): boolean =>
  corners.every((c) => state.cp[c] === c && state.co[c] === 0) &&
  edges.every((e) => state.ep[e] === e && state.eo[e] === 0);

/**
 * Whether the cross is built, and how far the cross layer sits from home.
 *
 * `0` means the cross is in its final position, `1`–`3` that it is built but turned away,
 * `null` that it is not built.
 *
 * The offset allowance is what handles **pseudoslotting**: a solver deliberately builds the
 * cross a turn out of place because it makes a pair easier, works in that frame, and
 * corrects later. Requiring the cross to sit home puts its boundary several moves late,
 * after the correcting turn — which is exactly what the corpus disagreements showed.
 */
export function crossOffset(
  state: CubeState,
  geometry: CrossGeometry,
): number | null {
  const turn = TURNS[geometry.crossFace]!;
  let candidate = state;
  for (let offset = 0; offset < 4; offset++) {
    if (isPieceSolved(candidate, [], geometry.crossEdges)) return offset;
    candidate = applyMoves(candidate, [turn]);
  }
  return null;
}

export function isCrossBuilt(state: CubeState, geometry: CrossGeometry): boolean {
  return crossOffset(state, geometry) !== null;
}

/**
 * The state with the cross layer turned home, or `null` if the cross is not built.
 *
 * F2L predicates run against this, so a pair inserted while the cross was offset counts from
 * the moment it went in rather than from the later correcting turn.
 */
export function alignCross(
  state: CubeState,
  geometry: CrossGeometry,
): CubeState | null {
  const offset = crossOffset(state, geometry);
  if (offset === null) return null;
  const turn = TURNS[geometry.crossFace]!;
  let aligned = state;
  for (let i = 0; i < offset; i++) aligned = applyMoves(aligned, [turn]);
  return aligned;
}

/** Whether a slot holds its own corner and edge, both solved. */
export function isSlotSolved(state: CubeState, slot: Slot): boolean {
  return isPieceSolved(state, [slot.corner], [slot.edge]);
}

/**
 * Whether F2L is complete: everything but the last layer is solved.
 *
 * Deliberately strict, with no offset allowance. This is the anchor that identifies the
 * cross colour, and it earns that role by being unambiguous — exactly one face's layer left
 * unsolved happens once in a solve, and only for the real cross colour.
 */
export function isF2LComplete(state: CubeState, geometry: CrossGeometry): boolean {
  return isPieceSolved(state, geometry.f2lCorners, geometry.f2lEdges);
}

/**
 * Whether OLL is done — the last layer face shows a single colour.
 *
 * Asked of the facelets rather than of `co`/`eo`, which are defined about the U/D axis and
 * would need a different notion of "oriented" for every cross colour.
 */
export function isLastLayerOriented(
  state: CubeState,
  geometry: CrossGeometry,
): boolean {
  return isFaceUniform(state, geometry.lastLayerFace);
}

/**
 * Whether the cube is solved apart from a final turn of the last layer.
 *
 * The solve is finished once the last piece is permuted; the AUF that squares the top with
 * the sides is its own step, and reconstructions label it separately.
 */
export function isSolvedIgnoringAUF(
  state: CubeState,
  geometry: CrossGeometry,
): boolean {
  const turn = TURNS[geometry.lastLayerFace]!;
  let candidate = state;
  for (let i = 0; i < 4; i++) {
    if (candidate.isSolved()) return true;
    candidate = applyMoves(candidate, [turn]);
  }
  return false;
}
