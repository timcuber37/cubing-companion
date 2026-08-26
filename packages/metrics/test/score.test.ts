/**
 * Scoring against the corpus.
 *
 * The test that matters most is the calibration one: a solve sitting exactly on a corpus median
 * must score 50. An inverted or mis-scaled percentile is otherwise completely invisible — every
 * number still looks like a plausible score, and the app would confidently tell people their
 * worst solves were their best.
 */
import { describe, expect, it } from "vitest";
import fc from "fast-check";
import { Phase, type PhaseSpan } from "@cubing-companion/analysis";
import type { Move } from "@cubing-companion/engine";
import { computeMetrics } from "../src/metrics.ts";
import { BASELINES } from "../src/baselines.generated.ts";
import { TimeWindow } from "../src/baselines.ts";
import {
  asRating,
  corpusRank,
  fluidityBand,
  rateRotations,
  rateTime,
  rateTurns,
  scoreSolve,
  scoreWindows,
} from "../src/score.ts";

const FILLER: Move = { family: "R", amount: 1 };
const span = (phase: Phase, start: number, end: number, rotations = 0): PhaseSpan => ({
  phase,
  start,
  end,
  moves: Array.from({ length: end - start }, () => FILLER),
  turns: end - start - rotations,
  rotations,
});

const SPANS: readonly PhaseSpan[] = [
  span(Phase.Cross, 0, 8),
  span(Phase.F2L1, 8, 16),
  span(Phase.F2L2, 16, 24),
  span(Phase.F2L3, 24, 32),
  span(Phase.F2L4, 32, 40),
  span(Phase.OLL, 40, 50),
  span(Phase.PLL, 50, 62),
  span(Phase.AUF, 62, 63),
];

/** Move `i` lands at `i * gapMs`, so every duration is a round number. */
const timeline = (count: number, gapMs = 200) =>
  Array.from({ length: count }, (_, i) => 10_000 + i * gapMs);

describe("corpusRank", () => {
  const distribution = BASELINES.turns.find((t) => t.key === "total")!.turns;

  it("puts the median at the middle", () => {
    expect(corpusRank(distribution.median, distribution)).toBeCloseTo(0.5, 6);
    expect(corpusRank(distribution.p10, distribution)).toBeCloseTo(0.1, 6);
    expect(corpusRank(distribution.p90, distribution)).toBeCloseTo(0.9, 6);
  });

  it("clamps rather than extrapolating past the corpus", () => {
    expect(corpusRank(distribution.min - 1000, distribution)).toBe(0);
    expect(corpusRank(distribution.max + 1000, distribution)).toBe(1);
  });

  it("never goes backwards", () => {
    fc.assert(
      fc.property(
        fc.double({ min: 0, max: 200, noNaN: true }),
        fc.double({ min: 0, max: 200, noNaN: true }),
        (a, b) => {
          const [low, high] = a <= b ? [a, b] : [b, a];
          expect(corpusRank(low, distribution)).toBeLessThanOrEqual(
            corpusRank(high, distribution),
          );
        },
      ),
      { numRuns: 200 },
    );
  });
});

describe("calibration", () => {
  it("scores a median pro solve at 50, for every turn baseline", () => {
    for (const baseline of BASELINES.turns) {
      const rated = rateTurns(baseline.key, baseline.turns.median)!;
      expect(rated.score, baseline.key).toBeCloseTo(50, 4);
    }
  });

  it("scores a median pro solve at 50, for every time baseline", () => {
    for (const baseline of BASELINES.times) {
      const rated = rateTime(baseline.window, baseline.seconds.median)!;
      expect(rated.score, baseline.window).toBeCloseTo(50, 4);
    }
  });

  it("puts p10 and p90 where they belong, not reversed", () => {
    const baseline = BASELINES.turns.find((t) => t.key === "total")!.turns;
    // Fewer moves is better, so the 10th percentile by count is the 90th by score.
    expect(rateTurns("total", baseline.p10)!.score).toBeCloseTo(90, 4);
    expect(rateTurns("total", baseline.p90)!.score).toBeCloseTo(10, 4);
  });

  it("rates fewer moves and fewer seconds as better", () => {
    expect(rateTurns("total", 45)!.score).toBeGreaterThan(rateTurns("total", 70)!.score);
    expect(rateTime(TimeWindow.Total, 4)!.score).toBeGreaterThan(
      rateTime(TimeWindow.Total, 12)!.score,
    );
  });

  it("has no baseline for a phase the corpus never published", () => {
    expect(rateTurns("nonsense", 10)).toBeNull();
    expect(rateRotations("nonsense", 1)).toBeNull();
  });
});

