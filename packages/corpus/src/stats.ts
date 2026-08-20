/**
 * Corpus statistics — the distributions A3 scores user solves against.
 *
 * Two sources of truth, kept separate because they have different granularity and
 * different reliability:
 *
 * - **Move counts** come from the reconstructions, segmented per phase. Exact.
 * - **Timings** come from the published stats table, which is coarser (Total, F2L, LL,
 *   Cross+1, OLS, PLL) because reconstructions carry no per-move timestamps.
 *
 * A caveat that belongs with any timing figure computed here: reco.nz removed its
 * smartcube reconstructions because "smartcube times differ too heavily from
 * keyboard/stackmat solve times". These distributions are therefore stackmat-timed. Move
 * counts transfer to a smart-cube user unchanged; TPS and durations carry a systematic
 * bias and should not be presented as a like-for-like percentile.
 */
import { F2L_PHASES, Phase, type SolveRecord } from "./types.ts";

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

export interface PhaseSummary {
  readonly phase: Phase;
  readonly turns: Distribution | null;
  readonly rotations: Distribution | null;
}

export interface CorpusSummary {
  readonly totalSolves: number;
  readonly byMethod: Readonly<Record<string, number>>;
  readonly byQuality: Readonly<Record<string, number>>;
  readonly byEvent: Readonly<Record<string, number>>;
  /** Per-phase move counts, from `clean` solves only. */
  readonly phases: readonly PhaseSummary[];
  /**
   * Distributions over phase *groups*, which sidestep the xcross selection bias.
   *
   * A per-phase `cross` distribution can only be built from solves where cross and first
   * pair were separate — that is, solves where the solver did *not* get an xcross. Those
   * are the harder crosses, so the resulting baseline flatters any user compared against
   * it. `cross+1` is well defined either way, which is why reco.nz uses it as its unit.
   */
  readonly groups: Readonly<Record<string, Distribution>>;
  /** Share of solves whose cross and first pair were merged into one xcross-style block. */
  readonly xcrossRate: number;
  readonly solveTurns: Distribution | null;
  readonly solveRotations: Distribution | null;
  readonly solveSeconds: Distribution | null;
  /** Published timing per stat group, e.g. `F2L`, `LL`, `Cross+1`. */
  readonly publishedTiming: Readonly<Record<string, Distribution>>;
  /** Labels that normalization did not recognize, with counts, most frequent first. */
  readonly unknownLabels: readonly (readonly [string, number])[];
}

/** Linear-interpolated percentile of an unsorted sample. `p` is in [0, 1]. */
export function percentile(values: readonly number[], p: number): number {
  if (values.length === 0) return Number.NaN;
  const sorted = [...values].sort((a, b) => a - b);
  if (sorted.length === 1) return sorted[0]!;
  const position = (sorted.length - 1) * p;
  const lower = Math.floor(position);
  const upper = Math.ceil(position);
  const weight = position - lower;
  return sorted[lower]! * (1 - weight) + sorted[upper]! * weight;
}

function distribution(values: readonly number[]): Distribution | null {
  if (values.length === 0) return null;
  return {
    n: values.length,
    mean: values.reduce((a, b) => a + b, 0) / values.length,
    min: Math.min(...values),
    p10: percentile(values, 0.1),
    p25: percentile(values, 0.25),
    median: percentile(values, 0.5),
    p75: percentile(values, 0.75),
    p90: percentile(values, 0.9),
    max: Math.max(...values),
  };
}

function tally(values: readonly string[]): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const value of values) counts[value] = (counts[value] ?? 0) + 1;
  return counts;
}

const SUMMARY_PHASES: readonly Phase[] = [
  Phase.Cross,
  ...F2L_PHASES,
  Phase.EO,
  Phase.OLL,
  Phase.PLL,
  Phase.LastLayer,
  Phase.AUF,
];

/** Phase groups whose totals are well defined regardless of how a solve was annotated. */
const GROUPS: readonly (readonly [string, readonly Phase[]])[] = [
  ["cross+1", [Phase.Cross, Phase.F2L1]],
  ["cross+2", [Phase.Cross, Phase.F2L1, Phase.F2L2]],
  ["f2l", [Phase.Cross, ...F2L_PHASES]],
  ["last-layer", [Phase.OLL, Phase.PLL]],
];

