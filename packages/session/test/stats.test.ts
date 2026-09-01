/**
 * Session statistics.
 *
 * An average of five is not a mean of five, and the difference is the entire point: strike the
 * best and the worst, average the middle three. Getting that wrong would not throw — it would
 * just report numbers that quietly flatter a lucky session and punish an unlucky one.
 */
import { describe, expect, it } from "vitest";
import {
  averageOf,
  bestAverage,
  countableSolves,
  currentAverage,
  sessionStats,
} from "../src/stats.ts";
import type { SolveRecord } from "../src/types.ts";

/** A record carrying only what the statistics look at. */
function solve(
  durationMs: number | null,
  extra: { startedAt?: number; outcome?: "solved" | "discarded" } = {},
): SolveRecord {
  return {
    id: `s${extra.startedAt ?? durationMs ?? 0}`,
    sessionId: "session",
    startedAt: extra.startedAt ?? 0,
    startFacelets: "",
    scrambleText: null,
    scrambleMatched: true,
    solution: "",
    moveCount: 0,
    durationMs,
    tps: null,
    source: "manual",
    outcome: extra.outcome ?? "solved",
    moveTimestamps: [],
  };
}

/** Times in the order they were solved, which is what the statistics are defined over. */
const run = (times: readonly (number | null)[]) =>
  times.map((ms, i) => solve(ms, { startedAt: 1_000 + i }));

describe("averageOf", () => {
  it("strikes the best and the worst, and means the rest", () => {
    // 1 and 100 are struck; the middle three are 10, 20 and 30.
    expect(averageOf([1, 10, 20, 30, 100], 5)).toBe(20);
  });

  it("is not the mean, which is the whole reason it exists", () => {
    const times = [1, 10, 20, 30, 100];
    const mean = times.reduce((a, b) => a + b, 0) / times.length;
    expect(averageOf(times, 5)).not.toBe(mean);
    // One disaster moves the mean by 14 seconds and the average by nothing at all.
    expect(averageOf([1, 10, 20, 30, 100_000], 5)).toBe(20);
  });

  it("refuses a window that is not full", () => {
    expect(averageOf([10, 20, 30, 40], 5)).toBeNull();
    expect(averageOf([10, 20, 30, 40, 50, 60], 5)).toBeNull();
  });

  it("handles twelve the same way, striking one at each end", () => {
    const times = Array.from({ length: 12 }, (_, i) => (i + 1) * 1000);
    // 1000 and 12000 struck; the mean of 2000..11000 is 6500.
    expect(averageOf(times, 12)).toBe(6500);
  });
});

describe("current and best", () => {
  const times = [30, 10, 20, 40, 50, 11, 12, 13, 14, 15];

  it("takes the current average from the most recent solves", () => {
    // The last five are 11..15; strike 11 and 15, mean 12, 13, 14.
    expect(currentAverage(times, 5)).toBe(13);
  });

  it("finds the best window wherever it falls, not only on boundaries", () => {
    // The run of 11..15 is the best five in a row, and it does not start at index 0 or 5.
    expect(bestAverage(times, 5)).toBe(13);
  });

  it("has no average at all until there are enough solves", () => {
    expect(currentAverage([10, 20, 30], 5)).toBeNull();
    expect(bestAverage([10, 20, 30], 5)).toBeNull();
  });

  it("never reports a best worse than the current, when the current is the best", () => {
    const improving = [90, 80, 70, 60, 50, 40, 30, 20, 10];
    expect(bestAverage(improving, 5)).toBe(currentAverage(improving, 5));
  });
});

describe("what counts", () => {
  it("leaves out discarded attempts, which were abandoned rather than solved", () => {
    const records = [
      solve(10_000, { startedAt: 1 }),
      solve(99_000, { startedAt: 2, outcome: "discarded" }),
      solve(12_000, { startedAt: 3 }),
    ];
    expect(countableSolves(records)).toEqual([10_000, 12_000]);
  });

  it("leaves out solves with no clock, which have no time to average", () => {
    // Pasted moves and rejected superhuman timing both arrive as a null duration.
    const records = [solve(10_000, { startedAt: 1 }), solve(null, { startedAt: 2 })];
    expect(countableSolves(records)).toEqual([10_000]);
  });

  it("puts them in the order they were solved, whatever order they arrive in", () => {
    const records = [solve(3, { startedAt: 30 }), solve(1, { startedAt: 10 }), solve(2, { startedAt: 20 })];
    expect(countableSolves(records)).toEqual([1, 2, 3]);
  });
});

describe("sessionStats", () => {
  it("reports the shape a timer shows", () => {
    const stats = sessionStats(run([30, 10, 20, 40, 50, 11, 12, 13, 14, 15]));
    expect(stats.count).toBe(10);
    expect(stats.best).toBe(10);
    expect(stats.worst).toBe(50);
    expect(stats.averages[5].current).toBe(13);
    expect(stats.averages[5].best).toBe(13);
  });

  it("keeps the mean, which the averages deliberately are not", () => {
    const stats = sessionStats(run([10, 20, 30]));
    expect(stats.mean).toBe(20);
    // Not enough for an average of five, and it says so rather than inventing one.
    expect(stats.averages[5].current).toBeNull();
  });

  it("says how many it set aside", () => {
    const stats = sessionStats([
      solve(10_000, { startedAt: 1 }),
      solve(null, { startedAt: 2 }),
      solve(11_000, { startedAt: 3, outcome: "discarded" }),
    ]);
    expect(stats.count).toBe(1);
    expect(stats.excluded).toBe(2);
  });

  it("copes with an empty session without inventing zeroes", () => {
    const stats = sessionStats([]);
    expect(stats.count).toBe(0);
    expect(stats.best).toBeNull();
    expect(stats.mean).toBeNull();
    expect(stats.averages[12].best).toBeNull();
  });
});
