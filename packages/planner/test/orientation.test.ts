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
  frameFor,
  ORIENTATIONS,
  orientationsWithColourDown,
  renameMoves,
  renameSlot,
  rotationBetween,
  rotationPuttingColourDown,
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

  it("renames wide and slice moves under the same identity as everything else", () => {
    // These appear in stored solutions (pasted reconstructions use them freely), and the replay
    // renames its displayed text — so the renaming has to be total over the engine's families.
    const moves = parseMoves("Rw M U E' Fw2 S");
    for (const orientation of ORIENTATIONS) {
      const rotated = applyMoves(
        applyMoves(CubeState.solved(), orientation.rotation),
        renameMoves(moves, orientation),
      );
      const direct = applyMoves(applyMoves(CubeState.solved(), moves), orientation.rotation);
      expect(rotated.equals(direct), orientation.text).toBe(true);
    }
  });
});

/**
 * The frame bug, as a property.
 *
 * The old suite scrambled with face turns only, so every test state had its centres home and the
 * recommended grip's rotation happened to be correct from the "raw" state too. Real cubes are
 * not so obliging: a manual solve rotates mid-scramble, and a recommendation that is not
 * literally executable from the position the cube is actually in solves the wrong pieces.
 */
describe("rotationBetween", () => {
  const withPrefix = fc
    .array(
      fc.record({
        family: fc.constantFrom("x", "y", "z", "U", "D", "L", "R", "F", "B"),
        amount: fc.constantFrom<1 | 2 | -1>(1, 2, -1),
      }),
      { maxLength: 14 },
    )
    .map((moves) => applyMoves(CubeState.solved(), moves as Move[]));

  it("lands exactly on the requested arrangement, in at most two rotations", () => {
    fc.assert(
      fc.property(withPrefix, fc.integer({ min: 0, max: 23 }), (state, pick) => {
        const target = ORIENTATIONS[pick]!.colourAt;
        const path = rotationBetween(state.centers, target);
        expect(path.length).toBeLessThanOrEqual(2);
        for (const move of path) expect("xyz").toContain(move.family);
        expect([...applyMoves(state, path).centers]).toEqual([...target]);
      }),
      { numRuns: 80 },
    );
  });

  it("is empty when the cube is already there", () => {
    const state = applyMoves(CubeState.solved(), parseMoves("R U R'"));
    expect(rotationBetween(state.centers, state.centers)).toEqual([]);
  });

  it("puts a colour on the bottom by the shortest route", () => {
    fc.assert(
      fc.property(withPrefix, fc.integer({ min: 0, max: 5 }), (state, colour) => {
        const path = rotationPuttingColourDown(state.centers, colour as Face);
        expect(path.length).toBeLessThanOrEqual(2);
        expect(applyMoves(state, path).centers[Face.D]).toBe(colour);
      }),
      { numRuns: 60 },
    );
  });
});

describe("renaming rotations", () => {
  it("holds the same identity face turns do, for every frame", () => {
    // The reason it is a move-level map: `x` follows R, so a frame mapping R to L must map `x`
    // to `x'` — the amount flips, which face turns never do.
    fc.assert(
      fc.property(
        fc.array(
          fc.record({
            family: fc.constantFrom("U", "R", "F", "x", "y", "z"),
            amount: fc.constantFrom<1 | 2 | -1>(1, 2, -1),
          }),
          { minLength: 1, maxLength: 8 },
        ),
        (moves) => {
          for (const orientation of ORIENTATIONS) {
            const rotated = applyMoves(
              applyMoves(CubeState.solved(), orientation.rotation),
              renameMoves(moves as Move[], orientation),
            );
            const direct = applyMoves(
              applyMoves(CubeState.solved(), moves as Move[]),
              orientation.rotation,
            );
            expect(rotated.equals(direct), orientation.text).toBe(true);
          }
        },
      ),
      { numRuns: 25 },
    );
  });

  it("flips the sign where the axis maps to its opposite", () => {
    // y2 maps R to L, so x must become x'. Asserted concretely, not just via the property.
    const y2 = ORIENTATIONS.find((o) => o.text === "y2")!;
    expect(renameMoves(parseMoves("x"), y2)).toEqual(parseMoves("x'"));
  });

  it("builds a frame for an arbitrary rotation, not only the 24 shortest", () => {
    const frame = frameFor(parseMoves("y x y'"));
    const moves = parseMoves("R U F x");
    const rotated = applyMoves(
      applyMoves(CubeState.solved(), frame.rotation),
      renameMoves(moves, frame),
    );
    const direct = applyMoves(applyMoves(CubeState.solved(), moves), frame.rotation);
    expect(rotated.equals(direct)).toBe(true);
  });
});
