import { describe, expect, it } from "vitest";
import fc from "fast-check";
import {
  applyMoveInPlace,
  applyMoves,
  invertMoves,
  makeMove,
  normalizeAmount,
  stateAfter,
  type Move,
} from "../src/moves.ts";
import { CubeState } from "../src/state.ts";
import { FAMILIES } from "../src/tables.ts";
import { parseMoves } from "../src/notation.ts";

const moveArb: fc.Arbitrary<Move> = fc.record({
  family: fc.constantFrom(...FAMILIES),
  amount: fc.constantFrom<1 | 2 | -1>(1, 2, -1),
});
const algArb = fc.array(moveArb, { maxLength: 40 });

/** Parity of a permutation: 0 for even, 1 for odd. */
function parity(perm: Uint8Array): number {
  const seen = new Array<boolean>(perm.length).fill(false);
  let transpositions = 0;
  for (let i = 0; i < perm.length; i++) {
    if (seen[i]) continue;
    let length = 0;
    for (let j = i; !seen[j]; j = perm[j]!) {
      seen[j] = true;
      length++;
    }
    transpositions += length - 1;
  }
  return transpositions & 1;
}

describe("move application", () => {
  it("is not vacuous: a real scramble does not leave the cube solved", () => {
    const scrambled = stateAfter(
      parseMoves("D U F2' L2 U' B2 F2 D L2 U R' F' D R' F' U L D' F' D R2"),
    );
    expect(scrambled.isSolved()).toBe(false);
  });

  it("gives every family order 4", () => {
    for (const family of FAMILIES) {
      const quarter: Move = { family, amount: 1 };
      expect(stateAfter([quarter, quarter, quarter, quarter]).isSolved()).toBe(true);
      // ...and not sooner, so no family is silently a no-op.
      expect(stateAfter([quarter]).isSolved()).toBe(false);
      expect(stateAfter([quarter, quarter]).isSolved()).toBe(false);
    }
  });

  it("makes a double equal two quarters, and a prime equal three", () => {
    for (const family of FAMILIES) {
      const q: Move = { family, amount: 1 };
      expect(stateAfter([{ family, amount: 2 }]).bytes).toEqual(
        stateAfter([q, q]).bytes,
      );
      expect(stateAfter([{ family, amount: -1 }]).bytes).toEqual(
        stateAfter([q, q, q]).bytes,
      );
    }
  });

  it("returns to solved after an alg followed by its inverse", () => {
    fc.assert(
      fc.property(algArb, (moves) => {
        expect(stateAfter([...moves, ...invertMoves(moves)]).isSolved()).toBe(true);
      }),
      { numRuns: 400 },
    );
  });

  it("preserves cube invariants under any alg", () => {
    fc.assert(
      fc.property(algArb, (moves) => {
        const state = stateAfter(moves);
        const sum = (a: Uint8Array) => a.reduce((acc, v) => acc + v, 0);
        expect(sum(state.co) % 3).toBe(0);
        expect(sum(state.eo) % 2).toBe(0);
        // Corner, edge, and centre permutation parities must cancel. Face turns keep
        // corner and edge parity equal; slices and rotations shift centre parity too.
        expect(
          parity(state.cp) ^ parity(state.ep) ^ parity(state.centers),
        ).toBe(0);
      }),
      { numRuns: 400 },
    );
  });

  it("agrees between in-place and copying application", () => {
    fc.assert(
      fc.property(algArb, (moves) => {
        const inPlace = CubeState.solved();
        for (const move of moves) applyMoveInPlace(inPlace, move);
        expect(inPlace.bytes).toEqual(applyMoves(CubeState.solved(), moves).bytes);
      }),
      { numRuns: 200 },
    );
  });

  it("leaves the source untouched when copying", () => {
    const start = CubeState.solved();
    applyMoves(start, parseMoves("R U R' U'"));
    expect(start.isSolved()).toBe(true);
  });
});

describe("amount normalization", () => {
  it("reduces modulo 4", () => {
    expect(normalizeAmount(1)).toBe(1);
    expect(normalizeAmount(2)).toBe(2);
    expect(normalizeAmount(3)).toBe(-1);
    expect(normalizeAmount(-1)).toBe(-1);
    expect(normalizeAmount(-2)).toBe(2);
    expect(normalizeAmount(5)).toBe(1);
    expect(normalizeAmount(0)).toBe(0);
    expect(normalizeAmount(4)).toBe(0);
    expect(normalizeAmount(-4)).toBe(0);
  });

  it("treats whole rotations as no-ops rather than errors", () => {
    expect(makeMove("R", 4)).toBeNull();
    expect(parseMoves("R4")).toEqual([]);
    expect(parseMoves("R U R4 U'")).toEqual(parseMoves("R U U'"));
  });

  it("rejects unknown families", () => {
    expect(makeMove("Q", 1)).toBeUndefined();
  });

  it("resolves aliases to canonical families", () => {
    expect(makeMove("r", 1)).toEqual({ family: "Rw", amount: 1 });
    expect(makeMove("Rv", 1)).toEqual({ family: "x", amount: 1 });
    // Lv is the rotation following L, so it turns opposite to x.
    expect(makeMove("Lv", 1)).toEqual({ family: "x", amount: -1 });
    expect(makeMove("Dv", 2)).toEqual({ family: "y", amount: 2 });
  });
});
