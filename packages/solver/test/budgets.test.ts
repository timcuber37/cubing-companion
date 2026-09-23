import { describe, expect, it } from "vitest";
import { applyMoves, CubeState, Face, parseMoves } from "@cubing-companion/engine";
import { GEOMETRY, isSlotSolved } from "@cubing-companion/analysis";
import { enumerateCross } from "../src/cross.ts";
import { enumerateXcross } from "../src/xcross.ts";
import { enumerateF2LInsertion } from "../src/f2l.ts";

const state = applyMoves(CubeState.solved(), parseMoves("D2 F R2 U L B2 R F2 D L U2 B"));
const slot = GEOMETRY[Face.D]!.slots[0]!;

describe("bounded enumeration", () => {
  it("honours node limits for cross, x-cross and pair search", () => {
    for (const maxNodes of [0, 1, 50]) {
      const options = { maxNodes };
      for (const result of [enumerateCross(state, Face.D, options),
        enumerateXcross(state, Face.D, slot, options),
        enumerateF2LInsertion(state, Face.D, slot, options)]) {
        expect(result.stats.nodes).toBeLessThanOrEqual(maxNodes);
        expect(result.stats.truncated).toBe(true);
        if (maxNodes < 2) expect(result.candidates).toHaveLength(0);
      }
    }
  });

  it("reserves candidate capacity for a longer depth", () => {
    const result = enumerateCross(state, Face.D, { maxExtra: 1, maxSolutions: 2, maxSolutionsPerDepth: 1 });
    expect(result.candidates.map((c) => c.overOptimal)).toEqual([0, 1]);
    expect(result.stats.truncated).toBe(true);
    const cross = applyMoves(state, result.candidates[0]!.moves);
    const pairs = enumerateF2LInsertion(cross, Face.D, slot, {
      maxExtra: 1, maxSolutions: 2, maxSolutionsPerDepth: 1,
    });
    expect(pairs.candidates.map((c) => c.overOptimal)).toEqual([0, 1]);
    for (const candidate of pairs.candidates) expect(isSlotSolved(applyMoves(cross, candidate.moves), slot)).toBe(true);
  });

  it("reports a depth ceiling as an incomplete search", () => {
    const result = enumerateXcross(state, Face.D, slot, { maxDepth: 1 });
    expect(result.optimal).toBe(-1);
    expect(result.stats.truncated).toBe(true);
  });
});
