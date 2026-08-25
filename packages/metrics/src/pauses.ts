/**
 * Pause detection and fluidity.
 *
 * This is the one part of A3 with **no ground truth to fit against**. Move counts can be checked
 * against the corpus and times against the published splits, but reconstructions carry no
 * per-move timestamps, so there is nothing to calibrate a pause threshold on and no percentile a
 * pause count can ever be scored against. The constants below are therefore judgement, exported
 * and adjustable, and everything derived from them is reported as a measurement with a band —
 * never as a percentile.
 */

export interface PauseOptions {
  /**
   * A gap must be at least this long to count, however slow the solve.
   *
   * Below roughly a fifth of a second nothing has really stopped: that is regrip and reaction
   * time, present in every solve including the good ones.
   */
  readonly minimumMs: number;
  /**
   * ...and at least this multiple of the solver's own median gap.
   *
   * The relative half is what makes the metric mean the same thing to different solvers. A
   * 400 ms gap is a visible stall for someone averaging sub-8 and entirely normal for someone
   * averaging 20, so an absolute threshold alone would tell a beginner they pause constantly and
   * a fast solver that they never do.
   */
  readonly relativeToMedian: number;
}

export const DEFAULT_PAUSE_OPTIONS: PauseOptions = {
  minimumMs: 250,
  relativeToMedian: 2.5,
};

/** A gap between two consecutive moves that is long enough to count as stopping. */
export interface Pause {
  /** The move the pause comes *before* — the solver was deciding what to do next. */
  readonly moveIndex: number;
  readonly durationMs: number;
  /** Milliseconds from the first move of the solve, for drawing on a timeline. */
  readonly offsetMs: number;
}

/** Gaps between consecutive moves. `null` where either end has no usable timestamp. */
export function moveGaps(
  timestamps: readonly (number | null)[],
): readonly (number | null)[] {
  const gaps: (number | null)[] = [];
  for (let i = 1; i < timestamps.length; i++) {
    const previous = timestamps[i - 1];
    const current = timestamps[i];
    gaps.push(previous == null || current == null ? null : current - previous);
  }
  return gaps;
}

/** Median of the usable gaps, or `null` when a solve carries too few timestamps to have one. */
export function medianGapMs(timestamps: readonly (number | null)[]): number | null {
  const usable = moveGaps(timestamps)
    .filter((gap): gap is number => gap !== null)
    .sort((a, b) => a - b);
  if (usable.length === 0) return null;
  const middle = usable.length >> 1;
  return usable.length % 2 === 1
    ? usable[middle]!
    : (usable[middle - 1]! + usable[middle]!) / 2;
}

/** The threshold a gap must clear, given the solve's own tempo. */
export function pauseThresholdMs(
  timestamps: readonly (number | null)[],
  options: PauseOptions = DEFAULT_PAUSE_OPTIONS,
): number {
  const median = medianGapMs(timestamps);
  if (median === null) return options.minimumMs;
  return Math.max(options.minimumMs, median * options.relativeToMedian);
}

/**
 * Every gap long enough to count as a pause, in move order.
 *
 * The gap before the *first* move is never a pause: the clock starts when that move lands, so
 * there is no measured interval before it. See `session/src/segmented.ts` for the same rule
 * applied to phase durations.
 */
export function detectPauses(
  timestamps: readonly (number | null)[],
  options: PauseOptions = DEFAULT_PAUSE_OPTIONS,
): readonly Pause[] {
  const threshold = pauseThresholdMs(timestamps, options);
  const start = timestamps.find((t) => t !== null);
  if (start == null) return [];

  const pauses: Pause[] = [];
  const gaps = moveGaps(timestamps);
  for (let i = 0; i < gaps.length; i++) {
    const gap = gaps[i];
    if (gap == null || gap < threshold) continue;
    // `gaps[i]` sits between move `i` and move `i + 1`.
    pauses.push({
      moveIndex: i + 1,
      durationMs: gap,
      offsetMs: timestamps[i]! - start,
    });
  }
  return pauses;
}
