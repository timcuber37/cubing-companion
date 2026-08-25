/**
 * The move set the search runs over, and why it is only face turns.
 *
 * Eighteen outer-face quarter and half turns — HTM, the metric published cross results use.
 *
 * Wide moves are deliberately absent, and this was measured rather than assumed: adding all
 * six wide families produces a shorter cross for **0 of the 190,080 cross positions**, with a
 * byte-identical depth histogram. `Rw` is `L` composed with an `x` rotation, and a cross is
 * rotation-invariant, so every wide move exactly duplicates a face turn already here. Including
 * them would double the branching factor — compounding at every ply of the xcross search — to
 * buy nothing. See `respell.ts` for recovering wide-move spellings afterwards.
 */
import type { Move } from "@cubing-companion/engine";

export const FACE_FAMILIES = ["U", "D", "L", "R", "F", "B"] as const;
export const AMOUNTS: readonly (1 | 2 | -1)[] = [1, 2, -1];

/** The 18 HTM moves, in a fixed order so enumeration is deterministic. */
export const SEARCH_MOVES: readonly Move[] = FACE_FAMILIES.flatMap((family) =>
  AMOUNTS.map((amount) => ({ family, amount }) as Move),
);

const FAMILY_ORDER = new Map(FACE_FAMILIES.map((f, i) => [f as string, i]));

/** Opposite faces commute: turning one never disturbs the other. */
export const OPPOSITE_FAMILY: Readonly<Record<string, string>> = {
  U: "D",
  D: "U",
  L: "R",
  R: "L",
  F: "B",
  B: "F",
};

/**
 * Whether `next` may follow `previous`.
 *
 * Both prunings are exact — they remove only redundant spellings of sequences the search is
 * already covering, so no solution is lost:
 *
 * - **Same face twice.** `R R` is `R2` written long, and `R2` is already a move.
 * - **A commuting pair in the wrong order.** `L` and `R` commute, so `R L` and `L R` reach the
 *   same position; only the canonical order is searched. This subsumes the `R L R` case as
 *   well — that sequence cannot be built at all once one order of the pair is blocked, so no
 *   separate check for it is needed.
 */
export function allowed(next: Move, previous: Move | undefined): boolean {
  if (previous === undefined) return true;
  if (next.family === previous.family) return false;
  if (OPPOSITE_FAMILY[previous.family] !== next.family) return true;
  // A commuting pair: accept only the canonical order.
  return FAMILY_ORDER.get(next.family)! > FAMILY_ORDER.get(previous.family)!;
}
