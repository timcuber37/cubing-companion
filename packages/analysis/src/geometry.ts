/**
 * Which pieces belong to which face, and what that means for CFOP.
 *
 * Everything here is *derived* from the engine's `CORNER_NAMES` and `EDGE_NAMES` rather
 * than tabulated by hand. A hand-written table of "the F2L slots for a green cross" is
 * exactly the kind of thing that is wrong in one entry and stays wrong for months, and the
 * derivation is only a few lines.
 *
 * All indices below are in the **normalised frame** — the cube rotated so its centres sit
 * home. There, a face's index is also its colour, so `crossFace` doubles as cross colour.
 */
import {
  CORNER_NAMES,
  EDGE_NAMES,
  Face,
  NUM_CORNERS,
  NUM_EDGES,
} from "@cubing-companion/engine";

const FACE_LETTERS = "ULFRBD";

/** The faces a piece touches, from its name. `URF` -> `[U, R, F]`. */
const facesOf = (name: string): Face[] =>
  [...name].map((letter) => FACE_LETTERS.indexOf(letter) as Face);

export const CORNER_FACES: readonly (readonly Face[])[] =
  CORNER_NAMES.map(facesOf);
export const EDGE_FACES: readonly (readonly Face[])[] = EDGE_NAMES.map(facesOf);

/** U↔D, L↔R, F↔B, in the engine's `U L F R B D` ordering. */
export const OPPOSITE: readonly Face[] = [
  Face.D,
  Face.R,
  Face.B,
  Face.L,
  Face.F,
  Face.U,
];

export const ALL_FACES: readonly Face[] = [
  Face.U,
  Face.L,
  Face.F,
  Face.R,
  Face.B,
  Face.D,
];

const indicesWhere = (
  count: number,
  faces: readonly (readonly Face[])[],
  predicate: (pieceFaces: readonly Face[]) => boolean,
): number[] => {
  const out: number[] = [];
  for (let i = 0; i < count; i++) if (predicate(faces[i]!)) out.push(i);
  return out;
};

/** An F2L slot: one corner and one edge, sharing two side faces. */
export interface Slot {
  readonly corner: number;
  readonly edge: number;
  /** The two side faces this slot sits between, for naming. */
  readonly faces: readonly [Face, Face];
}

/** Everything CFOP needs to know about solving with a given cross colour. */
export interface CrossGeometry {
  readonly crossFace: Face;
  readonly lastLayerFace: Face;
  /** The four cross edges. */
  readonly crossEdges: readonly number[];
  /** The four F2L slots, in no particular order — solve order is a property of the solve. */
  readonly slots: readonly Slot[];
  /** Corners and edges that must be solved for F2L to be complete (cross included). */
  readonly f2lCorners: readonly number[];
  readonly f2lEdges: readonly number[];
  /** Last-layer pieces. */
  readonly llCorners: readonly number[];
  readonly llEdges: readonly number[];
}

function buildGeometry(crossFace: Face): CrossGeometry {
  const lastLayerFace = OPPOSITE[crossFace]!;

  const crossEdges = indicesWhere(NUM_EDGES, EDGE_FACES, (f) =>
    f.includes(crossFace),
  );
  // F2L is everything not touching the last layer.
  const f2lCorners = indicesWhere(
    NUM_CORNERS,
    CORNER_FACES,
    (f) => !f.includes(lastLayerFace),
  );
  const f2lEdges = indicesWhere(
    NUM_EDGES,
    EDGE_FACES,
    (f) => !f.includes(lastLayerFace),
  );
  const llCorners = indicesWhere(NUM_CORNERS, CORNER_FACES, (f) =>
    f.includes(lastLayerFace),
  );
  const llEdges = indicesWhere(NUM_EDGES, EDGE_FACES, (f) =>
    f.includes(lastLayerFace),
  );

  // A slot pairs a cross-layer corner with the middle-layer edge sharing its side faces.
  const middleEdges = f2lEdges.filter((e) => !crossEdges.includes(e));
  const slots: Slot[] = [];
  for (const corner of f2lCorners) {
    const sides = CORNER_FACES[corner]!.filter((f) => f !== crossFace);
    const edge = middleEdges.find((e) => {
      const edgeFaces = EDGE_FACES[e]!;
      return sides.every((f) => edgeFaces.includes(f));
    });
    if (edge === undefined) {
      throw new Error(`no middle edge for corner ${corner} with cross ${crossFace}`);
    }
    slots.push({ corner, edge, faces: [sides[0]!, sides[1]!] });
  }

  return {
    crossFace,
    lastLayerFace,
    crossEdges,
    slots,
    f2lCorners,
    f2lEdges,
    llCorners,
    llEdges,
  };
}

/** Precomputed geometry for all six possible cross colours. */
export const GEOMETRY: readonly CrossGeometry[] = ALL_FACES.map(buildGeometry);

/**
 * Human-readable slot name, e.g. `FR`.
 *
 * Taken from the slot's middle-layer edge rather than assembled from its faces. The faces
 * arrive in whatever order the corner's name gave them, so building the name from them
 * yields `LF` for one slot and `FR` for another — the same slot spelled two ways, which
 * makes names useless for comparison. Edge names are already canonical.
 */
export function slotName(slot: Slot): string {
  return EDGE_NAMES[slot.edge]!;
}

/** Face letter, for display. */
export function faceName(face: Face): string {
  return FACE_LETTERS[face]!;
}