describe("the baselines themselves", () => {
  it("are ordered distributions built on real samples", () => {
    for (const { key, turns } of BASELINES.turns) {
      expect(turns.n, key).toBeGreaterThan(1000);
      expect(turns.min, key).toBeLessThanOrEqual(turns.p10);
      expect(turns.p10, key).toBeLessThanOrEqual(turns.median);
      expect(turns.median, key).toBeLessThanOrEqual(turns.p90);
      expect(turns.p90, key).toBeLessThanOrEqual(turns.max);
    }
    for (const { window, seconds, tps } of BASELINES.times) {
      expect(seconds.n, window).toBeGreaterThan(1000);
      expect(seconds.min, window).toBeGreaterThan(0);
      expect(seconds.p10, window).toBeLessThanOrEqual(seconds.median);
      expect(tps.median, window).toBeGreaterThan(0);
    }
  });

  it("correct exactly the two windows that touch the timer", () => {
    const corrected = BASELINES.times
      .filter((t) => t.overheadCorrectionSeconds > 0)
      .map((t) => t.window);
    // Cross+1 carries the grab, PLL the drop, and the composites inherit whichever ends they
    // contain. The middle of the solve is clean and must stay uncorrected.
    expect(corrected).toContain(TimeWindow.CrossPlusOne);
    expect(corrected).toContain(TimeWindow.PLL);
    expect(corrected).not.toContain(TimeWindow.Pairs23);
    expect(corrected).not.toContain(TimeWindow.Pair4);
    expect(corrected).not.toContain(TimeWindow.OLL);
  });

  it("flag a corrected rating so it is never mistaken for a clean one", () => {
    expect(rateTime(TimeWindow.CrossPlusOne, 2)!.overheadCorrected).toBe(true);
    expect(rateTime(TimeWindow.Pairs23, 2)!.overheadCorrected).toBe(false);
  });

  it("estimate an overhead that is positive and physically plausible", () => {
    const { crossPlusOneSeconds, pllSeconds } = BASELINES.timerOverhead;
    // A grab and a drop, not a rounding error and not half a second each.
    expect(crossPlusOneSeconds).toBeGreaterThan(0.05);
    expect(crossPlusOneSeconds).toBeLessThan(0.6);
    expect(pllSeconds).toBeGreaterThan(0.05);
    expect(pllSeconds).toBeLessThan(0.8);
  });

  it("keep the regression fits, so the estimate can be audited", () => {
    const fits = BASELINES.timerOverhead.fits;
    expect(fits.filter((f) => f.clean)).toHaveLength(3);
    expect(fits.filter((f) => !f.clean).map((f) => f.window).sort()).toEqual(
      [TimeWindow.CrossPlusOne, TimeWindow.PLL].sort(),
    );
    for (const fit of fits) {
      expect(fit.n, fit.window).toBeGreaterThan(1000);
      expect(fit.secondsPerTurn, fit.window).toBeGreaterThan(0);
    }
  });
});

describe("time windows", () => {
  const metrics = computeMetrics(SPANS, timeline(63));

  it("build cross+1 from the cross and the first pair", () => {
    const window = scoreWindows(metrics).find((w) => w.window === TimeWindow.CrossPlusOne)!;
    const cross = metrics.phases[0]!;
    const pair1 = metrics.phases[1]!;
    expect(window.seconds).toBeCloseTo((cross.durationMs! + pair1.durationMs!) / 1000, 9);
    expect(window.turns).toBe(cross.turns + pair1.turns);
  });

  it("run the PLL window to the end of the solve, AUF included", () => {
    const window = scoreWindows(metrics).find((w) => w.window === TimeWindow.PLL)!;
    // `LL = OLL + PLL` and LL covers everything after F2L, so the AUF is inside PLL.
    expect(window.turns).toBe(
      metrics.phases.find((p) => p.phase === Phase.PLL)!.turns +
        metrics.phases.find((p) => p.phase === Phase.AUF)!.turns,
    );
  });

  it("partition the solve across F2L and the last layer", () => {
    const windows = scoreWindows(metrics);
    const f2l = windows.find((w) => w.window === TimeWindow.F2L)!;
    const ll = windows.find((w) => w.window === TimeWindow.LastLayer)!;
    const total = windows.find((w) => w.window === TimeWindow.Total)!;
    expect(f2l.seconds + ll.seconds).toBeCloseTo(total.seconds, 9);
    expect(f2l.turns + ll.turns).toBe(total.turns);
  });

  it("drop a window whose phases are not all measurable", () => {
    const timestamps: (number | null)[] = timeline(63);
    timestamps[15] = null; // the last move of pair 1
    const windows = scoreWindows(computeMetrics(SPANS, timestamps));
    expect(windows.map((w) => w.window)).not.toContain(TimeWindow.CrossPlusOne);
    expect(windows.map((w) => w.window)).not.toContain(TimeWindow.F2L);
    // The clean end of the solve is still perfectly reportable.
    expect(windows.map((w) => w.window)).toContain(TimeWindow.PLL);
  });
});

