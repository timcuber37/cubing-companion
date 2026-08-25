/**
 * Builds `src/baselines.generated.ts` from B1's corpus.
 *
 * Run: npm run generate -w @cubing-companion/metrics
 *
 * The output is committed, following the `tables.generated.ts` precedent in `engine`: the corpus
 * itself is not redistributed, so a contributor without it can still build and test, and the
 * browser bundle needs no runtime data fetch.
 *
 * Two things here are load-bearing enough to be asserted rather than assumed:
 *
 * 1. **The window decomposition.** reco.nz publishes overlapping windows (`Cross+1`, `OLS`, ...)
 *    and this script decomposes them into disjoint phases. That rests on `Cross+1 == cross+pair1`
 *    and `OLS == pair4+OLL`, which are checked against our own segmenter's turn counts. If a
 *    corpus refresh ever changes the window semantics, this fails loudly instead of silently
 *    shifting every baseline in the app.
 * 2. **The timer-overhead estimate**, re-derived on every run rather than carried as folklore.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { percentile } from "@cubing-companion/corpus";
import { TimeWindow, type Distribution } from "../src/baselines.ts";

const CORPUS = fileURLToPath(new URL("../../../data/corpus.jsonl", import.meta.url));
const OUTPUT = fileURLToPath(new URL("../src/baselines.generated.ts", import.meta.url));

/** Times drift ~35% across the corpus's span while move counts drift ~9%; see the README. */
const TIME_ERA_FROM = 2021;

interface PublishedStat {
  time: number | null;
  stm: number | null;
}

interface CorpusRecord {
  id: number;
  date: string;
  quality: string;
  timeSeconds: number | null;
  totalTurns: number;
  totalRotations: number;
  stats: Record<string, PublishedStat | undefined>;
  segments: { phases: string[]; turns: number; rotations: number }[];
}

const records: CorpusRecord[] = readFileSync(CORPUS, "utf8")
  .trim()
  .split("\n")
  .map((line) => JSON.parse(line) as CorpusRecord);

console.log(`read ${records.length.toLocaleString()} solves\n`);

/** Turns and rotations per phase, for a solve whose segments map one-to-one onto phases. */
function phaseTotals(record: CorpusRecord): Map<string, { turns: number; rotations: number }> {
  const totals = new Map<string, { turns: number; rotations: number }>();
  for (const segment of record.segments) {
    for (const phase of segment.phases) {
      const entry = totals.get(phase) ?? { turns: 0, rotations: 0 };
      entry.turns += segment.turns;
      entry.rotations += segment.rotations;
      totals.set(phase, entry);
    }
  }
  return totals;
}

// -------------------------------------------------------------------------------------------
// 1. The window decomposition, checked before anything is built on it.
// -------------------------------------------------------------------------------------------

const REQUIRED_PHASES = ["cross", "f2l1", "f2l2", "f2l3", "f2l4", "oll", "pll"];

let checked = 0;
let crossPlusOneExact = 0;
let olsExact = 0;

for (const record of records) {
  if (record.quality !== "clean") continue;
  const stats = record.stats;
  if (stats.OLS?.stm == null || stats.PLL?.stm == null || stats["Cross+1"]?.stm == null) continue;
  const totals = phaseTotals(record);
  if (!REQUIRED_PHASES.every((phase) => totals.has(phase))) continue;

  checked++;
  const ollTurns = stats.LL!.stm! - stats.PLL.stm;
  if (stats["Cross+1"].stm === totals.get("cross")!.turns + totals.get("f2l1")!.turns) {
    crossPlusOneExact++;
  }
  if (stats.OLS.stm === totals.get("f2l4")!.turns + ollTurns) olsExact++;
}

const crossRate = crossPlusOneExact / checked;
const olsRate = olsExact / checked;
console.log("=== WINDOW DECOMPOSITION ===\n");
console.log(
  `  Cross+1 == cross + pair 1   ${crossPlusOneExact.toLocaleString()} / ${checked.toLocaleString()}  (${(100 * crossRate).toFixed(2)}%)`,
);
console.log(
  `  OLS     == pair 4 + OLL     ${olsExact.toLocaleString()} / ${checked.toLocaleString()}  (${(100 * olsRate).toFixed(2)}%)`,
);

