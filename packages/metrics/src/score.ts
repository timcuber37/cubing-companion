/**
 * Scoring a solve against the pro corpus.
 *
 * `PLAN.md`'s rule for this: show sub-scores, never just one opaque number. A composite that
 * cannot be taken apart tells a solver they were a 63 and gives them nothing to do about it, so
 * the composite here is always accompanied by the components it averaged, and any metric without
 * a corpus baseline stays out of it rather than being folded in with an invented weight.
 */
import { Phase } from "@cubing-companion/analysis";
import { BASELINES } from "./baselines.generated.ts";
import { TimeWindow, type Distribution } from "./baselines.ts";
import type { SolveMetrics } from "./metrics.ts";

/** One measurement placed against the corpus. */
export interface Rated {
  /**
   * 0–100, higher is better: the share of pro solves this beats.
   *
   * The underlying quantity, and a percentile rather than a grade — 50 means "as good as the
   * median world-class solve", which for almost every user is a very good day. {@link rating}
   * is what gets shown; this is what it is derived from, and what the calibration tests pin.
   */
  readonly score: number;
  /**
   * The same thing out of ten, which is what the UI shows.
   *
   * A bare percentile invites being read as a mark out of a hundred, where 50 looks like a
   * failure rather than like matching the median solve in a corpus of world records. Out of ten
   * it reads as a rating, which is what it is.
   */
  readonly rating: number;
  readonly value: number;
  readonly distribution: Distribution;
  /**
   * True when the baseline had stackmat dead time removed to make it comparable.
   *
   * Carried all the way to the UI on purpose: it marks an estimate rather than a measurement.
   * See `TimerOverhead` in `./baselines.ts`.
   */
  readonly overheadCorrected: boolean;
}

/**
 * Where `value` falls in a distribution, 0–1, by linear interpolation between stored knots.
 *
 * Seven knots is coarse in the tails and exact where it matters — nearly every real solve lands
 * between p10 and p90, and the shape there is close enough to linear that the error is far
 * smaller than the corpus's own sampling noise.
 */
export function corpusRank(value: number, d: Distribution): number {
  const knots: readonly (readonly [number, number])[] = [
    [d.min, 0],
    [d.p10, 0.1],
    [d.p25, 0.25],
    [d.median, 0.5],
    [d.p75, 0.75],
    [d.p90, 0.9],
    [d.max, 1],
  ];
  if (value <= knots[0]![0]) return 0;
  if (value >= knots[knots.length - 1]![0]) return 1;
  for (let i = 1; i < knots.length; i++) {
    const [x1, y1] = knots[i]!;
    const [x0, y0] = knots[i - 1]!;
    if (value <= x1) {
      // Ties in the knots happen when a distribution is degenerate; take the lower bound.
      if (x1 === x0) return y0;
      return y0 + ((value - x0) / (x1 - x0)) * (y1 - y0);
    }
  }
  return 1;
}

/** Percentile out of ten, to one decimal — more precision than the corpus can justify. */
export const asRating = (score: number): number => Math.round(score) / 10;

/** Every metric scored here is one where less is better: fewer moves, fewer seconds. */
function rate(value: number, d: Distribution, overheadCorrected = false): Rated {
  const score = 100 * (1 - corpusRank(value, d));
  return {
    value,
    score,
    rating: asRating(score),
    distribution: d,
    overheadCorrected,
  };
}

const turnBaseline = (key: string) => BASELINES.turns.find((t) => t.key === key);
const timeBaseline = (window: TimeWindow) =>
  BASELINES.times.find((t) => t.window === window);

/** Turn count for a phase or group, against the corpus. `null` when there is no baseline. */
export function rateTurns(key: string, turns: number): Rated | null {
  const baseline = turnBaseline(key);
  return baseline ? rate(turns, baseline.turns) : null;
}

export function rateRotations(key: string, rotations: number): Rated | null {
  const baseline = turnBaseline(key);
  return baseline?.rotations ? rate(rotations, baseline.rotations) : null;
}

export function rateTime(window: TimeWindow, seconds: number): Rated | null {
  const baseline = timeBaseline(window);
  if (!baseline) return null;
  return rate(seconds, baseline.seconds, baseline.overheadCorrectionSeconds > 0);
}

/**
 * The time windows the corpus can actually judge, summed from the solve's phases.
 *
 * Cross, pair 1, pair 2 and pair 3 are missing individually and always will be: reco.nz never
 * published them. The app measures them precisely and shows them; they simply get no percentile.
 */
