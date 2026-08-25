/**
 * Check the cross solver against 9,865 real solves.
 *
 * The strongest available test, and the one B1 exists to make possible. The claim is falsifiable
 * in a single line: **no human cross can be shorter than the computed optimum.** One
 * counter-example and the solver is wrong.
 *
 * The by-product is the first genuinely interesting output of this track — how far from optimal
 * the world's best actually build their crosses, which is what A3 will score against and what
 * B3 will learn to predict.
 *
 * Run: npm run corpus-check -w @cubing-companion/solver
 */
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
  applyMoves,
  CubeState,
  parseMoves,
  serializeMoves,
  type Move,
} from "@cubing-companion/engine";
import {
  GEOMETRY,
  isSlotSolved,
  Phase,
  segmentSolve,
  slotName,
  type Slot,
} from "@cubing-companion/analysis";
import { normalizeOrientation } from "@cubing-companion/engine";
import { crossDistance } from "../src/crossTable.ts";
import { enumerateF2LInsertion } from "../src/f2l.ts";

const CORPUS = fileURLToPath(new URL("../../../data/corpus.jsonl", import.meta.url));
if (!existsSync(CORPUS)) {
  console.error(
    `no corpus at ${CORPUS}\nbuild it: npm run build-corpus -w @cubing-companion/corpus`,
  );
  process.exit(1);
}

const APOSTROPHE = String.fromCharCode(39);
const parseLenient = (text: string): Move[] => {
  try {
    return parseMoves(text);
  } catch {
    return parseMoves(text.split(APOSTROPHE).join(`${APOSTROPHE} `));
  }
};

interface CorpusRecord {
  id: number;
  solver: string;
  scramble: string;
  solution: string;
  quality: string;
}

const records: CorpusRecord[] = readFileSync(CORPUS, "utf8")
  .trim()
  .split("\n")
  .map((line) => JSON.parse(line) as CorpusRecord);

console.log(`checking the cross solver against ${records.length} solves\n`);

const SLICE_FAMILIES = new Set(["M", "E", "S"]);

let checked = 0;
let sliceCrosses = 0;
let impossible = 0;
const excess: number[] = [];
const rotationsUsed: number[] = [];
const violations: string[] = [];
const startedAt = Date.now();

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

  const cross = segmentation.spans.find((s) => s.phase === Phase.Cross);
  if (!cross) continue;
  // A pseudo-cross ends deliberately offset, so its move count is not comparable with an
  // optimum measured to a finished cross.
  if (segmentation.pseudoCross) continue;

  // A slice move counts as one turn for a human but needs two face turns in HTM, so a cross
  // built with one can legitimately come out "shorter" than an HTM optimum. That is a metric
  // mismatch, not a solver error, and comparing them would be comparing different questions.
  // Rare enough not to matter: 1.5% of crosses. Wide moves need no such exclusion — they are
  // used in 42% of crosses and never beat the optimum, exactly as the move-set measurement
  // predicted.
  if ([...cross.moves].some((m) => SLICE_FAMILIES.has(m.family))) {
    sliceCrosses++;
    continue;
  }

  const start = applyMoves(CubeState.solved(), scramble);
  const optimal = crossDistance(start, segmentation.crossFace);

  // The human's count in the same metric the solver uses: turns only, rotations excluded,
  // since a rotation is free in HTM.
  const humanTurns = cross.turns;
  checked++;

  if (humanTurns < optimal) {
    impossible++;
    if (violations.length < 5) {
      violations.push(
        `  solve ${record.id} (${record.solver}): human ${humanTurns} turns, ` +
          `solver says ${optimal} is optimal — [${serializeMoves([...cross.moves])}]`,
      );
    }
  }
  excess.push(humanTurns - optimal);
  rotationsUsed.push(cross.rotations);
}

const elapsed = Date.now() - startedAt;

console.log(`crosses compared: ${checked.toLocaleString()}  (${elapsed} ms)`);
console.log(
  `  excluded for using a slice move: ${sliceCrosses} — one human turn, two in HTM`,
);
console.log(
  `\n*** shorter than the computed optimum: ${impossible} ***` +
    (impossible === 0
      ? "  — as it must be; a single one would mean the solver is wrong"
      : "  <-- THE SOLVER IS WRONG"),
);
if (violations.length > 0) console.log(violations.join("\n"));

const histogram = new Map<number, number>();
for (const value of excess) histogram.set(value, (histogram.get(value) ?? 0) + 1);
const mean = excess.reduce((a, b) => a + b, 0) / excess.length;
const optimalCount = histogram.get(0) ?? 0;

console.log(`\n=== HOW FAR FROM OPTIMAL THE PROS BUILD THEIR CROSSES ===\n`);
console.log(`  mean excess: ${mean.toFixed(2)} moves`);
console.log(
  `  built optimally: ${optimalCount.toLocaleString()} (${((100 * optimalCount) / excess.length).toFixed(1)}%)`,
);
for (const [value, count] of [...histogram].sort((a, b) => a[0] - b[0]).slice(0, 12)) {
  const bar = "#".repeat(Math.round((60 * count) / excess.length));
  console.log(
    `  +${String(value).padEnd(2)} ${String(count).padStart(5)} ` +
      `${`${((100 * count) / excess.length).toFixed(1)}%`.padStart(6)} ${bar}`,
  );
}

