import { describe, expect, it } from "vitest";
import { applyMoves, CubeState, Face, normalizeOrientation, parseMoves, type CubeState as State } from "@cubing-companion/engine";
import { GEOMETRY, isSlotSolved, slotName } from "@cubing-companion/analysis";
import { crossDistance, enumerateF2LInsertion, solveCross } from "@cubing-companion/solver";
import { continueF2L, lookaheadPairs, type Continuation } from "../src/lookahead.ts";
import { planColour } from "../src/plan.ts";

const position = (moves: string) => applyMoves(CubeState.solved(), parseMoves(moves));
const afterCross = (moves: string) => {
  const state = position(moves);
  return applyMoves(state, solveCross(state, Face.D) ?? []);
};

function verifyContinuation(start: State, plan: Continuation, required: number) {
  let state = normalizeOrientation(start);
  const slots = GEOMETRY[Face.D]!.slots;
  let built = slots.filter((s) => isSlotSolved(state, s));
  for (const step of plan.steps) {
    state = applyMoves(state, step.moves);
    expect(crossDistance(state, Face.D)).toBe(0);
    for (const slot of built) expect(isSlotSolved(state, slot)).toBe(true);
    expect(isSlotSolved(state, slots.find((s) => slotName(s) === step.slot)!)).toBe(true);
    const now = slots.filter((s) => isSlotSolved(state, s));
    expect(now.length).toBeGreaterThan(built.length);
    expect(now.map(slotName)).toEqual(step.solvedSlots);
    built = now;
  }
  expect(built.length).toBeGreaterThanOrEqual(required);
  expect(state.equals(applyMoves(normalizeOrientation(start), plan.moves))).toBe(true);
  expect(built.map(slotName)).toEqual(plan.solvedSlots);
}

describe("pair lookahead", () => {
  it("chooses a longer first pair when its two-pair continuation is shorter", () => {
    const state = afterCross("B U2 R2 D L' R2 L' D2 R2");
    const result = lookaheadPairs(state, Face.D);
    const top = result.options[0]!;
    const greedy = result.options.find((o) => slotName(o.slot) === "BR")!;
    expect(slotName(top.slot)).toBe("BL");
    expect(enumerateF2LInsertion(state, Face.D, top.slot, { maxSolutions: 1 }).optimal).toBe(5);
    expect(enumerateF2LInsertion(state, Face.D, greedy.slot, { maxSolutions: 1 }).optimal).toBe(4);
    expect(top.plan!.moves.length).toBe(9);
    expect(greedy.plan!.moves.length).toBe(10);
    for (const option of result.options) if (option.plan) verifyContinuation(state, option.plan, 2);
  });

  it("explores alternative insertions, including ones a move longer", () => {
    const state = afterCross("B2 L D R2 U F L2 B U2 R D F");
    const options = { maxNodes: 2_400_000, maxNodesPerSearch: 100_000 };
    const shortest = lookaheadPairs(state, Face.D, { ...options, maxExtra: 0 });
    const deeper = lookaheadPairs(state, Face.D, options);
    const fr = (result: typeof deeper) => result.options.find((o) => slotName(o.slot) === "FR")!.plan!;
    expect(fr(shortest).steps[0]!.moves.length).toBe(6);
    expect(fr(deeper).steps[0]!.moves.length).toBe(7);
    expect(fr(deeper).steps[1]!.moves.length).toBeLessThan(fr(shortest).steps[1]!.moves.length);
    expect(fr(deeper).moves.length).toBeLessThanOrEqual(fr(shortest).moves.length);
    verifyContinuation(state, fr(deeper), 2);
  });

  it("preserves already-built pairs, and counts incidental solves toward the horizon", () => {
    const state = position("R U R' L' U2 L");
    const built = GEOMETRY[Face.D]!.slots.filter((s) => isSlotSolved(state, s)).length;
    const result = lookaheadPairs(state, Face.D, { depth: 4 });
    expect(result.depth).toBe(4 - built);
    const complete = result.options.filter((option) => option.plan);
    expect(complete.length).toBeGreaterThan(0);
    for (const option of complete) verifyContinuation(state, option.plan!, 4);
  });

  it("handles a last pair, finished F2L, and a missing cross explicitly", () => {
    const last = position("R U R'");
    const result = lookaheadPairs(last, Face.D);
    expect(result.depth).toBe(1);
    expect(result.options).toHaveLength(1);
    verifyContinuation(last, result.options[0]!.plan!, 4);
    expect(lookaheadPairs(CubeState.solved(), Face.D).options).toEqual([]);
    expect(() => lookaheadPairs(position("R"), Face.D)).toThrow(/solved cross/);
  });

  it("returns unknown continuations when the budget runs out, and never mutates its input", () => {
    const state = afterCross("D2 F R2 U L B2 R F2 D L U2 B");
    const before = state.clone();
    const result = lookaheadPairs(state, Face.D, { maxNodes: 20 });
    expect(result.nodes).toBeLessThanOrEqual(20);
    expect(result.truncated).toBe(true);
    expect(result.options.every((o) => o.plan === null)).toBe(true);
    expect(state.equals(before)).toBe(true);
    expect(lookaheadPairs(state, Face.D, { maxNodes: 0 }).nodes).toBe(0);
  });

  it("normalises rotated states and rejects invalid search configuration", () => {
    const state = position("R U R' L' U2 L");
    const rotated = applyMoves(state, parseMoves("x y"));
    expect(lookaheadPairs(rotated, Face.D)).toEqual(lookaheadPairs(state, Face.D));
    expect(() => lookaheadPairs(state, Face.D, { depth: 0 })).toThrow(RangeError);
    expect(() => continueF2L(state, Face.D, 2, { beamWidth: 0 })).toThrow(RangeError);
  });
});

