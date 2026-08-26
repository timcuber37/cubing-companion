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
  corpusRank,
  CORPUS_ANCHORS,
  distributionOf,
  MIN_OWN_SOLVES,
  SELF_ANCHORS,
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

/** Six earlier solves, so speed has something of your own to be measured against. */
const OWN_SOLVES = [9_000, 9_500, 10_000, 10_500, 11_000, 12_000];

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
  const score = scoreSolve(computeMetrics(SPANS, timeline(63)), {
    recentDurationsMs: OWN_SOLVES,
  });

  it("is exactly the mean of its named components", () => {
    expect(score.components.length).toBeGreaterThan(0);
    const mean =
      score.components.reduce((sum, c) => sum + c.rated.rating, 0) / score.components.length;
    expect(score.rating).toBeCloseTo(mean, 1);
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
  const turns = BASELINES.turns.find((t) => t.key === "total")!.turns;

  it("pins the corpus anchors to the corpus spread", () => {
    // The whole scale is these two points plus a straight line; nothing else is chosen.
    expect(rateTurns("total", turns.p10)!.rating).toBeCloseTo(CORPUS_ANCHORS.best, 1);
    expect(rateTurns("total", turns.p90)!.rating).toBeCloseTo(CORPUS_ANCHORS.worst, 1);
    // The median falls halfway between them, because it is halfway between the anchors.
    expect(rateTurns("total", turns.median)!.rating).toBeCloseTo(8, 0);
  });

  it("keeps discriminating past the reference, where a percentile gives up", () => {
    // The complaint that prompted this: fifteen more moves barely moves a percentile, because
    // both solves are simply "worse than nearly every pro".
    const eighty = rateTurns("total", 80)!;
    const ninetyFive = rateTurns("total", 95)!;
    // On the same ten-point scale, so the two are comparable.
    expect((eighty.score - ninetyFive.score) / 10).toBeLessThan(0.5);
    expect(eighty.rating - ninetyFive.rating).toBeGreaterThan(2);
  });

  it("is not brutal about a few moves either side of the median", () => {
    // 65 moves against a median of 61 scored 2.5 before, which is what prompted the change.
    const rated = rateTurns("total", 65)!;
    expect(rated.rating).toBeGreaterThan(6.5);
    expect(rated.rating).toBeLessThan(8);
  });

  it("stays inside the scale at both ends", () => {
    expect(rateTurns("total", turns.min - 100)!.rating).toBe(10);
    expect(rateTurns("total", turns.max + 500)!.rating).toBe(0);
  });

  it("keeps one decimal, which is already more than the corpus can justify", () => {
    for (const value of [40, 47, 52, 61, 70]) {
      expect(Number.isInteger(rateTurns("total", value)!.rating * 10)).toBe(true);
    }
  });

  it("moves in step with the measurement it comes from", () => {
    expect(rateTurns("total", 45)!.rating).toBeGreaterThan(rateTurns("total", 70)!.rating);
  });

  it("still reports the percentile underneath, which is a different question", () => {
    // "How far outside the world-class band" and "what share of it did you beat" are both
    // worth knowing, and only the first makes a usable rating.
    const rated = rateTurns("total", turns.median)!;
    expect(rated.score).toBeCloseTo(50, 4);
    expect(rated.rating).toBeCloseTo(8, 0);
    expect(rated.reference).toBe("corpus");
  });
});


/**
 * Rotations that nobody could see.
 *
 * A smart cube reports no rotations because nothing observes one — a rotation turns no face
 * against the core. The record then looks identical to a solve performed without rotating, and
 * the two mean opposite things. Since the corpus median solver rotates four times, counting the
 * unobserved zero awards a perfect mark for a quantity never measured.
 */
describe("when rotations cannot be observed", () => {
  const metrics = computeMetrics(SPANS, timeline(63));

  it("would otherwise hand out a perfect mark", () => {
    // The bug this guards against, stated plainly.
    expect(metrics.rotations).toBe(0);
    expect(rateRotations("total", 0)!.rating).toBe(10);
  });

  it("leaves rotations out of the components entirely", () => {
    const scored = scoreSolve(metrics, {
      rotationsObserved: false,
      recentDurationsMs: OWN_SOLVES,
    });
    expect(scored.components.map((c) => c.label)).not.toContain("rotations");
    expect(scored.components.map((c) => c.label)).toContain("efficiency");
  });

  it("says what it left out, rather than quietly dropping it", () => {
    // A score missing a component looks exactly like one that never had it.
    const scored = scoreSolve(metrics, {
      rotationsObserved: false,
      recentDurationsMs: OWN_SOLVES,
    });
    expect(scored.omitted.map((o) => o.label)).toEqual(["rotations"]);
    expect(scored.omitted[0]!.reason).toMatch(/cannot report/);
  });

  it("lowers the rating, because the free ten is gone", () => {
    const counted = scoreSolve(metrics, {
      rotationsObserved: true,
      recentDurationsMs: OWN_SOLVES,
    });
    const honest = scoreSolve(metrics, {
      rotationsObserved: false,
      recentDurationsMs: OWN_SOLVES,
    });
    expect(honest.rating!).toBeLessThan(counted.rating!);
    // And what remains is still the plain mean of what is left.
    const mean =
      honest.components.reduce((sum, c) => sum + c.rated.rating, 0) / honest.components.length;
    expect(honest.rating).toBeCloseTo(mean, 1);
  });

  it("still counts them when they were observable", () => {
    const scored = scoreSolve(metrics, { recentDurationsMs: OWN_SOLVES });
    expect(scored.components.map((c) => c.label)).toContain("rotations");
    expect(scored.omitted).toEqual([]);
  });
});

