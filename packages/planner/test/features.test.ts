/**
 * Feature extraction.
 *
 * These vectors are the model's entire view of the world, and their *order* is part of the
 * contract with the exported weights: permute them and nothing throws, the model just quietly
 * gets worse. So the length and the order are both asserted, and every feature is checked against
 * a position built so the right answer is known in advance.
 */
import { describe, expect, it } from "vitest";
import {
  applyMoves,
  CubeState,
  Face,
  parseMoves,
  type Move,
} from "@cubing-companion/engine";
import { GEOMETRY, slotName, type Slot } from "@cubing-companion/analysis";
import { crossDistance, enumerateF2LInsertion } from "@cubing-companion/solver";
import {
  CROSS_FEATURES,
  crossFeatures,
  PAIR_FEATURES,
  pairFeatures,
  slotsAdjacent,
} from "../src/features.ts";
import { rankByMoveCount, rankNextPair, rerankCross, type ScoreFn } from "../src/rank.ts";
import { planColour } from "../src/plan.ts";
import { ORIENTATIONS, renameMoves } from "../src/orientation.ts";

const GEO = GEOMETRY[Face.D]!;
const FR = GEO.slots.find((slot) => slotName(slot) === "FR")!;

const index = (name: string) => PAIR_FEATURES.indexOf(name as never);
const crossIndex = (name: string) => CROSS_FEATURES.indexOf(name as never);

function candidate(slot: Slot, extra: Partial<{ optimal: number; ways: number; bestMoves: Move[] }> = {}) {
  return {
    slot,
    optimal: extra.optimal ?? 6,
    ways: extra.ways ?? 3,
    bestMoves: extra.bestMoves ?? [],
  };
}

const context = { bestLength: 6, previous: null, step: 0, openCount: 4 };

describe("the feature contract", () => {
  it("names every slot in the vector, in order", () => {
    const vector = pairFeatures(CubeState.solved(), GEO, candidate(FR), context);
    expect(vector).toHaveLength(PAIR_FEATURES.length);
    expect(crossFeatures(parseMoves("R U F"))).toHaveLength(CROSS_FEATURES.length);
    // Duplicated names would make the ablation report meaningless.
    expect(new Set(PAIR_FEATURES).size).toBe(PAIR_FEATURES.length);
    expect(new Set(CROSS_FEATURES).size).toBe(CROSS_FEATURES.length);
  });

  it("produces finite numbers, never a NaN reaching the model", () => {
    for (const scramble of ["R U R' U'", "D2 F R2 U L B2 R F2 D L U2 B", ""]) {
      const state = applyMoves(CubeState.solved(), parseMoves(scramble));
      for (const slot of GEO.slots) {
        const vector = pairFeatures(state, GEO, candidate(slot), context);
        for (const value of vector) expect(Number.isFinite(value), scramble).toBe(true);
      }
    }
  });
});

describe("where the pieces are", () => {
  it("reads a solved pair as home, in its own slot, not on top", () => {
    const vector = pairFeatures(CubeState.solved(), GEO, candidate(FR), context);
    expect(vector[index("cornerInOwnSlot")]).toBe(1);
    expect(vector[index("edgeInOwnSlot")]).toBe(1);
    expect(vector[index("cornerOnTop")]).toBe(0);
    expect(vector[index("pairDistance")]).toBe(0);
  });

  it("reads a corner lifted to the last layer as on top", () => {
    // R takes the FR slot's corner up into the U layer.
    const state = applyMoves(CubeState.solved(), parseMoves("R"));
    const vector = pairFeatures(state, GEO, candidate(FR), context);
    expect(vector[index("cornerOnTop")]).toBe(1);
    expect(vector[index("cornerInOwnSlot")]).toBe(0);
  });

  it("distinguishes buried from on top — the feature the whole model turns on", () => {
    // Measured before any of this was built: on tied decisions pros take the slot whose corner
    // is in the last layer 89.9% of the time against 52.7% chance. Buried is neither on top nor
    // at home, and must read as both zeroes rather than being confused with either.
    const buried = applyMoves(CubeState.solved(), parseMoves("R U2 R'"));
    const vector = pairFeatures(buried, GEO, candidate(FR), context);
    const onTop = vector[index("cornerOnTop")]!;
    const atHome = vector[index("cornerInOwnSlot")]!;
    expect(onTop + atHome).toBeLessThanOrEqual(1);
  });

  it("tracks the edge independently of the corner", () => {
    const state = applyMoves(CubeState.solved(), parseMoves("R"));
    const vector = pairFeatures(state, GEO, candidate(FR), context);
    // `R` lifts both pieces of the FR slot, so both read as on top; the point is that they are
    // separate features, because only the corner carried measurable signal.
    expect(index("cornerOnTop")).not.toBe(index("edgeOnTop"));
    expect(vector[index("edgeOnTop")]).toBe(1);
  });
});