// A handful of disagreements are tolerable — one solve in the corpus genuinely disagrees — but a
// systematic break means the published windows no longer mean what this script thinks.
const MIN_AGREEMENT = 0.99;
if (checked < 1000 || crossRate < MIN_AGREEMENT || olsRate < MIN_AGREEMENT) {
  console.error(
    `\nthe published windows no longer decompose as expected ` +
      `(need ${(100 * MIN_AGREEMENT).toFixed(0)}% over at least 1,000 solves).\n` +
      `every time baseline below is derived from that decomposition, so this is fatal.`,
  );
  process.exit(1);
}

// -------------------------------------------------------------------------------------------
// 2. Decomposed per-window times, for the modern era.
// -------------------------------------------------------------------------------------------

interface WindowSample {
  seconds: number;
  turns: number;
}

const samples = new Map<TimeWindow, WindowSample[]>();
const push = (window: TimeWindow, seconds: number, turns: number): void => {
  // A window with no turns has no rate, and a non-positive time is a bad reconstruction.
  if (!Number.isFinite(seconds) || seconds <= 0 || turns <= 0) return;
  const list = samples.get(window) ?? [];
  list.push({ seconds, turns });
  samples.set(window, list);
};

for (const record of records) {
  if (record.quality !== "clean") continue;
  if (Number.parseInt(record.date.slice(0, 4), 10) < TIME_ERA_FROM) continue;
  const s = record.stats;
  const need = ["Total", "F2L", "LL", "Cross+1", "OLS", "PLL"];
  if (need.some((key) => s[key]?.time == null || s[key]?.stm == null)) continue;

  const crossPlusOne = { seconds: s["Cross+1"]!.time!, turns: s["Cross+1"]!.stm! };
  const oll = { seconds: s.LL!.time! - s.PLL!.time!, turns: s.LL!.stm! - s.PLL!.stm! };
  const pair4 = { seconds: s.OLS!.time! - oll.seconds, turns: s.OLS!.stm! - oll.turns };
  const pairs23 = {
    seconds: s.F2L!.time! - crossPlusOne.seconds - pair4.seconds,
    turns: s.F2L!.stm! - crossPlusOne.turns - pair4.turns,
  };

  push(TimeWindow.CrossPlusOne, crossPlusOne.seconds, crossPlusOne.turns);
  push(TimeWindow.Pairs23, pairs23.seconds, pairs23.turns);
  push(TimeWindow.Pair4, pair4.seconds, pair4.turns);
  push(TimeWindow.OLL, oll.seconds, oll.turns);
  push(TimeWindow.PLL, s.PLL!.time!, s.PLL!.stm!);
  push(TimeWindow.F2L, s.F2L!.time!, s.F2L!.stm!);
  push(TimeWindow.LastLayer, s.LL!.time!, s.LL!.stm!);
  push(TimeWindow.Total, s.Total!.time!, s.Total!.stm!);
}

// -------------------------------------------------------------------------------------------
// 3. The timer-overhead estimate.
// -------------------------------------------------------------------------------------------

/**
 * Ordinary least squares of `seconds` on `turns`, with the intercept's standard error.
 *
 * Fitted on the middle 98% by duration. A least-squares intercept is an extrapolation to zero
 * moves and badly outlier-sensitive, and the tail here is not technique — it is pops, misgrips
 * and disasters. Leaving them in moved the PLL estimate by 0.09 s, which is a quarter of the
 * quantity being estimated.
 */
function fit(unclipped: readonly WindowSample[]): {
  n: number;
  intercept: number;
  interceptStdError: number;
  secondsPerTurn: number;
} {
  const bySeconds = unclipped.map((s) => s.seconds).sort((a, b) => a - b);
  const low = percentile(bySeconds, 0.01);
  const high = percentile(bySeconds, 0.99);
  const sample = unclipped.filter((s) => s.seconds >= low && s.seconds <= high);

  const n = sample.length;
  const meanX = sample.reduce((a, s) => a + s.turns, 0) / n;
  const meanY = sample.reduce((a, s) => a + s.seconds, 0) / n;
  let sxx = 0;
  let sxy = 0;
  for (const s of sample) {
    sxx += (s.turns - meanX) ** 2;
    sxy += (s.turns - meanX) * (s.seconds - meanY);
  }
  const slope = sxy / sxx;
  const intercept = meanY - slope * meanX;
  const residual = sample.reduce(
    (a, s) => a + (s.seconds - (intercept + slope * s.turns)) ** 2,
    0,
  );
  const sigma = Math.sqrt(residual / (n - 2));
  return {
    n,
    intercept,
    interceptStdError: sigma * Math.sqrt(1 / n + (meanX * meanX) / sxx),
    secondsPerTurn: slope,
  };
}

