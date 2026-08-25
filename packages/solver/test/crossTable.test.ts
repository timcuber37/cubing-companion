/**
 * Cross table tests.
 *
 * The table is the foundation everything else prunes against, and it has an unusual advantage:
 * its shape is externally known. The cross has exactly 190,080 positions and a hardest case of
 * 8 moves in HTM, both published results. Agreeing with them checks the whole chain — the
 * engine's move tables, the packing, the transition — against something that knows nothing
 * about this codebase.
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
import { GEOMETRY } from "@cubing-companion/analysis";
import {
  crossDistance,
  crossIndexNormalised,
  crossIndexOf,
  crossTable,
  MAX_CROSS_DISTANCE,
  packCross,
  REACHABLE_CROSS_POSITIONS,
  stepCross,
  UNREACHABLE,
  unpackCross,
} from "../src/crossTable.ts";
import { SEARCH_MOVES } from "../src/moves.ts";

const moveArb: fc.Arbitrary<Move> = fc.record({
  family: fc.constantFrom("U", "D", "L", "R", "F", "B"),
  amount: fc.constantFrom<1 | 2 | -1>(1, 2, -1),
});

describe("the table matches known results", () => {
  const table = crossTable(Face.D);

  it("reaches exactly the positions the cross has", () => {
    // 12P4 slot arrangements × 2^4 orientations = 11880 × 16.
    let reachable = 0;
    for (const d of table.distance) if (d !== UNREACHABLE) reachable++;
    expect(reachable).toBe(REACHABLE_CROSS_POSITIONS);
    expect(REACHABLE_CROSS_POSITIONS).toBe(11880 * 16);
  });

  it("has a hardest case of eight moves", () => {
    let max = 0;
    for (const d of table.distance) if (d !== UNREACHABLE && d > max) max = d;
    expect(max).toBe(MAX_CROSS_DISTANCE);
    expect(max).toBe(8);
  });

  it("has the published depth distribution", () => {
    // Cross-checked against an independent breadth-first search over full cube states, which
    // produced this histogram byte for byte.
    const histogram: number[] = [];
    for (const d of table.distance) {
      if (d === UNREACHABLE) continue;
      histogram[d] = (histogram[d] ?? 0) + 1;
    }
    expect(histogram).toEqual([1, 15, 158, 1394, 9809, 46381, 97254, 34966, 102]);
  });

  it("puts the solved cross at distance zero, alone", () => {
    expect(table.distance[table.solvedIndex]).toBe(0);
    let zeros = 0;
    for (const d of table.distance) if (d === 0) zeros++;
    expect(zeros).toBe(1);
  });
});

describe("packing", () => {
  it("round-trips", () => {
    fc.assert(
      fc.property(
        fc.array(fc.integer({ min: 0, max: 11 }), { minLength: 4, maxLength: 4 }),
        fc.array(fc.integer({ min: 0, max: 1 }), { minLength: 4, maxLength: 4 }),
        (slots, orientations) => {
          const index = packCross(slots, orientations);
          const outSlots = new Uint8Array(4);
          const outOrientations = new Uint8Array(4);
          unpackCross(index, outSlots, outOrientations);
          expect([...outSlots]).toEqual(slots);
          expect([...outOrientations]).toEqual(orientations);
        },
      ),
      { numRuns: 300 },
    );
  });
});

describe("the integer transition agrees with the cube", () => {
  it("steps the same way applying a move does", () => {
    // The whole speed argument rests on transitioning four integers instead of a cube state.
    // If the two ever disagree the table is quietly wrong, so they are checked against each
    // other directly.
    const edges = GEOMETRY[Face.D]!.crossEdges;
    fc.assert(
      fc.property(fc.array(moveArb, { maxLength: 12 }), (setup) => {
        const state = applyMoves(CubeState.solved(), setup);
        let index = crossIndexNormalised(CubeState.solved(), edges);
        for (const move of setup) {
          const m = SEARCH_MOVES.findIndex(
            (candidate) =>
              candidate.family === move.family && candidate.amount === move.amount,
          );
          index = stepCross(index, m);
        }
        expect(index).toBe(crossIndexNormalised(state, edges));
      }),
      { numRuns: 200 },
    );
  });
});

describe("distances", () => {
  it("is zero for a solved cube and non-zero once disturbed", () => {
    expect(crossDistance(CubeState.solved(), Face.D)).toBe(0);
    expect(crossDistance(applyMoves(CubeState.solved(), parseMoves("D")), Face.D))
      .toBeGreaterThan(0);
  });

  it("never changes by more than one per move", () => {
    // A distance function that jumped by two would not be admissible, and the xcross search
    // prunes on exactly this property.
    fc.assert(
      fc.property(fc.array(moveArb, { maxLength: 14 }), moveArb, (setup, move) => {
        const before = applyMoves(CubeState.solved(), setup);
        const after = applyMoves(before, [move]);
        const delta = Math.abs(
          crossDistance(after, Face.D) - crossDistance(before, Face.D),
        );
        expect(delta).toBeLessThanOrEqual(1);
      }),
      { numRuns: 300 },
    );
  });

  it("ignores how the cube is being held", () => {
    // Rotating the cube does not make a cross harder, and `crossIndexOf` normalises so the
    // one table serves any orientation.
    const scrambled = applyMoves(CubeState.solved(), parseMoves("D2 F R2 U L B2"));
    const base = crossDistance(scrambled, Face.D);
    for (const rotation of ["x", "y", "z", "x2", "y'", "z2"]) {
      const rotated = applyMoves(scrambled, parseMoves(rotation));
      expect(crossDistance(rotated, Face.D), rotation).toBe(base);
    }
  });

  it("serves every cross colour", () => {
    for (const face of [Face.U, Face.L, Face.F, Face.R, Face.B, Face.D]) {
      const table = crossTable(face);
      expect(table.crossFace).toBe(face);
      expect(table.edges).toHaveLength(4);
      expect(crossDistance(CubeState.solved(), face)).toBe(0);
    }
  });

  it("indexes an unnormalised state the same as a normalised one", () => {
    const edges = GEOMETRY[Face.D]!.crossEdges;
    const scrambled = applyMoves(CubeState.solved(), parseMoves("R U F2 D' L"));
    const rotated = applyMoves(scrambled, parseMoves("y x'"));
    expect(crossIndexOf(rotated, edges)).toBe(crossIndexOf(scrambled, edges));
  });
});