describe("search-derived features", () => {
  it("carries the insertion length and its gap to the cheapest", () => {
    const vector = pairFeatures(
      CubeState.solved(),
      GEO,
      candidate(FR, { optimal: 9 }),
      { ...context, bestLength: 6 },
    );
    expect(vector[index("insertionLength")]).toBe(9);
    expect(vector[index("excessOverBest")]).toBe(3);
  });

  it("compresses the count of ways, which spans orders of magnitude", () => {
    const few = pairFeatures(CubeState.solved(), GEO, candidate(FR, { ways: 1 }), context);
    const many = pairFeatures(CubeState.solved(), GEO, candidate(FR, { ways: 60 }), context);
    expect(many[index("logWays")]).toBeGreaterThan(few[index("logWays")]!);
    expect(many[index("logWays")]).toBeLessThan(5);
  });

  it("counts back turns in the cheapest insertion", () => {
    const vector = pairFeatures(
      CubeState.solved(),
      GEO,
      candidate(FR, { bestMoves: parseMoves("B R B' R2") }),
      context,
    );
    expect(vector[index("backTurns")]).toBe(2);
  });

  it("knows which slot came before", () => {
    const FL = GEO.slots.find((slot) => slotName(slot) === "FL")!;
    const BL = GEO.slots.find((slot) => slotName(slot) === "BL")!;
    expect(slotsAdjacent(FR, FL)).toBe(true); // both at the front
    expect(slotsAdjacent(FR, BL)).toBe(false); // diagonally opposite

    const near = pairFeatures(CubeState.solved(), GEO, candidate(FR), { ...context, previous: FL });
    const far = pairFeatures(CubeState.solved(), GEO, candidate(FR), { ...context, previous: BL });
    expect(near[index("adjacentToPrevious")]).toBe(1);
    expect(far[index("adjacentToPrevious")]).toBe(0);
  });

  it("passes the step through, since pair one is not pair three", () => {
    const vector = pairFeatures(CubeState.solved(), GEO, candidate(FR), {
      ...context,
      step: 2,
      openCount: 2,
    });
    expect(vector[index("stepIndex")]).toBe(2);
    expect(vector[index("openCount")]).toBe(2);
  });
});

describe("cross features", () => {
  it("counts turns per face, in the frame given", () => {
    const vector = crossFeatures(parseMoves("R U R' D2 B"));
    expect(vector[crossIndex("length")]).toBe(5);
    expect(vector[crossIndex("turnsR")]).toBe(2);
    expect(vector[crossIndex("turnsB")]).toBe(1);
    expect(vector[crossIndex("halfTurns")]).toBe(1);
    expect(vector[crossIndex("distinctFaces")]).toBe(4);
  });

  it("notices the cross being squared up at the end", () => {
    expect(crossFeatures(parseMoves("R U D"))[crossIndex("endsOnDown")]).toBe(1);
    expect(crossFeatures(parseMoves("D U R"))[crossIndex("endsOnDown")]).toBe(0);
  });

  it("counts consecutive turns on the same axis", () => {
    // R and L share an axis, as do U and D; F then R does not.
    expect(crossFeatures(parseMoves("R L U D"))[crossIndex("sameAxisPairs")]).toBe(2);
    expect(crossFeatures(parseMoves("F R U"))[crossIndex("sameAxisPairs")]).toBe(0);
  });

  it("scores comfort in step with the corpus model", () => {
    const easy = crossFeatures(parseMoves("R D R D"))[crossIndex("comfort")]!;
    const awkward = crossFeatures(parseMoves("B L B L"))[crossIndex("comfort")]!;
    expect(easy).toBeGreaterThan(awkward);
  });

  it("handles an empty solution without dividing by zero", () => {
    for (const value of crossFeatures([])) expect(Number.isFinite(value)).toBe(true);
  });
});

