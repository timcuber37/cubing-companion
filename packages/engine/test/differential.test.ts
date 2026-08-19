/**
 * Differential test against cubing.js's KPuzzle.
 *
 * The move tables are generated from cubing.js, so this is not testing them — it is
 * testing everything built on top: family/alias resolution, amount normalization, the
 * composition function, the apply loop, and the notation layer. Those are the parts we
 * actually wrote, and a disagreement here means one of them is wrong.
 */
import { describe, expect, it } from "vitest";
import fc from "fast-check";
import { cube3x3x3 } from "cubing/puzzles";
import { FAMILIES } from "../src/tables.ts";
import { parseMoves, serializeMoves } from "../src/notation.ts";
import { invertMoves, stateAfter, type Move } from "../src/moves.ts";
import { CubeState } from "../src/state.ts";

const kpuzzle = await cube3x3x3.kpuzzle();

/** Every family the engine claims to support, plus the aliases it claims to resolve. */
const WRITTEN_FAMILIES = [
  ...FAMILIES,
  "u", "d", "l", "r", "f", "b",
  "Uv", "Dv", "Rv", "Lv", "Fv", "Bv",
];

/** Write an amount the way notation does: `R`, `R2`, `R'`, `R3`, `R2'`. */
function writeAmount(amount: number): string {
  if (amount === 1) return "";
  if (amount === -1) return "'";
  return amount > 0 ? `${amount}` : `${-amount}'`;
}

const moveArb = fc.record({
  family: fc.constantFrom(...WRITTEN_FAMILIES),
  // Includes over-turns (3, -2, -3) so amount normalization is exercised, not just 1/2/'.
  amount: fc.constantFrom(1, 2, -1, 3, -2, -3),
});

const algArb = fc
  .array(moveArb, { minLength: 0, maxLength: 40 })
  .map((moves) =>
    moves.map((m) => `${m.family}${writeAmount(m.amount)}`).join(" "),
  );

/** Reference state from cubing.js, in the same shape our engine uses. */
function reference(algString: string) {
  const data = kpuzzle.defaultPattern().applyAlg(algString).patternData;
  return {
    cp: [...data.CORNERS!.pieces],
    co: [...data.CORNERS!.orientation],
    ep: [...data.EDGES!.pieces],
    eo: [...data.EDGES!.orientation],
    // Centre *twist* is invisible on a standard 3x3 and is not modelled; cubing.js masks
    // it too, via orientationMod 1 in the default pattern.
    centers: [...data.CENTERS!.pieces],
  };
}

function ours(state: CubeState) {
  return {
    cp: [...state.cp],
    co: [...state.co],
    ep: [...state.ep],
    eo: [...state.eo],
    centers: [...state.centers],
  };
}

describe("differential vs cubing.js KPuzzle", () => {
  it("agrees on random algs over every family and alias", () => {
    fc.assert(
      fc.property(algArb, (algString) => {
        expect(ours(stateAfter(parseMoves(algString)))).toEqual(
          reference(algString),
        );
      }),
      { numRuns: 750 },
    );
  });

  it("agrees on each family and amount individually", () => {
    for (const family of WRITTEN_FAMILIES) {
      for (const suffix of ["", "2", "'"]) {
        const algString = `${family}${suffix}`;
        // Tag the payload with the alg so a failure names the culprit directly.
        expect({ algString, ...ours(stateAfter(parseMoves(algString))) }).toEqual({
          algString,
          ...reference(algString),
        });
      }
    }
  });

  it("agrees that serializing then reparsing preserves the state", () => {
    fc.assert(
      fc.property(algArb, (algString) => {
        const moves = parseMoves(algString);
        const roundTripped = parseMoves(serializeMoves(moves));
        expect(ours(stateAfter(roundTripped))).toEqual(reference(algString));
      }),
      { numRuns: 300 },
    );
  });

  it("agrees on inverses", () => {
    fc.assert(
      fc.property(algArb, (algString) => {
        const moves = parseMoves(algString);
        const inverted = invertMoves(moves);
        expect(ours(stateAfter(inverted))).toEqual(
          reference(serializeMoves(inverted)),
        );
        // ...and an alg followed by its inverse must land back on solved.
        expect(stateAfter([...moves, ...inverted]).isSolved()).toBe(true);
      }),
      { numRuns: 300 },
    );
  });
});
