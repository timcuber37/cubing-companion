/**
 * Score the segmenter against the corpus's human labels.
 *
 * B1's 9,865 solves carry the reconstructors' own `// phase` annotations, which makes them a
 * ground-truth set the segmenter can be measured against rather than the segmenter being its
 * own judge. That is the whole reason B1 was built before A2.
 *
 * **What counts as agreement.** Two boundaries can differ without either being wrong: a
 * reconstructor may attach a trailing rotation to the phase it follows, or fold the final AUF
 * into PLL rather than labelling it separately. So a difference is scored as *convention*
 * when the phase's own completion predicate holds at both boundaries — the moves in between
 * did not change whether the phase was done — and as a genuine difference otherwise.
 *
 * That test replaced an earlier one that pattern-matched the gap against move families, which
 * got the frame wrong: gaps are written in the solver's frame while the predicates live in the
 * normalised one, so a `U` AUF went unrecognised whenever the cross was not on D.
 *
 * Reads `data/corpus.jsonl` directly, so the analysis package keeps its single dependency on
 * the engine.
 *
 * Run: npm run evaluate -w @cubing-companion/analysis
 */
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
  applyMoves,
  CubeState,
  normalizeOrientation,
  parseMoves,
  serializeMoves,
  type Move,
} from "@cubing-companion/engine";
import { faceName, GEOMETRY, slotName, type CrossGeometry } from "../src/geometry.ts";
import {
  alignCross,
  crossOffset,
  isLastLayerOriented,
  isSlotSolved,
  isSolvedIgnoringAUF,
} from "../src/phases.ts";
import { segmentSolve } from "../src/segment.ts";
import { Phase, type SolveSegmentation } from "../src/types.ts";

const CORPUS = fileURLToPath(new URL("../../../data/corpus.jsonl", import.meta.url));
if (!existsSync(CORPUS)) {
  console.error(
    `no corpus at ${CORPUS}\nbuild it first: npm run build-corpus -w @cubing-companion/corpus`,
  );
  process.exit(1);
}

interface CorpusRecord {
  id: number;
  solver: string;
  scramble: string;
  solution: string;
  quality: string;
  segments: { rawLabel: string; phases: string[] }[];
}

/** The spacing repair the corpus applies, replicated so no record is silently skipped. */
const APOSTROPHE = String.fromCharCode(39);
function parseLenient(text: string): Move[] {
  try {
    return parseMoves(text);
  } catch {
    return parseMoves(text.split(APOSTROPHE).join(`${APOSTROPHE} `));
  }
}

/**
 * Cumulative move index at the end of each human-labelled phase.
 *
 * `record.segments` holds only the lines that produced moves, so it cannot be indexed by raw
 * line number — a comment-only line would shift every boundary after it.
 */
function humanBoundaries(record: CorpusRecord): Map<string, number> {
  const ends = new Map<string, number>();
  let seen = 0;
  let segmentIndex = 0;
  for (const line of record.solution.split("\n")) {
    const commentAt = line.indexOf("//");
    const moveText = (commentAt === -1 ? line : line.slice(0, commentAt)).trim();
    const label = commentAt === -1 ? "" : line.slice(commentAt + 2).trim();
    if (moveText === "" && label === "") continue;

    const moves = moveText === "" ? [] : parseLenient(moveText);
    if (moves.length === 0) continue;
    seen += moves.length;

    const segment = record.segments[segmentIndex++];
    if (!segment) continue;
    for (const phase of segment.phases) {
      if (!ends.has(phase)) ends.set(phase, seen);
    }
  }
  return ends;
}

/** Whether a phase is complete in a given state. */
function phaseComplete(
  phase: Phase,
  state: CubeState,
  geometry: CrossGeometry,
  segmentation: SolveSegmentation,
): boolean {
  switch (phase) {
    case Phase.Cross:
      return crossOffset(state, geometry) !== null;
    case Phase.F2L1:
    case Phase.F2L2:
    case Phase.F2L3:
    case Phase.F2L4: {
      const span = segmentation.spans.find((s) => s.phase === phase);
      const slot = geometry.slots.find((s) => slotName(s) === span?.slot);
      if (!slot) return false;
      const aligned = alignCross(state, geometry);
      return aligned !== null && isSlotSolved(aligned, slot);
    }
    case Phase.OLL:
      return isLastLayerOriented(state, geometry);
    case Phase.PLL:
      return isSolvedIgnoringAUF(state, geometry);
    default:
      return false;
  }
}

const records: CorpusRecord[] = readFileSync(CORPUS, "utf8")
  .trim()
  .split("\n")
  .map((line) => JSON.parse(line) as CorpusRecord);
const clean = records.filter((r) => r.quality === "clean");

console.log(
  `corpus: ${records.length} solves, ${clean.length} cleanly labelled\n\n` +
    `Boundary agreement is measured on the cleanly-labelled subset: a "merged" solve writes\n` +
    `several phases as one block and has no per-phase boundary to compare against. Note that\n` +
    `excludes every xcross solve by construction, since an xcross *is* a merged label — so\n` +
    `the descriptive statistics further down are gathered over all ${records.length}.\n`,
);

const COMPARABLE: readonly (readonly [Phase, string])[] = [
  [Phase.Cross, "cross"],
  [Phase.F2L1, "f2l1"],
  [Phase.F2L2, "f2l2"],
  [Phase.F2L3, "f2l3"],
  [Phase.F2L4, "f2l4"],
  [Phase.OLL, "oll"],
  [Phase.PLL, "pll"],
];

