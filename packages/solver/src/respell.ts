/**
 * Rewriting a solution the way a person would turn it.
 *
 * The search runs over face turns because wide moves buy nothing there — measured: they give a
 * shorter cross for 0 of 190,080 positions, since `Rw` is just `L` composed with an `x` rotation
 * and a cross does not care how the cube is held. But a speedsolver does not turn `L`; from a
 * normal grip they turn `Rw` and carry on in the new orientation.
 *
 * So spellings are recovered afterwards. This is presentation, not search: the rewritten
 * sequence reaches exactly the same position, and the turn count is unchanged.
 */
import {
  serializeMoves,
  type Family,
  type Move,
} from "@cubing-companion/engine";

/**
 * How to say a face turn as a wide move.
 *
 * `Rw` is `L` followed by `x`, so writing `Rw` in place of `L` leaves the cube rotated and
 * everything after it expressed in the wrong frame. The compensating rotation puts it back.
 *
 * The signs were derived by exhaustive comparison rather than reasoning — an earlier version
 * inverted every one of them, which no test would have caught because there were none.
 */
const WIDE_EQUIVALENT: Readonly<
  Record<string, { wide: Family; axis: Family; sign: 1 | -1 }>
> = {
  L: { wide: "Rw", axis: "x", sign: -1 },
  R: { wide: "Lw", axis: "x", sign: 1 },
  D: { wide: "Uw", axis: "y", sign: -1 },
  U: { wide: "Dw", axis: "y", sign: 1 },
  B: { wide: "Fw", axis: "z", sign: -1 },
  F: { wide: "Bw", axis: "z", sign: 1 },
};

export interface Respelling {
  /** The moves as they would be turned, including the wide move and its rotation. */
  readonly moves: readonly Move[];
  readonly text: string;
  /** Rotations the spelling introduces — a cost a human pays that a turn count hides. */
  readonly rotations: number;
}

/**
 * Express one face turn of a solution as a wide move.
 *
 * Deliberately narrow: it respells the turn it is told to. Deciding *which* turns are more
 * comfortable wide is an ergonomics question — it depends on grip, on what follows, and on the
 * solver — and guessing at it here would be inventing an opinion the data has not earned. That
 * judgement belongs to A5, which has a corpus of what people actually did to learn it from.
 *
 * @returns the rewritten sequence, or `null` if that move has no wide equivalent.
 */
export function respellAsWide(
  moves: readonly Move[],
  index: number,
): Respelling | null {
  const target = moves[index];
  if (!target) return null;
  const equivalent = WIDE_EQUIVALENT[target.family];
  if (!equivalent) return null;

  // The rotation carries the same amount as the turn; a half turn is its own inverse, so its
  // sign does not matter.
  const rotationAmount: 1 | 2 | -1 =
    target.amount === 2 ? 2 : ((equivalent.sign * target.amount) as 1 | -1);

  const rewritten: Move[] = [
    ...moves.slice(0, index),
    { family: equivalent.wide, amount: target.amount },
    { family: equivalent.axis, amount: rotationAmount },
    ...moves.slice(index + 1),
  ];

  return {
    moves: rewritten,
    text: serializeMoves(rewritten),
    rotations: rewritten.filter((m) => "xyz".includes(m.family)).length,
  };
}

/** Whether a family can be said as a wide move. */
export function hasWideEquivalent(family: string): boolean {
  return family in WIDE_EQUIVALENT;
}
