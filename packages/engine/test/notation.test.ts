import { describe, expect, it } from "vitest";
import fc from "fast-check";
import {
  NotationError,
  parseMoves,
  serializeMoves,
  toAlg,
} from "../src/notation.ts";
import { stateAfter, type Move } from "../src/moves.ts";
import { FAMILIES } from "../src/tables.ts";

const moveArb: fc.Arbitrary<Move> = fc.record({
  family: fc.constantFrom(...FAMILIES),
  amount: fc.constantFrom<1 | 2 | -1>(1, 2, -1),
});

describe("notation round-trip", () => {
  it("survives parse(serialize(moves))", () => {
    fc.assert(
      fc.property(fc.array(moveArb, { maxLength: 40 }), (moves) => {
        expect(parseMoves(serializeMoves(moves))).toEqual(moves);
      }),
      { numRuns: 400 },
    );
  });

  it("serializes amounts conventionally", () => {
    expect(serializeMoves(parseMoves("R R2 R'"))).toBe("R R2 R'");
    expect(serializeMoves(parseMoves("R3"))).toBe("R'");
    expect(serializeMoves(parseMoves("R2'"))).toBe("R2");
  });

  it("converts back to a cubing.js Alg for the twisty player and solvers", () => {
    const alg = toAlg(parseMoves("R U R' // sexy\nd M2"));
    expect(alg.toString()).toBe("R U R' Dw M2");
    // Round trips through cubing.js without losing anything.
    expect(parseMoves(alg.toString())).toEqual(parseMoves("R U R' d M2"));
  });
});

describe("the reconstruction dialect", () => {
  // These forms all appear in real reco.nz reconstructions.
  it("accepts line comments and newlines", () => {
    const moves = parseMoves("x2 // inspection\nR U R' // first pair");
    expect(serializeMoves(moves)).toBe("x2 R U R'");
  });

  it("accepts repeated tokens instead of doubles", () => {
    expect(stateAfter(parseMoves("D D")).bytes).toEqual(
      stateAfter(parseMoves("D2")).bytes,
    );
    expect(stateAfter(parseMoves("U U")).bytes).toEqual(
      stateAfter(parseMoves("U2")).bytes,
    );
  });

  it("accepts lowercase wide moves", () => {
    expect(parseMoves("d")).toEqual([{ family: "Dw", amount: 1 }]);
    expect(stateAfter(parseMoves("r U' r'")).bytes).toEqual(
      stateAfter(parseMoves("Rw U' Rw'")).bytes,
    );
  });

  it("accepts a prime on a double", () => {
    expect(parseMoves("F2'")).toEqual([{ family: "F", amount: 2 }]);
  });

  it("expands commutators and conjugates", () => {
    expect(serializeMoves(parseMoves("[R, U]"))).toBe("R U R' U'");
    expect(serializeMoves(parseMoves("[F: [R, U]]"))).toBe("F R U R' U' F'");
  });

  it("expands groupings with repetition", () => {
    expect(serializeMoves(parseMoves("(R U)3"))).toBe("R U R U R U");
  });

  it("parses a full reconstruction with mixed annotations", () => {
    // Max Park's 3.13 WR (reco.nz solve 9155), phase by phase.
    const phases = [
      "x2 // inspection",
      "R' D D R' D L' U L D R' U' R D // xxcross",
      "L U' L' // 3rd pair",
      "U' R U R' d R' U' R // 4th pair",
      "r' U' R U' R' U U r // OLL(CP)",
      "U // AUF",
    ];
    expect(phases.map((p) => parseMoves(p).length)).toEqual([1, 13, 3, 8, 8, 1]);
    expect(parseMoves(phases.join("\n")).length).toBe(34);
  });
});

describe("notation errors", () => {
  it("rejects malformed syntax", () => {
    expect(() => parseMoves("R (U")).toThrow(NotationError);
  });

  it("rejects unrecognized move families", () => {
    expect(() => parseMoves("Q")).toThrow(/unrecognized move family/);
  });

  it("rejects layer-prefixed big-cube moves rather than mistaking them for face turns", () => {
    // `2U` parses with family "U" and innerLayer 2. Accepting it would silently apply a
    // plain U, which is a different move.
    for (const alg of ["2U", "3Rw", "2R", "2-3r"]) {
      expect(() => parseMoves(alg)).toThrow(/layer-prefixed/);
    }
  });

  it("accepts the empty alg", () => {
    expect(parseMoves("")).toEqual([]);
    expect(serializeMoves([])).toBe("");
  });
});
