/**
 * Orientation.
 *
 * The identity below is the whole reason this module derives its table instead of declaring one.
 * `solver`'s `respell.ts` shipped with every rotation inverted, producing a different cube
 * position for every single input, and no test caught it because none of them asked the only
 * question that matters: after doing what you were told, is the cube where it should be?
 */
import { describe, expect, it } from "vitest";
import fc from "fast-check";
import {
  applyMoves,
  CubeState,
  Face,
  parseMoves,
  type Move,
} from "@cubing-companion/engine";
import {
  ORIENTATIONS,
  orientationsWithColourDown,
  renameMoves,
  renameSlot,
} from "../src/orientation.ts";

const FACE_FAMILIES = ["U", "D", "L", "R", "F", "B"] as const;

const arbitraryMoves = fc.array(
  fc.record({
    family: fc.constantFrom(...FACE_FAMILIES),
    amount: fc.constantFrom<1 | 2 | -1>(1, 2, -1),
  }),
  { minLength: 1, maxLength: 12 },
) as fc.Arbitrary<Move[]>;

const arbitraryState = fc
  .array(
    fc.record({
      family: fc.constantFrom(...FACE_FAMILIES),
      amount: fc.constantFrom<1 | 2 | -1>(1, 2, -1),
    }),
    { maxLength: 20 },
  )
  .map((moves) => applyMoves(CubeState.solved(), moves as Move[]));

describe("the set of orientations", () => {
  it("is all 24 of them, each reached the short way", () => {
    expect(ORIENTATIONS).toHaveLength(24);
    // Breadth-first, so no orientation needs more than two rotations.
    for (const orientation of ORIENTATIONS) {
      expect(orientation.rotation.length, orientation.text).toBeLessThanOrEqual(2);
    }
    expect(ORIENTATIONS[0]!.rotation).toEqual([]);
  });

  it("reaches a different centre arrangement in each", () => {
    const seen = new Set(ORIENTATIONS.map((o) => o.colourAt.join(",")));
    expect(seen.size).toBe(24);
  });

  it("offers exactly four ways to put any colour down", () => {
    for (const face of [Face.U, Face.L, Face.F, Face.R, Face.B, Face.D]) {
      const found = orientationsWithColourDown(face);
      expect(found, `colour ${face}`).toHaveLength(4);
      for (const orientation of found) expect(orientation.colourAt[Face.D]).toBe(face);
      // And the four differ in what faces you: that is the freedom a cross leaves.
      expect(new Set(found.map((o) => o.colourAt[Face.F])).size).toBe(4);
    }
  });
});

describe("renaming", () => {
  it("holds the identity it is built from, for any sequence and any frame", () => {
    // Rotate then turn the renamed moves === turn the original moves then rotate.
    fc.assert(
      fc.property(arbitraryState, arbitraryMoves, (state, moves) => {
        for (const orientation of ORIENTATIONS) {
          const rotated = applyMoves(
            applyMoves(state, orientation.rotation),
            renameMoves(moves, orientation),
          );
          const direct = applyMoves(applyMoves(state, moves), orientation.rotation);
          expect(rotated.equals(direct), orientation.text).toBe(true);
        }
      }),
      { numRuns: 30 },
    );
  });

  it("is a permutation of the six faces, never a collapse", () => {
    for (const orientation of ORIENTATIONS) {
      const images = FACE_FAMILIES.map((face) => orientation.rename[face]);
      expect(new Set(images).size, orientation.text).toBe(6);
    }
  });

  it("leaves everything alone in the identity frame", () => {
    const identity = ORIENTATIONS[0]!;
    const moves = parseMoves("R U' F2 L B D");
    expect(renameMoves(moves, identity)).toEqual(moves);
    expect(renameSlot("FR", identity)).toBe("FR");
  });

  it("keeps up and down fixed under a y turn, and cycles the sides", () => {
    const y = ORIENTATIONS.find((o) => o.text === "y")!;
    expect(y.rename.U).toBe("U");
    expect(y.rename.D).toBe("D");
    // The point of the whole exercise: a back turn becomes a right turn.
    expect(y.rename.B).toBe("R");
  });

  it("preserves the amount, only ever the face", () => {
    const moves = parseMoves("R2 U' B");
    for (const orientation of ORIENTATIONS) {
      expect(renameMoves(moves, orientation).map((m) => m.amount)).toEqual([2, -1, 1]);
    }
  });

  it("renames a slot the same way it renames a turn", () => {
    const y = ORIENTATIONS.find((o) => o.text === "y")!;
    // FR is made of an F and an R; each goes through the same map.
    expect(renameSlot("FR", y)).toBe(`${y.rename.F}${y.rename.R}`);
  });

  it("refuses a move it cannot re-orient rather than guessing", () => {
    const y = ORIENTATIONS.find((o) => o.text === "y")!;
    expect(() => renameMoves(parseMoves("Rw"), y)).toThrow(/re-orient/);
    expect(() => renameMoves(parseMoves("M"), y)).toThrow(/re-orient/);
  });
});
