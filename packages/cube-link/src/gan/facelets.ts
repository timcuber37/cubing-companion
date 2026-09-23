/**
 * Turning the cube's piece arrays into a Kociemba facelet string.
 *
 * The cube reports permutation and orientation, not stickers. This package's interchange format is
 * facelets — see the README — because that is what every other tool in cubing speaks, and because
 * it does not commit us to GAN's piece indexing.
 *
 * Vendored verbatim from `gan-web-bluetooth` (MIT, Andy Fedotov); the maps are conventions of the
 * Kociemba representation rather than of that library.
 */
import { sum } from "./message.ts";
import type { GanFaceletsEvent } from "./events.ts";

/** Facelet indices of each corner's three stickers, in URF order. */
const CORNER_FACELETS: readonly (readonly number[])[] = [
  [8, 9, 20], // URF
  [6, 18, 38], // UFL
  [0, 36, 47], // ULB
  [2, 45, 11], // UBR
  [29, 26, 15], // DFR
  [27, 44, 24], // DLF
  [33, 53, 42], // DBL
  [35, 17, 51], // DRB
];

/** Facelet indices of each edge's two stickers. */
const EDGE_FACELETS: readonly (readonly number[])[] = [
  [5, 10], // UR
  [7, 19], // UF
  [3, 37], // UL
  [1, 46], // UB
  [32, 16], // DR
  [28, 25], // DF
  [30, 43], // DL
  [34, 52], // DB
  [23, 12], // FR
  [21, 41], // FL
  [50, 39], // BL
  [48, 14], // BR
];

const FACES = "URFDLB";

export interface CubePieces {
  readonly cp: number[];
  readonly co: number[];
  readonly ep: number[];
  readonly eo: number[];
}

/** A facelet message that does not describe a cube. Thrown so the caller can drop it. */
export class GanFaceletsError extends Error {
  override readonly name = "GanFaceletsError";
}

/**
 * Do these arrays describe a real cube?
 *
 * The reference implementation does not ask, and indexes its facelet maps with whatever arrived —
 * so a corrupted packet throws a `TypeError` from inside the conversion and takes the connection
 * down with it. That is a bad trade over BLE, where a mangled notification is a normal event
 * rather than an impossible one.
 *
 * Checking is cheap and the answer is actionable: an invalid state is dropped, the cube keeps
 * talking, and `tracker.ts` notices the disagreement through the serial gap it already watches for.
 */
export function isCube(cp: readonly number[], co: readonly number[], ep: readonly number[], eo: readonly number[]): boolean {
  const permutation = (values: readonly number[], size: number) =>
    values.length === size && new Set(values).size === size &&
    values.every((value) => Number.isInteger(value) && value >= 0 && value < size);
  const orientation = (values: readonly number[], size: number, limit: number) =>
    values.length === size &&
    values.every((value) => Number.isInteger(value) && value >= 0 && value < limit);

  return (
    permutation(cp, 8) && orientation(co, 8, 3) && permutation(ep, 12) && orientation(eo, 12, 2)
  );
}

/**
 * The eighth corner and twelfth edge are not transmitted — they are implied.
 *
 * Permutations are a bijection, so the missing index is whatever is left over (0+…+7 = 28,
 * 0+…+11 = 66). Orientations must sum to zero modulo 3 for corners and modulo 2 for edges, which
 * is the parity constraint that makes a cube state reachable at all.
 */
export function completePieces(cp: number[], co: number[], ep: number[], eo: number[]): CubePieces {
  cp.push(28 - sum(cp));
  co.push((3 - (sum(co) % 3)) % 3);
  ep.push(66 - sum(ep));
  eo.push((2 - (sum(eo) % 2)) % 2);
  return { cp, co, ep, eo };
}

/**
 * Piece arrays to the 54-character facelet string.
 *
 * Solved is `UUUUUUUUURRRRRRRRRFFFFFFFFFDDDDDDDDDLLLLLLLLLBBBBBBBBB`.
 */
export function toKociembaFacelets(
  cp: readonly number[],
  co: readonly number[],
  ep: readonly number[],
  eo: readonly number[],
): string {
  if (!isCube(cp, co, ep, eo)) {
    throw new GanFaceletsError("the cube reported a state that is not a cube");
  }
  const facelets: string[] = [];
  for (let i = 0; i < 54; i++) facelets[i] = FACES[Math.trunc(i / 9)]!;

  for (let i = 0; i < 8; i++) {
    for (let p = 0; p < 3; p++) {
      const at = CORNER_FACELETS[i]![(p + co[i]!) % 3]!;
      facelets[at] = FACES[Math.trunc(CORNER_FACELETS[cp[i]!]![p]! / 9)]!;
    }
  }
  for (let i = 0; i < 12; i++) {
    for (let p = 0; p < 2; p++) {
      const at = EDGE_FACELETS[i]![(p + eo[i]!) % 2]!;
      facelets[at] = FACES[Math.trunc(EDGE_FACELETS[ep[i]!]![p]! / 9)]!;
    }
  }
  return facelets.join("");
}

/**
 * Build a facelet event, or null if the cube did not describe a cube.
 *
 * All three drivers read the same four arrays out of different bit offsets and then do exactly
 * this, so the completion, validation and conversion live together rather than three times over.
 * Returning null instead of throwing puts the decision where it belongs: a driver drops the
 * message and keeps the connection, which is the right answer for every caller so far.
 */
export function faceletsEvent(
  serial: number,
  timestamp: number,
  cp: number[],
  co: number[],
  ep: number[],
  eo: number[],
): GanFaceletsEvent | null {
  const pieces = completePieces(cp, co, ep, eo);
  if (!isCube(pieces.cp, pieces.co, pieces.ep, pieces.eo)) return null;
  return {
    type: "FACELETS",
    serial,
    timestamp,
    facelets: toKociembaFacelets(pieces.cp, pieces.co, pieces.ep, pieces.eo),
    state: { CP: pieces.cp, CO: pieces.co, EP: pieces.ep, EO: pieces.eo },
  };
}
