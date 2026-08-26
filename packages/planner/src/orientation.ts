/**
 * How to hold the cube, and what that does to a solution's move names.
 *
 * The solver searches in a fixed frame, but a human holds the cube however suits the solve. The
 * corpus says that choice is the dominant one: pros rotate **1.45 times during inspection** and
 * only **0.23 times during the cross itself**, so they pick a frame and then execute in it. That
 * is why the back face accounts for just 1.8% of the 35,129 cross turns measured — not because
 * pros choose B-free solutions, but because they hold the cube so the work is not at the back.
 * Re-orienting a candidate over the four frames that keep the cross colour down drops its mean B
 * moves from 1.19 to 0.39.
 *
 * **The renaming table is derived from the engine, never written by hand.** `respell.ts` in
 * `solver` shipped with every rotation inverted and 0% coverage because that table was reasoned
 * out; here each entry is found by asking the engine which move reaches the same state, so the
 * whole class of error is gone.
 */
import {
  applyMoves,
  CubeState,
  Face,
  parseMoves,
  serializeMoves,
  type Move,
} from "@cubing-companion/engine";

/** The six outer faces, which are the only families a solution from `solver` can contain. */
const FACE_FAMILIES = ["U", "D", "L", "R", "F", "B"] as const;
const ROTATION_FAMILIES = ["x", "y", "z"] as const;

export interface Orientation {
  /** The rotation that reaches this frame from the normalised one. Empty for the identity. */
  readonly rotation: readonly Move[];
  /** `"x y'"`, or `""` for the identity — for display and for keying. */
  readonly text: string;
  /**
   * `colourAt[slot]` is the colour sitting at that face slot once the cube is held this way.
   *
   * In the normalised frame a colour's index equals its face index, so this doubles as the
   * permutation the rotation applies.
   */
  readonly colourAt: readonly Face[];
  /**
   * `rename[f]` is the face to actually turn, when the solution says to turn `f`.
   *
   * Derived: it is the `g` for which "rotate, then turn `g`" reaches the same state as "turn
   * `f`, then rotate".
   */
  readonly rename: Readonly<Record<string, string>>;
}

/** Build the family renaming for one rotation by comparing states, rather than by reasoning. */
function deriveRenaming(rotation: readonly Move[]): Record<string, string> {
  const solved = CubeState.solved();
  const rename: Record<string, string> = {};

  for (const from of FACE_FAMILIES) {
    // The state we must still be able to reach: turn the face, then rotate.
    const target = applyMoves(applyMoves(solved, parseMoves(from)), rotation);
    const found = FACE_FAMILIES.find((to) =>
      applyMoves(applyMoves(solved, rotation), parseMoves(to)).equals(target),
    );
    if (found === undefined) {
      // Unreachable: a whole-cube rotation always maps a face turn to another face turn.
      throw new Error(`no renaming for ${from} under ${serializeMoves(rotation)}`);
    }
    rename[from] = found;
  }
  return rename;
}

/**
 * The 24 ways to hold a cube, found by breadth-first search over the three rotations.
 *
 * Shortest rotation sequence wins, so the instruction shown to a user is the least fiddly one
 * that reaches the frame.
 */
export const ORIENTATIONS: readonly Orientation[] = (() => {
  const solved = CubeState.solved();
  const found = new Map<string, readonly Move[]>([[solved.centers.join(","), []]]);
  let frontier: readonly Move[][] = [[]];

  while (frontier.length > 0) {
    const next: Move[][] = [];
    for (const path of frontier) {
      for (const family of ROTATION_FAMILIES) {
        for (const amount of [1, 2, -1] as const) {
          const rotation = [...path, { family, amount } as Move];
          const key = applyMoves(solved, rotation).centers.join(",");
          if (found.has(key)) continue;
          found.set(key, rotation);
          next.push(rotation);
        }
      }
    }
    frontier = next;
  }

  return [...found.values()].map((rotation) => {
    const rotated = applyMoves(solved, rotation);
    return {
      rotation,
      text: serializeMoves(rotation),
      colourAt: [...rotated.centers] as Face[],
      rename: deriveRenaming(rotation),
    };
  });
})();

/**
 * The four frames that put a colour on the bottom.
 *
 * That is the constraint a cross imposes: whichever colour you are crossing on goes down, and
 * the remaining freedom is which of the four side colours faces you.
 */
export function orientationsWithColourDown(colour: Face): readonly Orientation[] {
  return ORIENTATIONS.filter((o) => o.colourAt[Face.D] === colour);
}

/**
 * A solution as it would be turned in a given frame.
 *
 * Renaming move by move is sound for a whole sequence: each move becomes `r⁻¹ m r`, and the
 * inner rotations cancel along the sequence to leave `r⁻¹ M r`.
 */
export function renameMoves(
  moves: readonly Move[],
  orientation: Orientation,
): Move[] {
  return moves.map((move) => {
    const family = orientation.rename[move.family];
    if (family === undefined) {
      throw new Error(`cannot re-orient ${move.family}: not an outer face turn`);
    }
    return { family, amount: move.amount } as Move;
  });
}

/** Slot names are frame-relative too: `FR` becomes `FL` when the cube is turned a quarter. */
export function renameSlot(slot: string, orientation: Orientation): string {
  return [...slot].map((face) => orientation.rename[face] ?? face).join("");
}
