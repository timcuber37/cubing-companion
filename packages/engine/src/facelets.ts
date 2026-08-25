/**
 * Kociemba facelet strings — the interchange format for talking to anything outside this
 * engine.
 *
 * Internal piece indexing is a private convention (ours happens to match cubing.js's), and
 * other tools do not share it: GAN's smart-cube protocol reports
 * `cp = [0,5,2,1,7,4,6,3]` after `F R` where we report `[0,3,2,5,7,4,6,1]`. The 54-character
 * facelet string, by contrast, is a published standard, so it is the safe thing to exchange.
 *
 * Layout is the standard `URFDLB` order, nine facelets per face, each face read left-to-right
 * and top-to-bottom as seen looking directly at it:
 *
 * ```
 *   U: 0..8    R: 9..17   F: 18..26   D: 27..35   L: 36..44   B: 45..53
 * ```
 *
 * A solved cube in standard orientation is
 * `"UUUUUUUUURRRRRRRRRFFFFFFFFFDDDDDDDDDLLLLLLLLLBBBBBBBBB"`.
 */
import {
  CubeState,
  Face,
  NUM_CENTERS,
  NUM_CORNERS,
  NUM_EDGES,
} from "./state.ts";

/** Face letters in facelet-string order. */
const FACE_LETTERS = "URFDLB";

export const NUM_FACELETS = 54;

/**
 * Our {@link Face} indices are `U L F R B D`; the string's are `U R F D L B`. These convert
 * between the two orderings.
 */
const FACE_TO_STRING_INDEX = [0, 4, 2, 1, 5, 3] as const;
const STRING_INDEX_TO_FACE = [0, 3, 2, 5, 1, 4] as const;

/**
 * Facelets of each corner slot, in orientation order: the U/D facelet first, then the other
 * two going clockwise as seen from outside the corner. Indexed by our corner numbering
 * (URF, UBR, ULB, UFL, DFR, DLF, DBL, DRB).
 */
const CORNER_FACELETS: readonly (readonly [number, number, number])[] = [
  [8, 9, 20], // URF
  [2, 45, 11], // UBR
  [0, 36, 47], // ULB
  [6, 18, 38], // UFL
  [29, 26, 15], // DFR
  [27, 44, 24], // DLF
  [33, 53, 42], // DBL
  [35, 17, 51], // DRB
];

/**
 * Facelets of each edge slot, in orientation order. Indexed by our edge numbering
 * (UF, UR, UB, UL, DF, DR, DB, DL, FR, FL, BR, BL).
 */
const EDGE_FACELETS: readonly (readonly [number, number])[] = [
  [7, 19], // UF
  [5, 10], // UR
  [1, 46], // UB
  [3, 37], // UL
  [28, 25], // DF
  [32, 16], // DR
  [34, 52], // DB
  [30, 43], // DL
  [23, 12], // FR
  [21, 41], // FL
  [48, 14], // BR
  [50, 39], // BL
];

/** Centre facelet of each face slot, indexed by {@link Face}. */
const CENTER_FACELETS: readonly number[] = [4, 40, 22, 13, 49, 31];

export class FaceletError extends Error {
  override readonly name = "FaceletError";
}

/** The face a facelet belongs to on a solved cube — i.e. the colour of that sticker. */
const homeFaceOf = (facelet: number): number =>
  STRING_INDEX_TO_FACE[Math.floor(facelet / 9)]!;

/**
 * Render a state as a facelet string.
 *
 * Colours follow the pieces, so a rotated cube produces a rotated string: after `y`, the F
 * face shows what was the R colour. That is what a camera would see, and it is what
 * external tools expect.
 */
export function toFacelets(state: CubeState): string {
  const out = new Array<string>(NUM_FACELETS);

  for (let slot = 0; slot < NUM_CENTERS; slot++) {
    const colour = state.centers[slot]!;
    out[CENTER_FACELETS[slot]!] = FACE_LETTERS[FACE_TO_STRING_INDEX[colour]!]!;
  }

  for (let slot = 0; slot < NUM_CORNERS; slot++) {
    const piece = state.cp[slot]!;
    const orientation = state.co[slot]!;
    const here = CORNER_FACELETS[slot]!;
    const home = CORNER_FACELETS[piece]!;
    for (let i = 0; i < 3; i++) {
      // The sticker that sits at `home[i]` when solved lands on the facelet `orientation`
      // steps around this corner.
      const target = here[(i + orientation) % 3]!;
      out[target] = FACE_LETTERS[FACE_TO_STRING_INDEX[homeFaceOf(home[i]!)]!]!;
    }
  }

  for (let slot = 0; slot < NUM_EDGES; slot++) {
    const piece = state.ep[slot]!;
    const orientation = state.eo[slot]!;
    const here = EDGE_FACELETS[slot]!;
    const home = EDGE_FACELETS[piece]!;
    for (let i = 0; i < 2; i++) {
      const target = here[(i + orientation) % 2]!;
      out[target] = FACE_LETTERS[FACE_TO_STRING_INDEX[homeFaceOf(home[i]!)]!]!;
    }
  }

  return out.join("");
}

