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

/** Which population a rating was measured against. */
export type Reference = "corpus" | "you";

/** One measurement placed against a reference. */
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
  /** What this was measured against — the corpus, or the user's own recent solves. */
  readonly reference: Reference;
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

/**
 * How a measurement becomes a rating out of ten.
 *
 * **Not a percentile.** A percentile is the honest answer to "what share of these solves did you
 * beat", and a poor rating, because it is only as sensitive as the reference is wide. Half of all
 * world-class solves land inside a nine-move band, so four moves either side of their median
 * swings a percentile by two and a half points — and above 70 moves it saturates completely, with
 * 80 and 95 moves scoring the same 0.8. The number stops discriminating exactly where most people
 * are.
 *
 * So the rating is linear in the **measured quantity**, with its slope taken from the reference's
 * own spread: `p10` and `p90` are pinned to the two anchors below and the same slope continues
 * past them. Every constant comes from the distribution rather than from taste, and the scale
 * keeps separating solves well outside the reference range.
 */
interface RatingAnchors {
  /** Rating at the reference's 10th percentile — its better end, since less is better here. */
  readonly best: number;
  /** Rating at its 90th percentile. */
  readonly worst: number;
}

/**
 * Against the pro corpus, being anywhere in the band at all is excellent.
 *
 * The reference is world-class solves, not people like the user, so matching the *slowest* tenth
 * of them still deserves a 6 and matching the median deserves an 8.
 */
export const CORPUS_ANCHORS: RatingAnchors = { best: 10, worst: 6 };

/**
 * Against your own recent solves, the scale has to be centred on you.
 *
 * Here the reference *is* the user, so a typical solve should read as typical: their median lands
 * at 5, a good one at 8, a bad one at 2. Using the corpus anchors would tell everybody that their
 * average day was an eight.
 */
export const SELF_ANCHORS: RatingAnchors = { best: 8, worst: 2 };

/**
 * The narrowest spread a reference is allowed to have, as a share of its own median.
 *
 * Without this the scale reproduces the exact fault it was built to fix, just somewhere else. A
 * very consistent solver — every solve between 10.0s and 10.5s — has a spread of 0.4s, so a solve
 * a tenth of a second off their usual would swing more than a full anchor width and land on zero.
 * Nobody's times are meaningfully distinguishable at that resolution; treating a 1% difference as
 * the whole scale is amplifying noise.
 *
 * It never binds on the corpus, whose spreads are far wider than a tenth of their medians. It
 * exists for references built from one person's handful of solves.
 */
const MIN_SPREAD_FRACTION = 0.1;

function ratingFrom(value: number, d: Distribution, anchors: RatingAnchors): number {
  const width = Math.max(d.p90 - d.p10, Math.abs(d.median) * MIN_SPREAD_FRACTION);
  // A reference with no spread at all cannot rank anything; put everything at the midpoint
  // rather than dividing by zero.
  if (!(width > 0)) return (anchors.best + anchors.worst) / 2;
  const raw =
    anchors.best - (anchors.best - anchors.worst) * ((value - d.p10) / width);
  return Math.round(Math.max(0, Math.min(10, raw)) * 10) / 10;
}

/** Every metric scored here is one where less is better: fewer moves, fewer seconds. */
function rate(
  value: number,
  d: Distribution,
  options: { overheadCorrected?: boolean; anchors?: RatingAnchors; reference?: Reference } = {},
): Rated {
  const anchors = options.anchors ?? CORPUS_ANCHORS;
  return {
    value,
    score: 100 * (1 - corpusRank(value, d)),
    rating: ratingFrom(value, d, anchors),
    distribution: d,
    reference: options.reference ?? "corpus",
    overheadCorrected: options.overheadCorrected ?? false,
  };
}

