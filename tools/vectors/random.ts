/**
 * Deterministic inputs for the oracle.
 *
 * Every vector file has to be byte-identical when regenerated, or the drift test that keeps the
 * oracle honest cannot exist. So nothing here touches `Math.random`: the generators take a seed,
 * and the same seed produces the same corpus on any machine, forever.
 *
 * The distribution matters as much as the determinism. A corpus of random scrambles exercises the
 * middle of the input space and misses both ends — solved cubes, one-move-from-solved, states with
 * a cross already built — and those ends are where a port's bugs live. `positions` mixes them in
 * deliberately.
 */
import { applyMoves, CubeState, parseMoves, toFacelets, type Move } from "@cubing-companion/engine";
import { randomMoveScramble } from "@cubing-companion/engine/scramble";

/** mulberry32. Small, fast, and good enough for choosing test inputs. */
export function seeded(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export const pick = <T>(random: () => number, values: readonly T[]): T =>
  values[Math.floor(random() * values.length)]!;

/** An integer in `[low, high]`. */
export const integer = (random: () => number, low: number, high: number): number =>
  low + Math.floor(random() * (high - low + 1));

export interface Position {
  /** How this position was reached, so a failing vector can be reproduced by hand. */
  readonly scramble: string;
  readonly facelets: string;
}

/**
 * Whole-cube rotations, applied to a share of the corpus.
 *
 * Without these the oracle is blind in a specific and dangerous way: `randomMoveScramble` emits
 * only face turns, so every position sits in standard orientation, the centres never move, and
 * `normalizeOrientation` and `isStandardOrientation` are exercised only on the one input where
 * they are trivially the identity. A port could get both completely wrong and the vectors would
 * agree with it.
 *
 * This was found by perturbing the engine and watching the drift test *pass*.
 */
const ROTATIONS = ["x", "x'", "x2", "y", "y'", "y2", "z", "z'", "z2"];

/**
 * A spread of positions, weighted towards the awkward ends of the space.
 *
 * Roughly: a tenth trivially shallow (0–3 moves, including solved), the rest ordinary scrambles of
 * varying depth. Shallow positions are the ones that expose off-by-one errors in search depth and
 * in "is this already done" predicates, and a uniform sample of 25-move scrambles contains none.
 */
export function positions(random: () => number, count: number): Position[] {
  const out: Position[] = [];
  for (let i = 0; i < count; i++) {
    const depth =
      i % 10 === 0 ? integer(random, 0, 3) : integer(random, 4, 25);
    const moves: Move[] = randomMoveScramble(depth, random);

    // A third of positions are left in a non-standard orientation. Rotations come last so the
    // face turns still describe the position they would have without them, which keeps the
    // scramble string a faithful recipe for reproducing the case by hand.
    const rotations =
      i % 3 === 0
        ? Array.from({ length: integer(random, 1, 2) }, () => pick(random, ROTATIONS))
        : [];
    const text = [serialize(moves), ...rotations].filter(Boolean).join(" ");
    out.push({
      scramble: text,
      facelets: toFacelets(applyMoves(CubeState.solved(), parseMoves(text))),
    });
  }
  return out;
}

/** Notation, with an empty sequence written as the empty string rather than as nothing. */
export function serialize(moves: readonly Move[]): string {
  return moves
    .map((move) => `${move.family}${move.amount === 2 ? "2" : move.amount === -1 ? "'" : ""}`)
    .join(" ");
}