/** The windows that do not touch the timer, and so measure recognition alone. */
const CLEAN_WINDOWS: readonly TimeWindow[] = [
  TimeWindow.Pairs23,
  TimeWindow.Pair4,
  TimeWindow.OLL,
];
const FITTED_WINDOWS: readonly TimeWindow[] = [TimeWindow.CrossPlusOne, ...CLEAN_WINDOWS, TimeWindow.PLL];

const fits = FITTED_WINDOWS.map((window) => {
  return {
    window,
    ...fit(samples.get(window) ?? []),
    clean: CLEAN_WINDOWS.includes(window),
  };
});

const cleanIntercept =
  fits.filter((f) => f.clean).reduce((a, f) => a + f.intercept, 0) /
  fits.filter((f) => f.clean).length;

const overheadOf = (window: TimeWindow): number => {
  const found = fits.find((f) => f.window === window)!;
  // Never negative: a window that fits *below* the clean baseline is noise, not a cube that
  // rewinds time, and subtracting a negative would inflate the pro distribution.
  return Math.max(0, found.intercept - cleanIntercept);
};

const crossPlusOneOverhead = overheadOf(TimeWindow.CrossPlusOne);
const pllOverhead = overheadOf(TimeWindow.PLL);

console.log("\n=== TIMER OVERHEAD ===\n");
console.log(`  ${"window".padEnd(11)} ${"n".padStart(6)} ${"intercept".padStart(10)} ${"±se".padStart(6)} ${"s/turn".padStart(7)}`);
for (const f of fits) {
  console.log(
    `  ${f.window.padEnd(11)} ${f.n.toLocaleString().padStart(6)} ` +
      `${f.intercept.toFixed(3).padStart(10)} ${f.interceptStdError.toFixed(3).padStart(6)} ` +
      `${f.secondsPerTurn.toFixed(3).padStart(7)}${f.clean ? "" : "   <- touches the timer"}`,
  );
}
console.log(`\n  clean-window mean intercept (recognition only): ${cleanIntercept.toFixed(3)} s`);
console.log(`  grab, removed from cross+1: ${crossPlusOneOverhead.toFixed(3)} s`);
console.log(`  drop, removed from PLL:     ${pllOverhead.toFixed(3)} s`);

/** How much dead time to strip from each window before taking its distribution. */
const CORRECTION: Partial<Record<TimeWindow, number>> = {
  [TimeWindow.CrossPlusOne]: crossPlusOneOverhead,
  [TimeWindow.PLL]: pllOverhead,
  // Composite windows inherit the overhead of whichever ends they contain.
  [TimeWindow.F2L]: crossPlusOneOverhead,
  [TimeWindow.LastLayer]: pllOverhead,
  [TimeWindow.Total]: crossPlusOneOverhead + pllOverhead,
};

// -------------------------------------------------------------------------------------------
// 4. Distributions.
// -------------------------------------------------------------------------------------------

function distribution(values: readonly number[]): Distribution {
  const sorted = [...values].sort((a, b) => a - b);
  return {
    n: sorted.length,
    mean: sorted.reduce((a, b) => a + b, 0) / sorted.length,
    min: sorted[0]!,
    p10: percentile(sorted, 0.1),
    p25: percentile(sorted, 0.25),
    median: percentile(sorted, 0.5),
    p75: percentile(sorted, 0.75),
    p90: percentile(sorted, 0.9),
    max: sorted[sorted.length - 1]!,
  };
}

const times = FITTED_WINDOWS.concat([
  TimeWindow.F2L,
  TimeWindow.LastLayer,
  TimeWindow.Total,
]).map((window) => {
  const correction = CORRECTION[window] ?? 0;
  const sample = (samples.get(window) ?? [])
    .map((s) => ({ ...s, seconds: s.seconds - correction }))
    // A correction can push a very fast window non-positive; those samples cannot be rated.
    .filter((s) => s.seconds > 0);
  return {
    window,
    seconds: distribution(sample.map((s) => s.seconds)),
    tps: distribution(sample.map((s) => s.turns / s.seconds)),
    overheadCorrectionSeconds: correction,
  };
});

// Turn counts use every era: they drift far less, and the extra decade is free sample size.
const turnSamples = new Map<string, { turns: number[]; rotations: number[] }>();
const addTurns = (key: string, turns: number, rotations: number | null): void => {
  const entry = turnSamples.get(key) ?? { turns: [], rotations: [] };
  entry.turns.push(turns);
  if (rotations !== null) entry.rotations.push(rotations);
  turnSamples.set(key, entry);
};