const meanRotations =
  rotationsUsed.reduce((a, b) => a + b, 0) / Math.max(rotationsUsed.length, 1);
console.log(
  `\n  rotations per cross: ${meanRotations.toFixed(2)} mean — a cost the solver's HTM count does not charge for`,
);

// ---------------------------------------------------------------------------------------------
// F2L insertions. Same falsifiable claim, one level deeper: a pro's own pair cannot be shorter
// than the optimum for the position they were actually in, preserving what they had already
// built.
// ---------------------------------------------------------------------------------------------

const F2L_PHASES = [Phase.F2L1, Phase.F2L2, Phase.F2L3, Phase.F2L4] as const;
const SAMPLE = 400; // a full sweep is four searches per solve; a sample says the same thing

let pairsChecked = 0;
let pairsImpossible = 0;
let pairsSkipped = 0;
let pairsPseudoslotted = 0;
const pairExcess: number[] = [];
const pairViolations: string[] = [];
const pairStart = Date.now();

for (const record of records.slice(0, SAMPLE)) {
  let scramble: Move[];
  let solution: Move[];
  try {
    scramble = parseLenient(record.scramble);
    solution = parseLenient(record.solution);
  } catch {
    continue;
  }
  const { segmentation } = segmentSolve(scramble, solution);
  if (!segmentation || segmentation.pseudoCross) continue;

  const geometry = GEOMETRY[segmentation.crossFace]!;
  const byName = new Map<string, Slot>(
    geometry.slots.map((slot) => [slotName(slot), slot]),
  );

  for (const phase of F2L_PHASES) {
    const span = segmentation.spans.find((s) => s.phase === phase);
    if (!span?.slot) continue;
    const target = byName.get(span.slot);
    if (!target) continue;

    // Slices are one turn to a human and two in HTM, so those spans are not comparable. Wide
    // moves are left in: `Lw` is `R` with an `x` rotation, rotations are free in HTM, so a wide
    // move is fairly charged as the one turn the human paid for.
    if ([...span.moves].some((m) => SLICE_FAMILIES.has(m.family))) {
      pairsSkipped++;
      continue;
    }

    // The positions either side of the pair they actually built.
    const before = normalizeOrientation(
      applyMoves(applyMoves(CubeState.solved(), scramble), solution.slice(0, span.start)),
    );
    const after = normalizeOrientation(
      applyMoves(applyMoves(CubeState.solved(), scramble), solution.slice(0, span.end)),
    );

    // A **pseudoslot**: the pair goes in against a cross that is offset by a D turn, correct as
    // a block but not aligned to the centres, and the realignment gets paid later or folded into
    // the next pair. The segmenter credits it, because it aligns the cross before testing slots.
    // The solver does not, because it is asked for a position that is finished. They are not the
    // same goal, so the two lengths are not comparable and the span is set aside rather than
    // counted as a solver that came up short.
    if (
      crossDistance(before, segmentation.crossFace) !== 0 ||
      crossDistance(after, segmentation.crossFace) !== 0
    ) {
      pairsPseudoslotted++;
      continue;
    }
    if (isSlotSolved(before, target)) continue;

    const { optimal } = enumerateF2LInsertion(
      before,
      segmentation.crossFace,
      target,
      { maxSolutions: 1 },
    );
    if (optimal === -1) continue;

    pairsChecked++;
    if (span.turns < optimal) {
      pairsImpossible++;
      if (pairViolations.length < 5) {
        pairViolations.push(
          `  solve ${record.id} ${phase}: human ${span.turns}, solver says ${optimal} — ` +
            `[${serializeMoves([...span.moves])}]`,
        );
      }
    }
    pairExcess.push(span.turns - optimal);
  }
}

console.log(`\n=== F2L INSERTIONS ===\n`);
console.log(
  `  pairs compared: ${pairsChecked.toLocaleString()} from ${SAMPLE} solves ` +
    `(${Date.now() - pairStart} ms, ${pairsSkipped} skipped for slice moves, ` +
    `${pairsPseudoslotted} for pseudoslots)`,
);
console.log(
  `\n*** shorter than the computed optimum: ${pairsImpossible} ***` +
    (pairsImpossible === 0 ? "  — as it must be" : "  <-- THE SOLVER IS WRONG"),
);
if (pairViolations.length > 0) console.log(pairViolations.join("\n"));

if (pairExcess.length > 0) {
  const pairHistogram = new Map<number, number>();
  for (const value of pairExcess) {
    pairHistogram.set(value, (pairHistogram.get(value) ?? 0) + 1);
  }
  const pairMean = pairExcess.reduce((a, b) => a + b, 0) / pairExcess.length;
  const pairOptimal = pairHistogram.get(0) ?? 0;
  console.log(`\n  mean excess: ${pairMean.toFixed(2)} moves`);
  console.log(
    `  inserted optimally: ${pairOptimal.toLocaleString()} (${((100 * pairOptimal) / pairExcess.length).toFixed(1)}%)`,
  );
  for (const [value, count] of [...pairHistogram].sort((a, b) => a[0] - b[0]).slice(0, 10)) {
    const bar = "#".repeat(Math.round((60 * count) / pairExcess.length));
    console.log(
      `  +${String(value).padEnd(2)} ${String(count).padStart(5)} ` +
        `${`${((100 * count) / pairExcess.length).toFixed(1)}%`.padStart(6)} ${bar}`,
    );
  }
}
