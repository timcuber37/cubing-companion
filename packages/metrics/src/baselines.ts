/**
 * The shape of the corpus baselines, and what each one may honestly be used for.
 *
 * Kept separate from `baselines.generated.ts` so the generated file is data and nothing else.
 *
 * Three kinds of baseline live here, and they are **not** interchangeable:
 *
 * - **Turn and rotation counts** transfer to a smart-cube user unchanged. A move is a move.
 * - **Times** do not, quite. The corpus is stackmat-timed and drifts hard across eras, so time
 *   baselines are scoped to 2021 onwards and two of the windows carry a correction (below).
 * - **Pauses, fluidity, recognition/execution** have no baseline at all and never will from this
 *   corpus: reconstructions carry no per-move timestamps. Those metrics are measured and banded,
 *   never given a percentile.
 */

/** A sampled distribution, the same shape `corpus` reports. */
export interface Distribution {
  readonly n: number;
  readonly mean: number;
  readonly min: number;
  readonly p10: number;
  readonly p25: number;
  readonly median: number;
  readonly p75: number;
  readonly p90: number;
  readonly max: number;
}

/**
 * A time window the corpus can actually measure.
 *
 * reco.nz publishes `Total`, `F2L`, `LL`, `Cross+1`, `OLS` and `PLL`. Those overlap rather than
 * partition, but they decompose into these five — an identity the generator asserts against our
 * own segmenter rather than assuming.
 *
 * Note what is missing: cross, pair 1, pair 2 and pair 3 individually. The app times them
 * precisely; the corpus simply never recorded them, so they get no percentile.
 */
export const TimeWindow = {
  /** Cross and the first pair together — the corpus cannot separate them. */
  CrossPlusOne: "cross+1",
  /** Pairs two and three as one block. */
  Pairs23: "pairs2-3",
  Pair4: "pair4",
  OLL: "oll",
  PLL: "pll",
  F2L: "f2l",
  LastLayer: "last-layer",
  Total: "total",
} as const;
export type TimeWindow = (typeof TimeWindow)[keyof typeof TimeWindow];

export interface TimeBaseline {
  readonly window: TimeWindow;
  readonly seconds: Distribution;
  readonly tps: Distribution;
  /**
   * Seconds of stackmat overhead removed from every pro time before the distribution was taken.
   *
   * Non-zero for exactly the two windows that touch the timer: the grab at the start and the
   * drop at the end. See `TIMER_OVERHEAD` for how it was derived and how much to trust it.
   */
  readonly overheadCorrectionSeconds: number;
}

export interface TurnBaseline {
  /** A `Phase` from `analysis`, or a group name like `f2l`. */
  readonly key: string;
  readonly turns: Distribution;
  readonly rotations: Distribution | null;
}

export interface Baselines {
  readonly generatedAt: string;
  readonly corpusSolves: number;
  /** Solves contributing to the time distributions, after the era filter. */
  readonly timedSolves: number;
  /** Times are taken from this year onwards; move counts use every era. */
  readonly timeEraFrom: number;
  readonly turns: readonly TurnBaseline[];
  readonly times: readonly TimeBaseline[];
  readonly timerOverhead: TimerOverhead;
}

/**
 * The stackmat dead time removed from the two windows that touch the timer.
 *
 * A stackmat starts when the hands leave the pad and stops when they touch it again, and a
 * reconstructor allocates that dead time into the first and last phases. Our own clock runs from
 * the first move to the last — `session/src/segmented.ts` deliberately gives the opening interval
 * to nobody — so without a correction the pro numbers would be inflated against ours and every
 * user would look faster than they are.
 *
 * Derived by the generator, not typed in by hand: it fits `seconds = intercept + slope · turns`
 * across each window and reads the dead time off as the gap between a window's intercept and the
 * mean intercept of the windows that do not touch the timer.
 *
 * **Treat this as an estimate, not a measurement.** The standard errors are small, but the model
 * is wrong in a way they do not capture: per-move rates genuinely differ between phases, so an
 * intercept is an extrapolation to zero moves far outside the data — which is why one of the
 * clean windows fits a slightly negative intercept. The magnitudes are physically plausible for
 * a grab and a drop, and that is the strongest claim available. Anything scored against a
 * corrected window is flagged so it is never mistaken for a clean comparison.
 */
export interface TimerOverhead {
  readonly crossPlusOneSeconds: number;
  readonly pllSeconds: number;
  /** Per-window regression fits, so the estimate can be audited rather than trusted. */
  readonly fits: readonly {
    readonly window: TimeWindow;
    readonly n: number;
    readonly intercept: number;
    readonly interceptStdError: number;
    readonly secondsPerTurn: number;
    /** False for the two windows that touch the timer. */
    readonly clean: boolean;
  }[];
}