let turnSolves = 0;
for (const record of records) {
  if (record.quality !== "clean") continue;
  const totals = phaseTotals(record);
  if (!REQUIRED_PHASES.every((phase) => totals.has(phase))) continue;
  turnSolves++;

  for (const phase of REQUIRED_PHASES) {
    const entry = totals.get(phase)!;
    addTurns(phase, entry.turns, entry.rotations);
  }
  const sum = (phases: readonly string[], pick: "turns" | "rotations") =>
    phases.reduce((a, p) => a + totals.get(p)![pick], 0);

  addTurns("cross+1", sum(["cross", "f2l1"], "turns"), sum(["cross", "f2l1"], "rotations"));
  const f2l = ["cross", "f2l1", "f2l2", "f2l3", "f2l4"];
  addTurns("f2l", sum(f2l, "turns"), sum(f2l, "rotations"));
  addTurns("last-layer", sum(["oll", "pll"], "turns"), sum(["oll", "pll"], "rotations"));
  addTurns("total", record.totalTurns, record.totalRotations);
}

const turns = [...turnSamples].map(([key, entry]) => ({
  key,
  turns: distribution(entry.turns),
  rotations: entry.rotations.length > 0 ? distribution(entry.rotations) : null,
}));

console.log(`\n=== BASELINES ===\n`);
console.log(`  turn distributions from ${turnSolves.toLocaleString()} clean solves, all eras`);
console.log(
  `  time distributions from ${(samples.get(TimeWindow.Total) ?? []).length.toLocaleString()} clean solves, ${TIME_ERA_FROM}+`,
);
for (const time of times) {
  console.log(
    `    ${time.window.padEnd(11)} median ${time.seconds.median.toFixed(2).padStart(5)} s   ` +
      `${time.tps.median.toFixed(2).padStart(5)} tps` +
      (time.overheadCorrectionSeconds > 0
        ? `   (−${time.overheadCorrectionSeconds.toFixed(2)} s corrected)`
        : ""),
  );
}

// -------------------------------------------------------------------------------------------
// 5. Emit.
// -------------------------------------------------------------------------------------------

const round = (value: number, places = 4): number => Number(value.toFixed(places));
const roundDistribution = (d: Distribution): Distribution => ({
  n: d.n,
  mean: round(d.mean),
  min: round(d.min),
  p10: round(d.p10),
  p25: round(d.p25),
  median: round(d.median),
  p75: round(d.p75),
  p90: round(d.p90),
  max: round(d.max),
});

const payload = {
  generatedAt: new Date().toISOString().slice(0, 10),
  corpusSolves: records.length,
  timedSolves: (samples.get(TimeWindow.Total) ?? []).length,
  timeEraFrom: TIME_ERA_FROM,
  turns: turns.map((t) => ({
    key: t.key,
    turns: roundDistribution(t.turns),
    rotations: t.rotations ? roundDistribution(t.rotations) : null,
  })),
  times: times.map((t) => ({
    window: t.window,
    seconds: roundDistribution(t.seconds),
    tps: roundDistribution(t.tps),
    overheadCorrectionSeconds: round(t.overheadCorrectionSeconds, 3),
  })),
  timerOverhead: {
    crossPlusOneSeconds: round(crossPlusOneOverhead, 3),
    pllSeconds: round(pllOverhead, 3),
    fits: fits.map((f) => ({
      window: f.window,
      n: f.n,
      intercept: round(f.intercept, 3),
      interceptStdError: round(f.interceptStdError, 3),
      secondsPerTurn: round(f.secondsPerTurn, 4),
      clean: f.clean,
    })),
  },
};

const source = `// GENERATED FILE — do not edit by hand.
// Regenerate with: npm run generate -w @cubing-companion/metrics
// Source: B1's reco.nz corpus (see scripts/generate-baselines.ts).
//
// Turn counts: ${turnSolves.toLocaleString()} clean solves, all eras.
// Times: ${payload.timedSolves.toLocaleString()} clean solves from ${TIME_ERA_FROM} onwards, because times
// drift ~35% across the corpus's span while move counts drift ~9%.
//
// The cross+1 and PLL time distributions have stackmat dead time subtracted; see \`TimerOverhead\`
// in ./baselines.ts for how it is estimated and how far to trust it.

import type { Baselines } from "./baselines.ts";

export const BASELINES: Baselines = ${JSON.stringify(payload, null, 2)};
`;

writeFileSync(OUTPUT, source);
console.log(`\nwrote ${OUTPUT}`);