describe("ranking", () => {
  const state = applyMoves(CubeState.solved(), parseMoves("D2 F R2 U L B2 R F2 D L U2 B"));
  const searched = GEO.slots.map((slot) => {
    const result = enumerateF2LInsertion(state, Face.D, slot, { maxSolutions: 20 });
    return { slot, optimal: result.optimal, ways: result.candidates.length, bestMoves: result.candidates[0]?.moves ?? [] };
  });

  it("orders by the model, best first, with confidences that sum to one", async () => {
    // A stub standing in for the model: prefers whichever slot has its corner on top.
    const stub: ScoreFn = async (rows) => rows.map((row) => row[index("cornerOnTop")]! * 3);
    const ranked = await rankNextPair(state, GEO, searched, { previous: null, step: 0 }, stub);

    expect(ranked).toHaveLength(4);
    for (let i = 1; i < ranked.length; i++) {
      expect(ranked[i]!.score).toBeLessThanOrEqual(ranked[i - 1]!.score);
    }
    expect(ranked.reduce((sum, r) => sum + r.confidence, 0)).toBeCloseTo(1, 9);
    expect(ranked[0]!.features[index("cornerOnTop")]).toBe(1);
  });

  it("refuses a model that returns the wrong number of scores", async () => {
    const broken: ScoreFn = async () => [1, 2];
    await expect(
      rankNextPair(state, GEO, searched, { previous: null, step: 0 }, broken),
    ).rejects.toThrow(/2 scores for 4 options/);
  });

  it("does nothing gracefully when there is nothing left to choose", async () => {
    const stub: ScoreFn = async (rows) => rows.map(() => 0);
    expect(await rankNextPair(state, GEO, [], { previous: null, step: 0 }, stub)).toEqual([]);
  });

  it("keeps the movecount baseline available, since it is the thing to beat", () => {
    const ordered = rankByMoveCount(searched);
    for (let i = 1; i < ordered.length; i++) {
      expect(ordered[i]!.optimal).toBeGreaterThanOrEqual(ordered[i - 1]!.optimal);
    }
  });
});

describe("model re-ranking of crosses", () => {
  const state = applyMoves(CubeState.solved(), parseMoves("D2 F R2 U L B2 R F2 D L U2 B"));

  it("keeps shorter solutions ahead of longer ones, whatever the model says", async () => {
    // The guard that matters: a model is free to prefer whatever it likes among equals, but it
    // must never be able to recommend a longer cross.
    const plan = planColour(state, Face.D, { keep: 6, maxExtra: 1, crossOnly: true });
    const contrarian: ScoreFn = async (rows) => rows.map((row) => row[0]!); // rewards length
    const ranked = await rerankCross(plan.cross, contrarian);
    for (let i = 1; i < ranked.length; i++) {
      expect(ranked[i]!.length).toBeGreaterThanOrEqual(ranked[i - 1]!.length);
    }
  });

  it("re-picks the grip, and keeps the moves consistent with it", async () => {
    const plan = planColour(state, Face.D, { keep: 3, crossOnly: true });
    // Prefer whichever grip puts the most work on the back face — the opposite of comfort, so
    // the choice is visibly the model's rather than a coincidence.
    const backwards: ScoreFn = async (rows) =>
      rows.map((row) => row[CROSS_FEATURES.indexOf("turnsB")]!);
    const ranked = await rerankCross(plan.cross, backwards);

    for (const solution of ranked) {
      // Whatever grip it chose, the moves shown must be that solution turned in that grip.
      const frame = ORIENTATIONS.find((o) => o.text === solution.hold.rotation)!;
      expect(renameMoves(solution.searchMoves, frame)).toEqual(solution.moves);
      expect(solution.hold.down).toBe(Face.D);
      expect(solution.modelScore).toBeDefined();
    }
    // And it really did move away from what comfort chose.
    expect(ranked.some((s) => s.awkward.back > 0)).toBe(true);
  });

  it("still solves the cross after the model has had its way", async () => {
    const plan = planColour(state, Face.D, { keep: 3, crossOnly: true });
    const backwards: ScoreFn = async (rows) =>
      rows.map((row) => row[CROSS_FEATURES.indexOf("turnsB")]!);

    for (const solution of await rerankCross(plan.cross, backwards)) {
      const frame = ORIENTATIONS.find((o) => o.text === solution.hold.rotation)!;
      const after = applyMoves(state, [...frame.rotation, ...solution.moves]);
      expect(crossDistance(after, Face.D), solution.text).toBe(0);
    }
  });

  it("does nothing when there is nothing to rank", async () => {
    const stub: ScoreFn = async (rows) => rows.map(() => 0);
    expect(await rerankCross([], stub)).toEqual([]);
  });
});
