import { describe, expect, it } from "vitest";
import { percentile, summarize } from "../src/stats.ts";
import { Method, Phase, type Segment, type SolveRecord } from "../src/types.ts";

function segment(
  rawLabel: string,
  phases: Phase[],
  turns: number,
  rotations = 0,
): Segment {
  return {
    rawLabel,
    phases,
    merged: phases.length > 1,
    moves: [],
    turns,
    rotations,
  };
}

function solve(segments: Segment[], overrides: Partial<SolveRecord> = {}): SolveRecord {
  const merged = segments.some((s) => s.merged);
  return {
    id: 1,
    url: "",
    solver: "Solver",
    solverSlug: null,
    timeSeconds: 8,
    event: "3x3",
    date: null,
    competition: null,
    tags: [],
    reconstructor: null,
    reconstructorSlug: null,
    hardware: null,
    scramble: "",
    solution: "",
    stats: null,
    method: Method.CFOP,
    segments,
    verified: true,
    repaired: false,
    quality: merged ? "merged" : "clean",
    totalTurns: segments.reduce((sum, s) => sum + s.turns, 0),
    totalRotations: segments.reduce((sum, s) => sum + s.rotations, 0),
    ...overrides,
  };
}

/** A solve annotated phase by phase. */
const separate = solve([
  segment("cross", [Phase.Cross], 7),
  segment("1st pair", [Phase.F2L1], 5),
  segment("2nd pair", [Phase.F2L2], 6),
  segment("3rd pair", [Phase.F2L3], 8),
  segment("4th pair", [Phase.F2L4], 9),
  segment("OLL", [Phase.OLL], 10),
  segment("PLL", [Phase.PLL], 12),
]);

/** The same shape, but the solver got an xcross. */
const xcross = solve([
  segment("xcross", [Phase.Cross, Phase.F2L1], 9),
  segment("2nd pair", [Phase.F2L2], 6),
  segment("3rd pair", [Phase.F2L3], 8),
  segment("4th pair", [Phase.F2L4], 9),
  segment("OLL", [Phase.OLL], 10),
  segment("PLL", [Phase.PLL], 12),
]);

describe("percentile", () => {
  it("interpolates between samples", () => {
    expect(percentile([1, 2, 3, 4, 5], 0.5)).toBe(3);
    expect(percentile([1, 2, 3, 4], 0.5)).toBe(2.5);
    expect(percentile([10], 0.9)).toBe(10);
    expect(percentile([1, 2, 3, 4, 5], 0)).toBe(1);
    expect(percentile([1, 2, 3, 4, 5], 1)).toBe(5);
  });

  it("does not care about input order", () => {
    expect(percentile([5, 1, 4, 2, 3], 0.25)).toBe(percentile([1, 2, 3, 4, 5], 0.25));
  });

  it("returns NaN for an empty sample", () => {
    expect(percentile([], 0.5)).toBeNaN();
  });
});

describe("per-phase distributions", () => {
  it("uses only clean solves, so merged blocks are not double-counted", () => {
    const summary = summarize([separate, xcross]);
    const cross = summary.phases.find((p) => p.phase === Phase.Cross)!;
    // Only the `separate` solve has a standalone cross.
    expect(cross.turns?.n).toBe(1);
    expect(cross.turns?.median).toBe(7);
  });

  it("counts phases that both solves annotate separately", () => {
    const summary = summarize([separate, xcross]);
    const pll = summary.phases.find((p) => p.phase === Phase.PLL)!;
    // xcross is quality `merged`, so it is excluded from per-phase stats entirely.
    expect(pll.turns?.n).toBe(1);
  });
});