describe("the composite", () => {
  const score = scoreSolve(computeMetrics(SPANS, timeline(63)));

  it("is exactly the mean of its named components", () => {
    expect(score.components.length).toBeGreaterThan(0);
    const mean =
      score.components.reduce((sum, c) => sum + c.rated.score, 0) / score.components.length;
    expect(score.composite).toBeCloseTo(mean, 9);
  });

  it("names every component, so it can be taken apart", () => {
    expect(score.components.map((c) => c.label)).toEqual(
      expect.arrayContaining(["efficiency", "rotations", "speed"]),
    );
  });

  it("leaves fluidity out, because no corpus baseline exists for it", () => {
    expect(score.components.map((c) => c.label)).not.toContain("fluidity");
    expect(score.fluidity).not.toBeNull();
    expect(score.fluidityBand).toBe("flowing");
  });

  it("scores every phase the corpus can judge, and no others", () => {
    const scored = score.phases.filter((p) => p.turns !== null).map((p) => p.phase);
    expect(scored).toEqual(
      expect.arrayContaining([Phase.Cross, Phase.F2L1, Phase.OLL, Phase.PLL]),
    );
    // The corpus has no baseline for a standalone AUF.
    expect(scored).not.toContain(Phase.AUF);
  });

  it("carries the provenance of what it compared against", () => {
    expect(score.baselineNote.timedSolves).toBeGreaterThan(1000);
    expect(score.baselineNote.timeEraFrom).toBe(BASELINES.timeEraFrom);
  });

  it("declines to score a solve with no clock, without falling over", () => {
    const score = scoreSolve(computeMetrics(SPANS, Array(63).fill(null)));
    expect(score.windows).toEqual([]);
    expect(score.fluidity).toBeNull();
    expect(score.fluidityBand).toBeNull();
    // Move counts do not need a clock, so those still score.
    expect(score.components.map((c) => c.label)).toContain("efficiency");
  });
});

describe("fluidity bands", () => {
  it("name every value in range, and nothing outside it", () => {
    expect(fluidityBand(1)).toBe("flowing");
    expect(fluidityBand(0.8)).toBe("steady");
    expect(fluidityBand(0.65)).toBe("hesitant");
    expect(fluidityBand(0.2)).toBe("stop-start");
    expect(fluidityBand(null)).toBeNull();
  });
});

/**
 * The rating.
 *
 * The percentile is the quantity; the rating is how it is shown. Keeping both means the
 * calibration above still pins the real number while the UI shows something a person can read —
 * a bare 50 invites being taken for a mark out of a hundred, which is exactly backwards for
 * "matched the median world record".
 */
describe("out of ten", () => {
  it("is the percentile on a ten-point scale", () => {
    for (const baseline of BASELINES.turns) {
      const rated = rateTurns(baseline.key, baseline.turns.median)!;
      // The median pro solve sits halfway up the scale.
      expect(rated.rating, baseline.key).toBeCloseTo(5, 1);
    }
    const baseline = BASELINES.turns.find((t) => t.key === "total")!.turns;
    expect(rateTurns("total", baseline.p10)!.rating).toBeCloseTo(9, 1);
    expect(rateTurns("total", baseline.p90)!.rating).toBeCloseTo(1, 1);
  });

  it("stays inside the scale at both ends", () => {
    const baseline = BASELINES.turns.find((t) => t.key === "total")!.turns;
    expect(rateTurns("total", baseline.min - 100)!.rating).toBe(10);
    expect(rateTurns("total", baseline.max + 100)!.rating).toBe(0);
  });

  it("keeps one decimal, which is already more than the corpus can justify", () => {
    for (const value of [40, 47, 52, 61, 70]) {
      const rating = rateTurns("total", value)!.rating;
      expect(Number.isInteger(rating * 10)).toBe(true);
    }
  });

  it("moves in step with the score it comes from", () => {
    const better = rateTurns("total", 45)!;
    const worse = rateTurns("total", 70)!;
    expect(better.score).toBeGreaterThan(worse.score);
    expect(better.rating).toBeGreaterThan(worse.rating);
  });

  it("gives the composite the same treatment", () => {
    const score = scoreSolve(computeMetrics(SPANS, timeline(63)));
    expect(score.rating).toBeCloseTo(asRating(score.composite!), 6);
    expect(score.rating!).toBeGreaterThanOrEqual(0);
    expect(score.rating!).toBeLessThanOrEqual(10);
  });

  it("is exactly the composite, rescaled — never a separate judgement", () => {
    // The two must never drift: the percentile is what the calibration tests pin, and the
    // rating is only how it is written down.
    for (const count of [40, 50, 63]) {
      const score = scoreSolve(computeMetrics(SPANS, timeline(count)));
      expect(score.rating).toBe(asRating(score.composite!));
      for (const { rated } of score.components) {
        expect(rated.rating).toBe(asRating(rated.score));
      }
    }
  });
});