/** Percentiles of a raw sample, so a user's own solves can be a reference like any other. */
export function distributionOf(values: readonly number[]): Distribution | null {
  const sorted = [...values].sort((a, b) => a - b);
  if (sorted.length === 0) return null;
  const at = (p: number) => {
    const position = p * (sorted.length - 1);
    const lower = Math.floor(position);
    const upper = Math.ceil(position);
    return sorted[lower]! + (sorted[upper]! - sorted[lower]!) * (position - lower);
  };
  return {
    n: sorted.length,
    mean: sorted.reduce((a, b) => a + b, 0) / sorted.length,
    min: sorted[0]!,
    p10: at(0.1),
    p25: at(0.25),
    median: at(0.5),
    p75: at(0.75),
    p90: at(0.9),
    max: sorted[sorted.length - 1]!,
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
  return rate(seconds, baseline.seconds, {
    overheadCorrected: baseline.overheadCorrectionSeconds > 0,
  });
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

export interface ScoreOptions {
  /**
   * Whether whole-cube rotations were observable at all.
   *
   * When false, rotations are left out of the score entirely rather than counted as zero. A
   * smart cube reports no rotations because nothing can see them — a rotation turns no face
   * against the core — and zero rotations rates better than every solve in the corpus, whose
   * median solver rotates four times. Scoring it would hand out a perfect mark for a quantity
   * nobody measured, and quietly lift the composite with it.
   *
   * Defaults to true, which is right for anything hand-entered or replayed.
   */
  readonly rotationsObserved?: boolean;
  /**
   * Durations of the solver's other recent solves, for rating speed against themselves.
   *
   * Speed is the one measurement where the corpus is the wrong reference. Pros are far enough
   * ahead that any corpus-anchored scale bottoms out around thirteen seconds — a twenty-second
   * solve and a forty-second one both score zero, which says nothing and cannot improve. Rated
   * against your own recent solves it answers the question actually worth asking, and it is the
   * only reference the solver is genuinely a member of.
   *
   * Move counts stay corpus-anchored: efficiency is a matter of what you know rather than how
   * fast your hands are, and a good hobbyist really can approach pro numbers.
   */
  readonly recentDurationsMs?: readonly number[];
}

/** Below this there is not enough of your own history for a median to mean anything. */
export const MIN_OWN_SOLVES = 5;

export interface SolveScore {
  /** Named sub-scores, each out of ten. Always shown; the headline is just their mean. */
  readonly components: readonly { readonly label: string; readonly rated: Rated }[];
  /**
   * Mean of the component ratings, out of ten, or `null` when nothing could be scored.
   *
   * Never display this without the components beside it: a single figure averaging things
   * measured against different references tells a solver they were a 7 and gives them nothing
   * to do about it.
   */
  readonly rating: number | null;
  readonly phases: readonly PhaseScore[];
  readonly windows: readonly WindowScore[];
  /**
   * Metrics left unscored, and why — so the UI can say what is missing instead of hiding it.
   *
   * A score that quietly drops a component looks the same as one that never had it.
   */
  readonly omitted: readonly { readonly label: string; readonly reason: string }[];
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

export function scoreSolve(
  metrics: SolveMetrics,
  options: ScoreOptions = {},
): SolveScore {
  const windows = scoreWindows(metrics);
  const total = windows.find((w) => w.window === TimeWindow.Total);
  const rotationsObserved = options.rotationsObserved ?? true;

  const components: { label: string; rated: Rated }[] = [];
  const omitted: { label: string; reason: string }[] = [];
  const add = (label: string, rated: Rated | null) => {
    if (rated) components.push({ label, rated });
  };
  add("efficiency", rateTurns("total", metrics.turns));
  if (rotationsObserved) {
    add("rotations", rateRotations("total", metrics.rotations));
  } else {
    omitted.push({
      label: "rotations",
      reason: "this cube cannot report them, so none were seen rather than none were made",
    });
  }

  const own = distributionOf(options.recentDurationsMs ?? []);
  if (metrics.durationMs === null) {
    omitted.push({ label: "speed", reason: "this solve has no usable clock" });
  } else if (!own || own.n < MIN_OWN_SOLVES) {
    omitted.push({
      label: "speed",
      reason: `rated against your own solves, and there are fewer than ${MIN_OWN_SOLVES} to compare with yet`,
    });
  } else {
    add("speed", rate(metrics.durationMs, own, { anchors: SELF_ANCHORS, reference: "you" }));
  }

  const rating =
    components.length === 0
      ? null
      : Math.round(
          (components.reduce((sum, c) => sum + c.rated.rating, 0) / components.length) * 10,
        ) / 10;

  return {
    components,
    rating,
    omitted,
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