describe("cross through two pairs", () => {
  it("offers cross + 1 and cross + 2, with executable steps in the recommended grip", () => {
    const state = applyMoves(position("D2 F R2 U L B2 R F2 D L U2 B"), parseMoves("x y'"));
    const before = state.clone();
    const result = planColour(state, Face.D, { lookahead: true });
    expect(result.crossPlusOne!.length).toBeGreaterThan(0);
    expect(result.crossPlusTwo!.length).toBeGreaterThan(0);
    for (const [required, plans] of [[1, result.crossPlusOne!], [2, result.crossPlusTwo!]] as const) {
      for (const plan of plans) {
        const after = normalizeOrientation(applyMoves(state, [...plan.setup, ...plan.moves]));
        expect(crossDistance(after, Face.D)).toBe(0);
        expect(GEOMETRY[Face.D]!.slots.filter((slot) => isSlotSolved(after, slot)).length).toBeGreaterThanOrEqual(required);
        expect(plan.length).toBe(plan.moves.length);
        const steps = plan.steps!.flatMap((step) => parseMoves(step.text));
        expect(steps).toEqual(plan.moves);
      }
    }
    expect(state.equals(before)).toBe(true);
  });

  it("finds joint two-pair goals on every colour, including an already solved cube", () => {
    const state = position("R U F' L2");
    for (const face of Object.values(Face)) {
      const result = planColour(state, face, { keep: 1, lookahead: true });
      const plan = result.crossPlusTwo![0]!;
      expect(plan).toBeDefined();
      const after = normalizeOrientation(applyMoves(state, [...plan.setup, ...plan.moves]));
      expect(crossDistance(after, face)).toBe(0);
      expect(GEOMETRY[face]!.slots.filter((slot) => isSlotSolved(after, slot)).length).toBeGreaterThanOrEqual(2);
    }
    expect(planColour(CubeState.solved(), Face.D, { lookahead: true }).crossPlusTwo![0]!.length).toBe(0);
  });

  it("leaves the lightweight cross-only API available", () => {
    const result = planColour(position("R U F"), Face.D, { lookahead: true, crossOnly: true });
    expect(result.crossPlusOne).toBeUndefined();
    expect(result.crossPlusTwo).toBeUndefined();
    expect(result.xcross).toEqual([]);
  });
});