/**
 * Total turns for a set of phases, or `null` if this solve cannot express that set
 * exactly.
 *
 * A solve qualifies when its segments covering any of the wanted phases together cover
 * all of them and nothing else — so an `xcross` block counts toward `cross+1` just as a
 * separate `cross` and `1st pair` do, while an `xxcross` does not, because it also
 * carries the second pair.
 *
 * A solve containing *any* unrecognized segment is excluded outright. Those moves belong
 * to some phase, and we cannot tell which — so silently skipping them would undercount
 * every group they should have contributed to, producing a total that looks valid and is
 * quietly wrong. Excluding the solve costs a fraction of a percent of the corpus; a
 * plausible-but-wrong figure would cost far more.
 */
function groupTurns(
  record: SolveRecord,
  wanted: readonly Phase[],
): number | null {
  if (record.segments.some((s) => s.phases.includes(Phase.Unknown))) return null;

  const want = new Set<Phase>(wanted);
  const covered = new Set<Phase>();
  let turns = 0;

  for (const segment of record.segments) {
    const touches = segment.phases.some((p) => want.has(p));
    if (!touches) continue;
    // A segment spilling outside the group makes the total unattributable.
    if (segment.phases.some((p) => !want.has(p))) return null;
    for (const phase of segment.phases) covered.add(phase);
    turns += segment.turns;
  }

  return covered.size === want.size ? turns : null;
}

/**
 * Summarize a corpus.
 *
 * Per-phase distributions use only `clean` solves — those where every CFOP phase appears
 * exactly once and unmerged. Including merged solves would attribute one block's moves to
 * several phases and inflate every one of them.
 */
export function summarize(
  records: readonly SolveRecord[],
  unknownLabelCounts: Readonly<Record<string, number>> = {},
): CorpusSummary {
  const clean = records.filter((r) => r.quality === "clean");

  const phases: PhaseSummary[] = SUMMARY_PHASES.map((phase) => {
    const turns: number[] = [];
    const rotations: number[] = [];
    for (const record of clean) {
      for (const segment of record.segments) {
        if (segment.merged || !segment.phases.includes(phase)) continue;
        turns.push(segment.turns);
        rotations.push(segment.rotations);
      }
    }
    return {
      phase,
      turns: distribution(turns),
      rotations: distribution(rotations),
    };
  });

  const groups: Record<string, Distribution> = {};
  for (const [name, phases] of GROUPS) {
    const values = records
      .map((r) => groupTurns(r, phases))
      .filter((v): v is number => v !== null);
    const dist = distribution(values);
    if (dist) groups[name] = dist;
  }

  // A solve counts as xcross-style when one segment covers both cross and first pair.
  const xcrossSolves = records.filter((r) =>
    r.segments.some(
      (s) => s.phases.includes(Phase.Cross) && s.phases.includes(Phase.F2L1),
    ),
  ).length;

  const publishedTiming: Record<string, Distribution> = {};
  const groupValues = new Map<string, number[]>();
  for (const record of records) {
    if (!record.stats) continue;
    for (const [group, stat] of Object.entries(record.stats)) {
      if (stat.time === null) continue;
      const list = groupValues.get(group) ?? [];
      list.push(stat.time);
      groupValues.set(group, list);
    }
  }
  for (const [group, values] of groupValues) {
    const dist = distribution(values);
    if (dist) publishedTiming[group] = dist;
  }

  return {
    totalSolves: records.length,
    byMethod: tally(records.map((r) => r.method)),
    byQuality: tally(records.map((r) => r.quality)),
    byEvent: tally(records.map((r) => r.event ?? "unknown")),
    phases,
    groups,
    xcrossRate: records.length === 0 ? 0 : xcrossSolves / records.length,
    solveTurns: distribution(records.map((r) => r.totalTurns)),
    solveRotations: distribution(records.map((r) => r.totalRotations)),
    solveSeconds: distribution(
      records.map((r) => r.timeSeconds).filter((t): t is number => t !== null),
    ),
    publishedTiming,
    unknownLabels: Object.entries(unknownLabelCounts).sort((a, b) => b[1] - a[1]),
  };
}
