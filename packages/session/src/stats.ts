/**
 * Session statistics — the numbers every speedcubing timer shows.
 *
 * An "average of 5" is not a mean: the best and worst are struck out and the middle three are
 * averaged. That is the WCA rule, and it is the whole point of the statistic — one lucky solve
 * cannot flatter a session and one disaster cannot ruin it. A plain mean of five would do both,
 * which is why the mean is reported separately rather than instead.
 */
import type { SolveRecord } from "./types.ts";

/** Sizes worth reporting. Anything larger needs a session longer than most people sit for. */
export const AVERAGE_SIZES = [5, 12] as const;
export type AverageSize = (typeof AVERAGE_SIZES)[number];

export interface AverageStat {
  /** Milliseconds, or `null` when there are not yet enough solves to form one. */
  readonly current: number | null;
  /** The best such average anywhere in the history — a personal best over a window. */
  readonly best: number | null;
}

export interface SessionStats {
  /** Solves counted: timed, and not discarded. */
  readonly count: number;
  /** How many were set aside — timed but discarded, or with no usable clock. */
  readonly excluded: number;
  readonly best: number | null;
  readonly worst: number | null;
  /** Plain mean of everything counted, which no average-of-N is. */
  readonly mean: number | null;
  readonly averages: Readonly<Record<AverageSize, AverageStat>>;
}

/**
 * The solves a statistic may be built from, oldest first.
 *
 * Two exclusions, both of which would otherwise corrupt every number here. A **discarded** solve
 * was abandoned rather than completed, so it is not a result. A solve with **no clock** — pasted
 * moves, or a stream whose timing was rejected as superhuman — has no time to average.
 *
 * Excluding them breaks the run into pieces that were not adjacent in time, and an average of 5
 * spanning a gap is not quite the thing a timer would show. That is the lesser wrong: the
 * alternative is averaging in a solve that never had a time.
 */
export function countableSolves(records: readonly SolveRecord[]): number[] {
  return records
    .filter((record) => record.outcome !== "discarded" && record.durationMs !== null)
    .slice()
    .sort((a, b) => a.startedAt - b.startedAt)
    .map((record) => record.durationMs!);
}

/**
 * One average of `size`, by the WCA rule: strike the best and the worst, mean the rest.
 *
 * `null` when the window is not full — an average of five over four solves is not an average of
 * five, and showing one would be quietly wrong in the direction people care about most.
 */
export function averageOf(durations: readonly number[], size: number): number | null {
  if (durations.length !== size || size < 3) return null;
  const sorted = [...durations].sort((a, b) => a - b);
  const middle = sorted.slice(1, -1);
  return middle.reduce((total, value) => total + value, 0) / middle.length;
}

/** The most recent average of `size`, which is the one a timer shows as you solve. */
export function currentAverage(durations: readonly number[], size: number): number | null {
  return averageOf(durations.slice(-size), size);
}

/**
 * The best average of `size` anywhere in the run — the personal best.
 *
 * Every window is considered, not only the ones ending on a multiple of the size: a run of five
 * good solves counts wherever it happened to fall.
 */
export function bestAverage(durations: readonly number[], size: number): number | null {
  let best: number | null = null;
  for (let end = size; end <= durations.length; end++) {
    const average = averageOf(durations.slice(end - size, end), size);
    if (average !== null && (best === null || average < best)) best = average;
  }
  return best;
}

export function sessionStats(records: readonly SolveRecord[]): SessionStats {
  const durations = countableSolves(records);
  const averages = Object.fromEntries(
    AVERAGE_SIZES.map((size) => [
      size,
      { current: currentAverage(durations, size), best: bestAverage(durations, size) },
    ]),
  ) as Record<AverageSize, AverageStat>;

  return {
    count: durations.length,
    excluded: records.length - durations.length,
    best: durations.length > 0 ? Math.min(...durations) : null,
    worst: durations.length > 0 ? Math.max(...durations) : null,
    mean:
      durations.length > 0
        ? durations.reduce((total, value) => total + value, 0) / durations.length
        : null,
    averages,
  };
}