const WINDOW_PHASES: Readonly<Record<TimeWindow, readonly Phase[]>> = {
  [TimeWindow.CrossPlusOne]: [Phase.Cross, Phase.F2L1],
  [TimeWindow.Pairs23]: [Phase.F2L2, Phase.F2L3],
  [TimeWindow.Pair4]: [Phase.F2L4],
  [TimeWindow.OLL]: [Phase.OLL],
  // The corpus's PLL window runs to the end of the solve — `LL = OLL + PLL` and LL covers
  // everything after F2L — so any AUF belongs inside it.
  [TimeWindow.PLL]: [Phase.PLL, Phase.AUF],
  [TimeWindow.F2L]: [Phase.Cross, Phase.F2L1, Phase.F2L2, Phase.F2L3, Phase.F2L4],
  [TimeWindow.LastLayer]: [Phase.OLL, Phase.PLL, Phase.AUF],
  [TimeWindow.Total]: [],
};

export interface WindowScore {
  readonly window: TimeWindow;
  readonly seconds: number;
  readonly turns: number;
  readonly time: Rated | null;
}

export function scoreWindows(metrics: SolveMetrics): readonly WindowScore[] {
  const scores: WindowScore[] = [];
  for (const window of Object.values(TimeWindow)) {
    const phases =
      window === TimeWindow.Total
        ? metrics.phases
        : metrics.phases.filter((p) => WINDOW_PHASES[window].includes(p.phase));
    if (phases.length === 0) continue;
    // One unusable timestamp anywhere in the window makes the whole window unusable, rather
    // than quietly reporting a window that is missing a phase.
    if (phases.some((p) => p.durationMs === null)) continue;

    const seconds = phases.reduce((total, p) => total + p.durationMs!, 0) / 1000;
    const turns = phases.reduce((total, p) => total + p.turns, 0);
    scores.push({ window, seconds, turns, time: rateTime(window, seconds) });
  }
  return scores;
}

/** Fluidity has no corpus baseline, so it gets a band and a name instead of a percentile. */
export const FLUIDITY_BANDS: readonly { readonly atLeast: number; readonly label: string }[] = [
  { atLeast: 0.9, label: "flowing" },
  { atLeast: 0.75, label: "steady" },
  { atLeast: 0.6, label: "hesitant" },
  { atLeast: 0, label: "stop-start" },
];

export function fluidityBand(fluidity: number | null): string | null {
  if (fluidity === null) return null;
  return FLUIDITY_BANDS.find((band) => fluidity >= band.atLeast)!.label;
}

export interface PhaseScore {
  readonly phase: Phase;
  readonly turns: Rated | null;
}

export interface SolveScore {
  /** Named sub-scores, each 0–100. Always shown; the composite is just their mean. */
  readonly components: readonly { readonly label: string; readonly rated: Rated }[];
  /**
   * Mean of the components, or `null` when nothing could be scored. 0–100.
   *
   * Never display this without the components beside it.
   */
  readonly composite: number | null;
  /** The composite out of ten, which is the headline figure the UI shows. */
  readonly rating: number | null;
  readonly phases: readonly PhaseScore[];
  readonly windows: readonly WindowScore[];
  /** Measured, banded, and deliberately not part of the composite: no corpus baseline exists. */
  readonly fluidity: number | null;
  readonly fluidityBand: string | null;
  readonly baselineNote: {
    readonly corpusSolves: number;
    readonly timedSolves: number;
    readonly timeEraFrom: number;
    readonly generatedAt: string;
  };
}

export function scoreSolve(metrics: SolveMetrics): SolveScore {
  const windows = scoreWindows(metrics);
  const total = windows.find((w) => w.window === TimeWindow.Total);

  const components: { label: string; rated: Rated }[] = [];
  const add = (label: string, rated: Rated | null) => {
    if (rated) components.push({ label, rated });
  };
  add("efficiency", rateTurns("total", metrics.turns));
  add("rotations", rateRotations("total", metrics.rotations));
  if (total) add("speed", total.time);

  const composite =
    components.length === 0
      ? null
      : components.reduce((sum, c) => sum + c.rated.score, 0) / components.length;

  return {
    components,
    composite,
    rating: composite === null ? null : asRating(composite),
    phases: metrics.phases.map((p) => ({
      phase: p.phase,
      turns: rateTurns(p.phase, p.turns),
    })),
    windows,
    fluidity: metrics.fluidity,
    fluidityBand: fluidityBand(metrics.fluidity),
    baselineNote: {
      corpusSolves: BASELINES.corpusSolves,
      timedSolves: BASELINES.timedSolves,
      timeEraFrom: BASELINES.timeEraFrom,
      generatedAt: BASELINES.generatedAt,
    },
  };
}
