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
  /**
   * `renameRotation["y:1"]` is the rotation to make, when the sequence says `y`.
   *
   * Rotations need a move-level map where face turns need only a family map, because the three
   * rotation *names* cover six axis directions: `x` follows R, so a frame that maps R to L maps
   * `x` to `x'` — the amount's sign can flip, which never happens to a face turn (every face has
   * its own name). Derived by the same state comparison as `rename`, never reasoned out.
   */
  readonly renameRotation: Readonly<Record<string, Move>>;
}

const AMOUNTS = [1, 2, -1] as const;

/** The nine whole-cube rotation moves. */
const ROTATION_MOVES: readonly Move[] = ROTATION_FAMILIES.flatMap((family) =>
  AMOUNTS.map((amount) => ({ family, amount }) as Move),
);

/**
 * Slices need the same move-level treatment as rotations, for the same reason: three names cover
 * six directions (`M` follows L, so a frame mapping L to R maps `M` to `M'`), so the sign can
 * flip. Wide moves do not — every face has its own name, so `Rw` renames at family level exactly
 * as `R` does.
 */
const SLICE_MOVES: readonly Move[] = (["M", "E", "S"] as const).flatMap((family) =>
  AMOUNTS.map((amount) => ({ family, amount }) as Move),
);

const MOVE_LEVEL_MOVES: readonly Move[] = [...ROTATION_MOVES, ...SLICE_MOVES];

const rotationKey = (move: Move): string => `${move.family}:${move.amount}`;

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

/** The same derivation for rotations and slices, which need amounts as well as families. */
function deriveRotationRenaming(rotation: readonly Move[]): Record<string, Move> {
  const solved = CubeState.solved();
  const rename: Record<string, Move> = {};

  for (const from of MOVE_LEVEL_MOVES) {
    const candidates = ROTATION_FAMILIES.includes(from.family as never)
      ? ROTATION_MOVES
      : SLICE_MOVES;
    const target = applyMoves(applyMoves(solved, [from]), rotation);
    const found = candidates.find((to) =>
      applyMoves(applyMoves(solved, rotation), [to]).equals(target),
    );
    if (found === undefined) {
      // Unreachable: conjugation by a rotation keeps a rotation a rotation, a slice a slice.
      throw new Error(`no renaming for ${serializeMoves([from])} under ${serializeMoves(rotation)}`);
    }
    rename[rotationKey(from)] = found;
  }
  return rename;
}

/** A frame for an arbitrary rotation sequence, for renaming under a view that is not one of the 24. */
export function frameFor(rotation: readonly Move[]): Orientation {
  const rotated = applyMoves(CubeState.solved(), rotation);
  return {
    rotation,
    text: serializeMoves(rotation),
    colourAt: [...rotated.centers] as Face[],
    rename: deriveRenaming(rotation),
    renameRotation: deriveRotationRenaming(rotation),
  };
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

  return [...found.values()].map((rotation) => frameFor(rotation));
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
    // Rotations and slices carry their sign in the map; see the derivation above.
    const mapped = orientation.renameRotation[rotationKey(move)];
    if (mapped !== undefined) return mapped;

    // A wide move renames exactly as its face does — every face has its own name.
    if (move.family.endsWith("w")) {
      const base = orientation.rename[move.family.slice(0, -1)];
      if (base !== undefined) return { family: `${base}w`, amount: move.amount } as Move;
    }

    const family = orientation.rename[move.family];
    if (family === undefined) {
      throw new Error(`cannot re-orient ${move.family}`);
    }
    return { family, amount: move.amount } as Move;
  });
}

/**
 * How each rotation move permutes the six centres — read off the engine, never written down.
 *
 * `after.centers[i] = before.centers[PERM[i]]`: derived by applying the move to a solved cube,
 * whose centres are the identity, so what lands at slot `i` names the slot it came from.
 */
const CENTRE_PERMS: readonly { readonly move: Move; readonly perm: readonly number[] }[] =
  ROTATION_MOVES.map((move) => ({
    move,
    perm: [...applyMoves(CubeState.solved(), [move]).centers],
  }));

const applyPerm = (centres: readonly number[], perm: readonly number[]): number[] =>
  perm.map((from) => centres[from]!);

/**
 * The shortest rotation sequence from one centre arrangement to a goal, by breadth-first search.
 *
 * This is the primitive the planner was missing. Everything it recommends is expressed in some
 * chosen grip, and the cube being advised is in some *other* orientation — the instruction "hold
 * yellow down, green front" was the only bridge between the two, and a sequence that is not
 * literally executable from the position the cube is in solves the wrong pieces the moment
 * anything applies it directly, which is exactly what branch playback did.
 */
function shortestRotation(
  from: ArrayLike<number>,
  reached: (centres: readonly number[]) => boolean,
): Move[] {
  const start = Array.from(from);
  if (reached(start)) return [];

  const seen = new Set<string>([start.join(",")]);
  let frontier: { centres: number[]; path: Move[] }[] = [{ centres: start, path: [] }];

  while (frontier.length > 0) {
    const next: typeof frontier = [];
    for (const { centres, path } of frontier) {
      for (const { move, perm } of CENTRE_PERMS) {
        const after = applyPerm(centres, perm);
        if (reached(after)) return [...path, move];
        const key = after.join(",");
        if (seen.has(key)) continue;
        seen.add(key);
        next.push({ centres: after, path: [...path, move] });
      }
    }
    frontier = next;
  }
  // Unreachable for legal centres: the rotation group is transitive on the 24 arrangements.
  throw new RangeError(`no rotation reaches the requested arrangement from ${start.join(",")}`);
}

/** The rotations taking one centre arrangement exactly onto another. */
export function rotationBetween(
  from: ArrayLike<number>,
  to: ArrayLike<number>,
): Move[] {
  const goal = Array.from(to).join(",");
  return shortestRotation(from, (centres) => centres.join(",") === goal);
}

/**
 * Every frame that puts a colour on the bottom, shortest rotation first.
 *
 * The four views a cross-down replay may choose between: they agree on what is underneath and
 * differ only in what faces you. `rotationPuttingColourDown` returns the first of these; a
 * caller with an opinion about the grip can weigh all four instead.
 *
 * `colourAt` doubles as the centre permutation of its own rotation, so applying a frame to some
 * other arrangement is a lookup: what ends at a slot is what the frame draws from.
 */
export function framesPuttingColourDown(
  from: ArrayLike<number>,
  colour: Face,
): Orientation[] {
  const centres = Array.from(from);
  return ORIENTATIONS.filter((o) => centres[o.colourAt[Face.D]!] === colour);
}

/** The shortest rotations putting a colour on the bottom, front left free — for a viewing frame. */
export function rotationPuttingColourDown(
  from: ArrayLike<number>,
  colour: Face,
): Move[] {
  return shortestRotation(from, (centres) => centres[Face.D] === colour);
}

/** Slot names are frame-relative too: `FR` becomes `FL` when the cube is turned a quarter. */
export function renameSlot(slot: string, orientation: Orientation): string {
  return [...slot].map((face) => orientation.rename[face] ?? face).join("");
}
