import { describe, expect, it } from "vitest";
import fc from "fast-check";
import {
  colorOnFace,
  isCornerSolved,
  isEdgeSolved,
  isSolvedIgnoringOrientation,
  isStandardOrientation,
  ORIENTATION_COUNT,
  whereIsCorner,
  whereIsEdge,
} from "../src/predicates.ts";
import { stateAfter, type Move } from "../src/moves.ts";
import { parseMoves } from "../src/notation.ts";
import { CubeState, EDGE_NAMES, Face } from "../src/state.ts";
import { FAMILIES } from "../src/tables.ts";

const moveArb: fc.Arbitrary<Move> = fc.record({
  family: fc.constantFrom(...FAMILIES),
  amount: fc.constantFrom<1 | 2 | -1>(1, 2, -1),
});

const ROTATIONS = ["", "x", "y", "z", "x y", "x2", "y2", "z2", "x y z", "y' x2 z"];

describe("orientation", () => {
  it("finds exactly 24 whole-cube orientations", () => {
    // Derived by search over x/y/z rather than hard-coded, so this also confirms the
    // rotation tables generate the full rotation group and nothing more.
    expect(ORIENTATION_COUNT).toBe(24);
  });

  it("treats a rotated solved cube as solved, but not as standard", () => {
    for (const rotation of ROTATIONS) {
      const state = stateAfter(parseMoves(rotation));
      expect(isSolvedIgnoringOrientation(state)).toBe(true);
      expect(isStandardOrientation(state)).toBe(rotation === "");
      expect(state.isSolved()).toBe(rotation === "");
    }
  });

  it("matches brute-force search over all 24 rotations", () => {
    // Independent definition: the cube is physically solved iff some whole-cube rotation
    // brings it to the identity. Built from notation rather than from the same table the
    // implementation uses, so agreement is meaningful.
    const rotationAlgs = ["", "x", "x2", "x'", "z", "z'"].flatMap((tilt) =>
      ["", "y", "y2", "y'"].map((spin) => `${tilt} ${spin}`.trim()),
    );
    expect(new Set(rotationAlgs).size).toBe(24);

    fc.assert(
      fc.property(fc.array(moveArb, { maxLength: 20 }), (moves) => {
        const state = stateAfter(moves);
        const bruteForce = rotationAlgs.some((rotation) =>
          stateAfter([...moves, ...parseMoves(rotation)]).isSolved(),
        );
        expect(isSolvedIgnoringOrientation(state)).toBe(bruteForce);
      }),
      { numRuns: 200 },
    );
  });

  it("rejects a cube that is one move from solved", () => {
    for (const alg of ["R", "U2", "M", "Rw", "R U R' U'"]) {
      expect(isSolvedIgnoringOrientation(stateAfter(parseMoves(alg)))).toBe(false);
    }
  });

  it("reports the colour on each face after a rotation", () => {
    const solved = CubeState.solved();
    expect(colorOnFace(solved, Face.U)).toBe(Face.U);
    expect(colorOnFace(solved, Face.F)).toBe(Face.F);

    // x brings F to U, so the U face now shows what was the F colour.
    const afterX = stateAfter(parseMoves("x"));
    expect(colorOnFace(afterX, Face.U)).toBe(Face.F);
    expect(colorOnFace(afterX, Face.D)).toBe(Face.B);

    // y2 swaps F and B, and L and R, leaving U and D alone.
    const afterY2 = stateAfter(parseMoves("y2"));
    expect(colorOnFace(afterY2, Face.U)).toBe(Face.U);
    expect(colorOnFace(afterY2, Face.F)).toBe(Face.B);
    expect(colorOnFace(afterY2, Face.L)).toBe(Face.R);
  });
});

describe("piece location", () => {
  it("locates every piece in a solved cube at its home slot", () => {
    const solved = CubeState.solved();
    for (let i = 0; i < 8; i++) {
      expect(whereIsCorner(solved, i)).toBe(i);
      expect(isCornerSolved(solved, i)).toBe(true);
    }
    for (let i = 0; i < 12; i++) {
      expect(whereIsEdge(solved, i)).toBe(i);
      expect(isEdgeSolved(solved, i)).toBe(true);
    }
  });

  it("tracks a piece through a known move", () => {
    // U sends the piece at UR to UF (indices 1 and 0).
    const afterU = stateAfter(parseMoves("U"));
    expect(EDGE_NAMES[0]).toBe("UF");
    expect(EDGE_NAMES[1]).toBe("UR");
    expect(whereIsEdge(afterU, 1)).toBe(0);
  });

  it("finds every piece somewhere, under any alg", () => {
    fc.assert(
      fc.property(fc.array(moveArb, { maxLength: 30 }), (moves) => {
        const state = stateAfter(moves);
        const cornerSlots = new Set<number>();
        const edgeSlots = new Set<number>();
        for (let i = 0; i < 8; i++) cornerSlots.add(whereIsCorner(state, i));
        for (let i = 0; i < 12; i++) edgeSlots.add(whereIsEdge(state, i));
        expect(cornerSlots.size).toBe(8);
        expect(edgeSlots.size).toBe(12);
      }),
      { numRuns: 200 },
    );
  });

  it("throws for a piece index that does not exist", () => {
    expect(() => whereIsCorner(CubeState.solved(), 99)).toThrow(RangeError);
    expect(() => whereIsEdge(CubeState.solved(), 99)).toThrow(RangeError);
  });
});
