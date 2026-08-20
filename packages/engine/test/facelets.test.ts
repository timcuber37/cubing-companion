/**
 * Facelet tests.
 *
 * The load-bearing vector comes from gan-web-bluetooth's documentation, which states the
 * facelet string after `F R`. Because the Kociemba layout is a published standard rather
 * than our own convention, agreeing with it is genuine external corroboration — not a
 * restatement of our own piece indexing.
 */
import { describe, expect, it } from "vitest";
import fc from "fast-check";
import {
  FaceletError,
  faceletsEqual,
  fromFacelets,
  NUM_FACELETS,
  toFacelets,
} from "../src/facelets.ts";
import { parseMoves } from "../src/notation.ts";
import { stateAfter, type Move } from "../src/moves.ts";
import { CubeState } from "../src/state.ts";
import { FAMILIES } from "../src/tables.ts";

const SOLVED =
  "UUUUUUUUURRRRRRRRRFFFFFFFFFDDDDDDDDDLLLLLLLLLBBBBBBBBB";

const moveArb: fc.Arbitrary<Move> = fc.record({
  family: fc.constantFrom(...FAMILIES),
  amount: fc.constantFrom<1 | 2 | -1>(1, 2, -1),
});

describe("rendering facelets", () => {
  it("renders a solved cube", () => {
    expect(toFacelets(CubeState.solved())).toBe(SOLVED);
    expect(SOLVED).toHaveLength(NUM_FACELETS);
  });

  it("matches the externally published vector for F R", () => {
    // From gan-web-bluetooth's `toKociembaFacelets` documentation.
    expect(toFacelets(stateAfter(parseMoves("F R")))).toBe(
      "UUFUUFLLFUUURRRRRRFFRFFDFFDRRBDDBDDBLLDLLDLLDLBBUBBUBB",
    );
  });

  it("uses exactly nine of each colour, always", () => {
    fc.assert(
      fc.property(fc.array(moveArb, { maxLength: 30 }), (moves) => {
        const counts = new Map<string, number>();
        for (const ch of toFacelets(stateAfter(moves))) {
          counts.set(ch, (counts.get(ch) ?? 0) + 1);
        }
        expect([...counts.values()].sort()).toEqual([9, 9, 9, 9, 9, 9]);
      }),
      { numRuns: 300 },
    );
  });

  it("keeps centres where the face is, so a rotation rotates the string", () => {
    // After y the F face shows what was the R colour — what a camera would see.
    const afterY = toFacelets(stateAfter(parseMoves("y")));
    expect(afterY.slice(18, 27)).toBe("RRRRRRRRR");
    expect(afterY.slice(0, 9)).toBe("UUUUUUUUU");
    // A rotated solved cube is still nine of each colour, just relabelled.
    expect(afterY).not.toBe(SOLVED);
  });

  it("distinguishes states that differ only by orientation of one piece", () => {
    expect(toFacelets(stateAfter(parseMoves("R")))).not.toBe(
      toFacelets(stateAfter(parseMoves("R'"))),
    );
  });
});

describe("parsing facelets", () => {
  it("round-trips any state", () => {
    fc.assert(
      fc.property(fc.array(moveArb, { maxLength: 30 }), (moves) => {
        const state = stateAfter(moves);
        const parsed = fromFacelets(toFacelets(state));
        expect(parsed.bytes).toEqual(state.bytes);
      }),
      { numRuns: 400 },
    );
  });

  it("parses the solved string", () => {
    expect(fromFacelets(SOLVED).isSolved()).toBe(true);
  });

  it("parses a rotated cube as rotated, not as scrambled", () => {
    const rotated = stateAfter(parseMoves("y"));
    const parsed = fromFacelets(toFacelets(rotated));
    expect(parsed.bytes).toEqual(rotated.bytes);
    expect(parsed.isSolved()).toBe(false);
  });

  it("rejects a string of the wrong length", () => {
    expect(() => fromFacelets("UUU")).toThrow(FaceletError);
    expect(() => fromFacelets(`${SOLVED}U`)).toThrow(/54 facelets/);
  });

  it("rejects unknown characters", () => {
    expect(() => fromFacelets(SOLVED.replace("U", "X"))).toThrow(
      /unknown facelet character/,
    );
  });

  it("rejects a physically incoherent cube", () => {
    // Two stickers of the same colour on one corner cannot happen.
    const broken = SOLVED.split("");
    broken[9] = "U"; // corner URF now reads U,U,F
    expect(() => fromFacelets(broken.join(""))).toThrow(FaceletError);
  });
});

describe("faceletsEqual", () => {
  it("agrees with byte equality for states reached by moves", () => {
    fc.assert(
      fc.property(
        fc.array(moveArb, { maxLength: 20 }),
        fc.array(moveArb, { maxLength: 20 }),
        (a, b) => {
          const stateA = stateAfter(a);
          const stateB = stateAfter(b);
          expect(faceletsEqual(stateA, stateB)).toBe(stateA.equals(stateB));
        },
      ),
      { numRuns: 200 },
    );
  });
});
