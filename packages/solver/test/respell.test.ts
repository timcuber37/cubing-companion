/**
 * Respelling tests.
 *
 * The one property that matters: a respelled sequence must reach exactly the same position.
 * Everything else is cosmetic, and a respelling that quietly changed the cube would be worse
 * than none at all — it would hand a solver a suggestion that does not work.
 *
 * These exist because the first version of this module had every rotation inverted, and shipped
 * with no tests to notice.
 */
import { describe, expect, it } from "vitest";
import fc from "fast-check";
import {
  parseMoves,
  serializeMoves,
  stateAfter,
  toFacelets,
  type Move,
} from "@cubing-companion/engine";
import { hasWideEquivalent, respellAsWide } from "../src/respell.ts";

const FACE_FAMILIES = ["U", "D", "L", "R", "F", "B"] as const;

const moveArb: fc.Arbitrary<Move> = fc.record({
  family: fc.constantFrom(...FACE_FAMILIES),
  amount: fc.constantFrom<1 | 2 | -1>(1, 2, -1),
});

describe("respelling preserves the position", () => {
  it("holds for every face and amount", () => {
    for (const family of FACE_FAMILIES) {
      for (const amount of [1, 2, -1] as const) {
        const moves: Move[] = [{ family, amount }];
        const respelled = respellAsWide(moves, 0)!;
        expect(respelled, `${family}${amount}`).not.toBeNull();
        expect(
          toFacelets(stateAfter(respelled.moves)),
          `${family} ${amount} became ${respelled.text}`,
        ).toBe(toFacelets(stateAfter(moves)));
      }
    }
  });

  it("holds anywhere within a longer sequence", () => {
    // The rotation has to leave the frame correct for everything that follows, so respelling a
    // move in the middle is the case that catches a wrong direction.
    fc.assert(
      fc.property(
        fc.array(moveArb, { minLength: 1, maxLength: 10 }),
        fc.nat(),
        (moves, seed) => {
          const index = seed % moves.length;
          const respelled = respellAsWide(moves, index);
          if (!respelled) return;
          expect(toFacelets(stateAfter(respelled.moves))).toBe(
            toFacelets(stateAfter(moves)),
          );
        },
      ),
      { numRuns: 300 },
    );
  });

  it("produces the known spellings", () => {
    // Derived by exhaustive comparison against the engine; pinned so a sign flip is caught.
    const cases: [string, string][] = [
      ["L", "Rw x'"],
      ["L2", "Rw2 x2"],
      ["L'", "Rw' x"],
      ["R", "Lw x"],
      ["R'", "Lw' x'"],
      ["U", "Dw y"],
      ["D", "Uw y'"],
      ["F", "Bw z"],
      ["B", "Fw z'"],
    ];
    for (const [input, expected] of cases) {
      const respelled = respellAsWide(parseMoves(input), 0)!;
      expect(respelled.text, input).toBe(expected);
    }
  });
});

describe("respelling shape", () => {
  it("keeps the turn count and adds exactly one rotation", () => {
    const moves = parseMoves("R U L D2 F");
    const respelled = respellAsWide(moves, 2)!;
    expect(respelled.rotations).toBe(1);
    // One move became two: the wide turn and its rotation.
    expect(respelled.moves).toHaveLength(moves.length + 1);
    const turns = respelled.moves.filter((m) => !"xyz".includes(m.family));
    expect(turns).toHaveLength(moves.length);
  });

  it("leaves the rest of the sequence alone", () => {
    const moves = parseMoves("R U L D2 F");
    const respelled = respellAsWide(moves, 2)!;
    expect(serializeMoves(respelled.moves.slice(0, 2))).toBe("R U");
    expect(serializeMoves(respelled.moves.slice(4))).toBe("D2 F");
  });

  it("declines what it cannot respell", () => {
    expect(respellAsWide(parseMoves("M"), 0)).toBeNull();
    expect(respellAsWide(parseMoves("x"), 0)).toBeNull();
    expect(respellAsWide(parseMoves("Rw"), 0)).toBeNull();
    expect(respellAsWide(parseMoves("R U"), 5)).toBeNull();
    expect(respellAsWide([], 0)).toBeNull();
  });

  it("reports which families it can handle", () => {
    for (const family of FACE_FAMILIES) expect(hasWideEquivalent(family)).toBe(true);
    for (const family of ["M", "E", "S", "x", "y", "z", "Rw"]) {
      expect(hasWideEquivalent(family), family).toBe(false);
    }
  });
});
