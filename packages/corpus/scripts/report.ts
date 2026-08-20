/**
 * Print the corpus EDA — the distributions A3 will score against.
 *
 * Usage: npm run report -w @cubing-companion/corpus
 */
import { readFile } from "node:fs/promises";
import type { CorpusSummary, Distribution } from "../src/stats.ts";
import { SUMMARY_PATH } from "../src/paths.ts";

const summary: CorpusSummary = JSON.parse(await readFile(SUMMARY_PATH, "utf8"));

const n = (value: number, places = 1) =>
  Number.isFinite(value) ? value.toFixed(places) : "-";

function row(label: string, dist: Distribution | null | undefined): string {
  if (!dist) return `  ${label.padEnd(14)}  ${"(no data)".padStart(7)}`;
  return (
    `  ${label.padEnd(14)}  ${String(dist.n).padStart(5)}  ` +
    [dist.p10, dist.p25, dist.median, dist.p75, dist.p90]
      .map((v) => n(v).padStart(6))
      .join("") +
    `  ${n(dist.mean).padStart(6)}`
  );
}

const header =
  `  ${"".padEnd(14)}  ${"n".padStart(5)}  ` +
  ["p10", "p25", "p50", "p75", "p90"].map((h) => h.padStart(6)).join("") +
  `  ${"mean".padStart(6)}`;

console.log(`\n=== CORPUS ===\n`);
console.log(`solves:      ${summary.totalSolves}`);
console.log(`method:      ${JSON.stringify(summary.byMethod)}`);
console.log(`quality:     ${JSON.stringify(summary.byQuality)}`);
console.log(`xcross rate: ${(summary.xcrossRate * 100).toFixed(1)}%`);

console.log(`\n=== MOVE COUNT BY PHASE (clean solves only) ===\n`);
console.log(header);
for (const phase of summary.phases) {
  if (!phase.turns) continue;
  console.log(row(phase.phase, phase.turns));
}

console.log(`\n=== MOVE COUNT BY GROUP (all annotation styles) ===\n`);
console.log(header);
for (const [name, dist] of Object.entries(summary.groups)) {
  console.log(row(name, dist));
}

console.log(`\n=== WHOLE SOLVE ===\n`);
console.log(header);
console.log(row("turns", summary.solveTurns));
console.log(row("rotations", summary.solveRotations));
console.log(row("seconds", summary.solveSeconds));

if (Object.keys(summary.publishedTiming).length > 0) {
  console.log(`\n=== PUBLISHED TIMING, SECONDS (reco.nz stats table) ===\n`);
  console.log(header);
  for (const [group, dist] of Object.entries(summary.publishedTiming)) {
    console.log(row(group, dist));
  }
  console.log(
    `\n  NOTE: these are stackmat-timed. reco.nz removed its smartcube reconstructions\n` +
      `  because smartcube times differ too heavily from keyboard/stackmat times, so\n` +
      `  TPS and duration percentiles do not transfer to a smart-cube user unchanged.\n` +
      `  Move counts above are unaffected.`,
  );
}

if (summary.unknownLabels.length > 0) {
  console.log(`\n=== UNRECOGNIZED LABELS (${summary.unknownLabels.length} distinct) ===\n`);
  for (const [label, count] of summary.unknownLabels.slice(0, 25)) {
    console.log(`  ${String(count).padStart(5)}  ${label}`);
  }
}
console.log();