interface Tally {
  exact: number;
  convention: number;
  off: number;
}
const tallies = new Map<Phase, Tally>(
  COMPARABLE.map(([phase]) => [phase, { exact: 0, convention: 0, off: 0 }]),
);

let segmented = 0;
let failed = 0;
const failures = new Map<string, number>();
const worst = new Map<Phase, string[]>();

for (const record of clean) {
  let scramble: Move[];
  let solution: Move[];
  try {
    scramble = parseLenient(record.scramble);
    solution = parseLenient(record.solution);
  } catch {
    failed++;
    failures.set("unparseable", (failures.get("unparseable") ?? 0) + 1);
    continue;
  }

  const { segmentation, failure } = segmentSolve(scramble, solution);
  if (!segmentation) {
    failed++;
    failures.set(failure ?? "unknown", (failures.get(failure ?? "unknown") ?? 0) + 1);
    continue;
  }
  segmented++;

  const geometry = GEOMETRY[segmentation.crossFace]!;
  const scrambled = applyMoves(CubeState.solved(), scramble);
  const stateAt = (index: number): CubeState =>
    normalizeOrientation(applyMoves(scrambled, solution.slice(0, index)));

  const human = humanBoundaries(record);
  for (const [phase, corpusName] of COMPARABLE) {
    const expected = human.get(corpusName);
    const span = segmentation.spans.find((s) => s.phase === phase);
    if (expected === undefined || !span) continue;

    const tally = tallies.get(phase)!;
    if (span.end === expected) {
      tally.exact++;
      continue;
    }

    // Convention when the phase is equally complete at both boundaries: the moves between
    // them did not change whether it was done, so neither placement is wrong.
    const ours = phaseComplete(phase, stateAt(span.end), geometry, segmentation);
    const theirs = phaseComplete(phase, stateAt(expected), geometry, segmentation);
    if (ours && theirs) {
      tally.convention++;
      continue;
    }

    tally.off++;
    const bucket = worst.get(phase) ?? [];
    if (bucket.length < 4) {
      const [lo, hi] = span.end < expected ? [span.end, expected] : [expected, span.end];
      bucket.push(
        `    solve ${record.id} (${record.solver}): ours ${span.end}, human ${expected} ` +
          `[${serializeMoves(solution.slice(lo, hi))}]`,
      );
      worst.set(phase, bucket);
    }
  }
}

console.log(`segmented: ${segmented}   failed: ${failed}`);
for (const [reason, count] of [...failures].sort((a, b) => b[1] - a[1])) {
  console.log(`   ${reason}: ${count}`);
}

console.log(`\n=== BOUNDARY AGREEMENT WITH HUMAN LABELS ===\n`);
console.log(
  `  ${"phase".padEnd(7)} ${"n".padStart(6)} ${"exact".padStart(8)} ` +
    `${"convention".padStart(11)} ${"differs".padStart(8)} ${"agree".padStart(8)}`,
);
let totalExact = 0;
let totalConvention = 0;
let totalOff = 0;
for (const [phase] of COMPARABLE) {
  const t = tallies.get(phase)!;
  const n = t.exact + t.convention + t.off;
  if (n === 0) continue;
  console.log(
    `  ${phase.padEnd(7)} ${String(n).padStart(6)} ${String(t.exact).padStart(8)} ` +
      `${String(t.convention).padStart(11)} ${String(t.off).padStart(8)} ` +
      `${`${((100 * (t.exact + t.convention)) / n).toFixed(1)}%`.padStart(8)}`,
  );
  totalExact += t.exact;
  totalConvention += t.convention;
  totalOff += t.off;
}
const grand = totalExact + totalConvention + totalOff;
console.log(
  `\n  overall: ${(((totalExact + totalConvention) / grand) * 100).toFixed(2)}% agreement ` +
    `(${totalExact} exact, ${totalConvention} convention, ${totalOff} genuine differences)`,
);

// Descriptive statistics over the whole corpus, not only the cleanly-labelled subset.
const crossFaces = new Map<string, number>();
const skipTally = new Map<string, number>();
let allSegmented = 0;
let xcross = 0;
let pseudo = 0;
for (const record of records) {
  let scramble: Move[];
  let solution: Move[];
  try {
    scramble = parseLenient(record.scramble);
    solution = parseLenient(record.solution);
  } catch {
    continue;
  }
  const { segmentation } = segmentSolve(scramble, solution);
  if (!segmentation) continue;
  allSegmented++;
  const face = faceName(segmentation.crossFace);
  crossFaces.set(face, (crossFaces.get(face) ?? 0) + 1);
  if (segmentation.xcross) xcross++;
  if (segmentation.pseudoCross) pseudo++;
  for (const skip of segmentation.skips) {
    skipTally.set(skip, (skipTally.get(skip) ?? 0) + 1);
  }
}

console.log(`\n=== WHAT THE SEGMENTER FOUND (all ${allSegmented} segmented solves) ===\n`);
console.log(
  `  cross colour: ${[...crossFaces].sort((a, b) => b[1] - a[1]).map(([f, c]) => `${f}:${c}`).join("  ")}`,
);
console.log(`  xcross:       ${((100 * xcross) / allSegmented).toFixed(1)}%`);
console.log(`  pseudo-cross: ${pseudo} solves`);
console.log(
  `  skips:        ${[...skipTally].sort((a, b) => b[1] - a[1]).map(([p, c]) => `${p}:${c}`).join("  ") || "none"}`,
);

if (worst.size > 0) {
  console.log(`\n=== DISAGREEMENTS TO INSPECT ===`);
  for (const [phase, lines] of worst) {
    console.log(`\n  ${phase}:`);
    console.log(lines.join("\n"));
  }
}