/** Corner and edge slots described by the set of faces they touch, for lookup during parsing. */
const cornerKey = (faces: readonly number[]) => [...faces].sort().join(",");

const CORNER_BY_FACES = new Map<string, number>(
  CORNER_FACELETS.map((facelets, piece) => [
    cornerKey(facelets.map(homeFaceOf)),
    piece,
  ]),
);
const EDGE_BY_FACES = new Map<string, number>(
  EDGE_FACELETS.map((facelets, piece) => [
    cornerKey(facelets.map(homeFaceOf)),
    piece,
  ]),
);

/**
 * Parse a facelet string back into a state.
 *
 * Centres are read first to establish which colour belongs to which face, so a rotated cube
 * parses correctly rather than being mistaken for a scrambled one.
 *
 * @throws {FaceletError} if the string is the wrong length, uses unknown letters, or does
 * not describe a physically coherent cube. It does *not* check solvability — a cube can be
 * coherent but unreachable (a single twisted corner), and a smart cube reporting such a
 * state is a real situation worth surfacing rather than rejecting here.
 */
export function fromFacelets(facelets: string): CubeState {
  if (facelets.length !== NUM_FACELETS) {
    throw new FaceletError(
      `expected ${NUM_FACELETS} facelets, got ${facelets.length}`,
    );
  }

  const colourAt = (facelet: number): number => {
    const index = FACE_LETTERS.indexOf(facelets[facelet]!);
    if (index === -1) {
      throw new FaceletError(
        `unknown facelet character ${JSON.stringify(facelets[facelet])} at ${facelet}`,
      );
    }
    return STRING_INDEX_TO_FACE[index]!;
  };

  const state = new CubeState();

  for (let slot = 0; slot < NUM_CENTERS; slot++) {
    state.centers[slot] = colourAt(CENTER_FACELETS[slot]!);
  }

  for (let slot = 0; slot < NUM_CORNERS; slot++) {
    const here = CORNER_FACELETS[slot]!;
    const colours = here.map(colourAt);
    const piece = CORNER_BY_FACES.get(cornerKey(colours));
    if (piece === undefined) {
      throw new FaceletError(
        `corner slot ${slot} has no such corner: ${colours.join(",")}`,
      );
    }
    // Orientation is how far the U/D-coloured sticker sits from this slot's first facelet.
    const home = CORNER_FACELETS[piece]!;
    const reference = homeFaceOf(home[0]!);
    const orientation = colours.indexOf(reference);
    if (orientation === -1) {
      throw new FaceletError(`corner slot ${slot} is missing its U/D facelet`);
    }
    state.cp[slot] = piece;
    state.co[slot] = orientation;
  }

  for (let slot = 0; slot < NUM_EDGES; slot++) {
    const here = EDGE_FACELETS[slot]!;
    const colours = here.map(colourAt);
    const piece = EDGE_BY_FACES.get(cornerKey(colours));
    if (piece === undefined) {
      throw new FaceletError(
        `edge slot ${slot} has no such edge: ${colours.join(",")}`,
      );
    }
    const home = EDGE_FACELETS[piece]!;
    state.ep[slot] = piece;
    state.eo[slot] = colours[0] === homeFaceOf(home[0]!) ? 0 : 1;
  }

  return state;
}

/** Whether two states show the same thing, comparing as facelets. */
export function faceletsEqual(a: CubeState, b: CubeState): boolean {
  return toFacelets(a) === toFacelets(b);
}

/**
 * The nine facelets of one face, reading left-to-right and top-to-bottom.
 *
 * Useful for questions about what a face *looks like* rather than where its pieces are —
 * "is this face a single colour?" is the definition of a finished OLL, and asking it this
 * way avoids the orientation conventions that make `co`/`eo` awkward for any face other
 * than U and D.
 */
export function faceletsOfFace(facelets: string, face: Face): string {
  const start = FACE_TO_STRING_INDEX[face]! * 9;
  return facelets.slice(start, start + 9);
}

/** Whether a face shows a single colour. */
export function isFaceUniform(state: CubeState, face: Face): boolean {
  const nine = faceletsOfFace(toFacelets(state), face);
  return nine === nine[0]!.repeat(9);
}

export { Face };