/**
 * Speed, measured against you.
 *
 * The corpus is the wrong reference for time and no rescaling fixes it: pros are far enough ahead
 * that a twenty-second solve and a forty-second one both land on zero, so the number cannot
 * reward improvement. Your own recent solves are the only reference you are actually in.
 */
describe("speed against your own solves", () => {
  /** A solve of a given duration, with the move counts held constant. */
  const solveOf = (durationMs: number) =>
    computeMetrics(SPANS, Array.from({ length: 63 }, (_, i) => 10_000 + (i * durationMs) / 62));

  it("puts a typical day for you in the middle of the scale", () => {
    // Median of OWN_SOLVES is 10.25s, and the self anchors centre that at 5.
    const scored = scoreSolve(solveOf(10_250), { recentDurationsMs: OWN_SOLVES });
    const speed = scored.components.find((c) => c.label === "speed")!;
    expect(speed.rated.rating).toBeCloseTo(5, 0);
    expect(speed.rated.reference).toBe("you");
  });

  it("rewards a fast solve and marks down a slow one", () => {
    const fast = scoreSolve(solveOf(8_500), { recentDurationsMs: OWN_SOLVES });
    const slow = scoreSolve(solveOf(13_000), { recentDurationsMs: OWN_SOLVES });
    const rating = (s: typeof fast) =>
      s.components.find((c) => c.label === "speed")!.rated.rating;
    expect(rating(fast)).toBeGreaterThan(7);
    expect(rating(slow)).toBeLessThan(3);
  });

  it("keeps discriminating where a corpus-anchored score would read zero", () => {
    // Both of these are far outside the pro range; against yourself they are clearly different.
    const slower = [20_000, 21_000, 22_000, 23_000, 24_000, 25_000];
    const good = scoreSolve(solveOf(20_500), { recentDurationsMs: slower });
    const bad = scoreSolve(solveOf(24_500), { recentDurationsMs: slower });
    const rating = (s: typeof good) =>
      s.components.find((c) => c.label === "speed")!.rated.rating;
    expect(rating(good)).toBeGreaterThan(rating(bad) + 2);
    // And the corpus would have flattened both to nothing.
    expect(rateTime(TimeWindow.Total, 20.5)!.rating).toBe(0);
    expect(rateTime(TimeWindow.Total, 24.5)!.rating).toBe(0);
  });

  it("declines to rate speed until it has enough of your history", () => {
    const scored = scoreSolve(solveOf(10_000), { recentDurationsMs: [9_000, 10_000] });
    expect(scored.components.map((c) => c.label)).not.toContain("speed");
    expect(scored.omitted.map((o) => o.label)).toContain("speed");
    expect(scored.omitted.find((o) => o.label === "speed")!.reason).toMatch(
      new RegExp(`${MIN_OWN_SOLVES}`),
    );
  });

  it("declines when the solve itself has no clock", () => {
    const scored = scoreSolve(computeMetrics(SPANS, Array(63).fill(null)), {
      recentDurationsMs: OWN_SOLVES,
    });
    expect(scored.omitted.find((o) => o.label === "speed")!.reason).toMatch(/no usable clock/);
  });

  it("uses your own spread, so a consistent solver is not punished for noise", () => {
    // Someone very consistent has a narrow spread; a small slip should still not read as zero.
    const consistent = [10_000, 10_100, 10_200, 10_300, 10_400, 10_500];
    const scored = scoreSolve(solveOf(10_600), { recentDurationsMs: consistent });
    expect(scored.components.find((c) => c.label === "speed")!.rated.rating).toBeGreaterThan(0);
  });

  it("builds a distribution from raw numbers the same way it reads the corpus", () => {
    const d = distributionOf([1, 2, 3, 4, 5])!;
    expect(d.n).toBe(5);
    expect(d.min).toBe(1);
    expect(d.median).toBe(3);
    expect(d.max).toBe(5);
    expect(distributionOf([])).toBeNull();
  });

  it("centres the self scale differently from the corpus one, deliberately", () => {
    // Against world-class solves, matching the median deserves an 8. Against yourself it is a 5:
    // the reference is you, so a typical day has to read as typical.
    expect(SELF_ANCHORS.best).toBeLessThan(CORPUS_ANCHORS.best);
    expect(SELF_ANCHORS.worst).toBeLessThan(CORPUS_ANCHORS.worst);
  });
});