describe("phase groups", () => {
  it("computes cross+1 for both annotation styles", () => {
    // This is the point of grouping: cross+1 is well defined whether or not the solver
    // got an xcross, so it avoids the selection bias in a standalone cross distribution.
    const summary = summarize([separate, xcross]);
    expect(summary.groups["cross+1"]?.n).toBe(2);
    expect(summary.groups["cross+1"]?.min).toBe(9); // xcross solve
    expect(summary.groups["cross+1"]?.max).toBe(12); // 7 + 5
  });

  it("excludes a solve whose block spills outside the group", () => {
    const xxcross = solve([
      segment("xxcross", [Phase.Cross, Phase.F2L1, Phase.F2L2], 13),
      segment("3rd pair", [Phase.F2L3], 8),
      segment("4th pair", [Phase.F2L4], 9),
      segment("OLL", [Phase.OLL], 10),
      segment("PLL", [Phase.PLL], 12),
    ]);
    const summary = summarize([xxcross]);
    // The xxcross block covers the second pair too, so cross+1 is unattributable...
    expect(summary.groups["cross+1"]).toBeUndefined();
    // ...but cross+2 is exactly this block.
    expect(summary.groups["cross+2"]?.n).toBe(1);
    expect(summary.groups["cross+2"]?.median).toBe(13);
  });

  it("computes whole-F2L totals across annotation styles", () => {
    const summary = summarize([separate, xcross]);
    expect(summary.groups.f2l?.n).toBe(2);
    expect(summary.groups.f2l?.min).toBe(32); // 9+6+8+9
    expect(summary.groups.f2l?.max).toBe(35); // 7+5+6+8+9
  });

  it("reports the xcross rate", () => {
    expect(summarize([separate, xcross]).xcrossRate).toBe(0.5);
    expect(summarize([separate]).xcrossRate).toBe(0);
  });

  it("excludes any solve containing an unrecognized segment", () => {
    // Regression guard. An unknown segment's moves belong to *some* phase and we cannot
    // tell which, so skipping it silently produced a total that looked valid and was
    // quietly short. Across the full corpus this was dropping hundreds of turns from
    // group totals while still reporting them as data.
    const withUnknown = solve([
      segment("cross", [Phase.Cross], 7),
      segment("mystery step", [Phase.Unknown], 6),
      segment("1st pair", [Phase.F2L1], 5),
      segment("2nd pair", [Phase.F2L2], 6),
      segment("3rd pair", [Phase.F2L3], 8),
      segment("4th pair", [Phase.F2L4], 9),
      segment("OLL", [Phase.OLL], 10),
      segment("PLL", [Phase.PLL], 12),
    ]);
    const summary = summarize([withUnknown]);
    // Naively this would report cross+1 = 12, omitting the 6 unattributable turns.
    expect(summary.groups["cross+1"]).toBeUndefined();
    expect(summary.groups.f2l).toBeUndefined();

    // The solve still counts toward whole-solve totals, where every move is included.
    expect(summary.solveTurns?.n).toBe(1);
    expect(summary.solveTurns?.median).toBe(63);
  });
});

describe("corpus composition", () => {
  it("tallies method, quality, and event", () => {
    const summary = summarize([separate, xcross]);
    expect(summary.byMethod).toEqual({ CFOP: 2 });
    expect(summary.byQuality).toEqual({ clean: 1, merged: 1 });
    expect(summary.byEvent).toEqual({ "3x3": 2 });
    expect(summary.totalSolves).toBe(2);
  });

  it("summarizes published timings by group", () => {
    const timed = solve([...separate.segments], {
      stats: {
        Total: { time: 8, split: 100, stm: 57, stps: 7.1, etm: 57, etps: 7.1 },
        F2L: { time: 6, split: 75, stm: 35, stps: 5.8, etm: 35, etps: 5.8 },
      },
    });
    const summary = summarize([timed]);
    expect(summary.publishedTiming.Total?.median).toBe(8);
    expect(summary.publishedTiming.F2L?.median).toBe(6);
  });

  it("handles an empty corpus without throwing", () => {
    const summary = summarize([]);
    expect(summary.totalSolves).toBe(0);
    expect(summary.solveTurns).toBeNull();
    expect(summary.xcrossRate).toBe(0);
  });
});
