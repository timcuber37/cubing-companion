/**
 * Corpus → training data for B3.
 *
 * Run: npm run build-dataset -w @cubing-companion/planner -- [limit]
 *
 * Emits one JSON object per *decision*, each carrying the feature vectors of every option and the
 * index of the one the pro took. Features come from `../src/features.ts`, the same code the
 * browser runs, so Python never computes a feature and the two can never drift.
 *
 * ## Labelling a cross choice
 *
 * The pro's cross is written in their own frame and may use wide moves, slices and rotations,
 * none of which the search emits — so the sequences cannot be compared as text. Rather than
 * unpicking the notation, this matches on **the position each one reaches**: two different
 * optimal cross solutions leave the cube in different states, so a candidate whose resulting
 * position equals the pro's (up to orientation, since rotations do not change it) *is* the
 * solution they used. Notation problems disappear because notation is never compared.
 */
import { appendFileSync, readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
  applyMoves,
  CubeState,
  normalizeOrientation,
  parseMoves,
  type Face,
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
import { crossDistance, enumerateCross, enumerateF2LInsertion } from "@cubing-companion/solver";
import { crossFeatures, pairFeatures } from "../src/features.ts";
import { ORIENTATIONS, orientationsWithColourDown, renameMoves } from "../src/orientation.ts";

const CORPUS = fileURLToPath(new URL("../../../data/corpus.jsonl", import.meta.url));
const OUT = fileURLToPath(new URL("../../../data/decisions.jsonl", import.meta.url));

const APOSTROPHE = String.fromCharCode(39);
const lenient = (text: string): Move[] => {
  try {
    return parseMoves(text);
  } catch {
    return parseMoves(text.split(APOSTROPHE).join(`${APOSTROPHE} `));
  }
};

const F2L_PHASES = [Phase.F2L1, Phase.F2L2, Phase.F2L3, Phase.F2L4];
/** Enough to make `logWays` informative without paying for an exhaustive sweep every decision. */
const WAYS_CAP = 60;

interface Record {
  id: number;
  solver: string;
  date: string;
  quality: string;
  scramble: string;
  solution: string;
}

const limit = Number(process.argv[2] ?? Number.POSITIVE_INFINITY);
const records: Record[] = readFileSync(CORPUS, "utf8")
  .trim()
  .split("\n")
  .map((line) => JSON.parse(line) as Record)
  .slice(0, Number.isFinite(limit) ? limit : undefined);

writeFileSync(OUT, "");
console.log(`building from ${records.length.toLocaleString()} solves -> ${OUT}\n`);

let pairGroups = 0;
let crossGroups = 0;
let crossAttempted = 0;
let crossNotOptimal = 0;
let crossUnmatched = 0;
let crossOffFrame = 0;
let buffer: string[] = [];
const startedAt = Date.now();

const flush = () => {
  if (buffer.length > 0) appendFileSync(OUT, `${buffer.join("\n")}\n`);
  buffer = [];
};

for (const [index, record] of records.entries()) {
  if (record.quality !== "clean") continue;

  let scramble: Move[];
  let solution: Move[];
  try {
    scramble = lenient(record.scramble);
    solution = lenient(record.solution);
  } catch {
    continue;
  }

  const { segmentation } = segmentSolve(scramble, solution);
  if (!segmentation || segmentation.pseudoCross) continue;

  const crossFace = segmentation.crossFace;
  const geometry = GEOMETRY[crossFace]!;
  const bySlotName = new Map<string, Slot>(geometry.slots.map((s) => [slotName(s), s]));
  const scrambled = applyMoves(CubeState.solved(), scramble);
  const meta = { id: record.id, solver: record.solver, date: record.date };

  // ---------------------------------------------------------------------------------------
  // The cross: which solution, held which way.
  // ---------------------------------------------------------------------------------------
  const crossSpan = segmentation.spans.find((s) => s.phase === Phase.Cross);
  if (crossSpan && crossSpan.end > crossSpan.start) {
    crossAttempted++;
    const normalised = normalizeOrientation(scrambled);
    const search = enumerateCross(normalised, crossFace, { maxSolutions: 400 });

    const reached = normalizeOrientation(
      applyMoves(scrambled, solution.slice(0, crossSpan.end)),
    );
    const matched = search.candidates.findIndex((candidate) =>
      normalizeOrientation(applyMoves(normalised, candidate.moves)).equals(reached),
    );

    if (matched === -1) {
      // Either they took a longer route than the optimum, or a route the search cannot express.
      if (crossSpan.turns > search.optimal) crossNotOptimal++;
      else crossUnmatched++;
    } else {
      // How were they holding it? Read the centres at the moment of the first real turn — the
      // rotations before it are the inspection rotation, which is precisely the grip decision.
      let firstTurn = crossSpan.start;
      while (
        firstTurn < crossSpan.end &&
        "xyz".includes(solution[firstTurn]!.family)
      ) {
        firstTurn++;
      }
      const held = applyMoves(scrambled, solution.slice(0, firstTurn)).centers.join(",");
      const frames = orientationsWithColourDown(crossFace);
      const frameIndex = frames.findIndex(
        (orientation) => orientation.colourAt.join(",") === held,
      );

      if (frameIndex === -1) {
        // They held the cross colour somewhere other than the bottom during the cross.
        crossOffFrame++;
      } else {
        const options: number[][] = [];
        let chosen = -1;
        for (const [c, candidate] of search.candidates.entries()) {
          for (const [f, frame] of frames.entries()) {
            if (c === matched && f === frameIndex) chosen = options.length;
            options.push(crossFeatures(renameMoves(candidate.moves, frame)));
          }
        }
        if (chosen >= 0 && options.length > 1) {
          buffer.push(JSON.stringify({ kind: "cross", ...meta, chosen, options }));
          crossGroups++;
        }
      }
    }
  }

  // ---------------------------------------------------------------------------------------
  // Pair order: which slot next. The fourth pair is forced, so it is not a decision.
  // ---------------------------------------------------------------------------------------
  const spans = F2L_PHASES.map((phase) =>
    segmentation.spans.find((s) => s.phase === phase),
  );
  if (spans.every((span) => span?.slot)) {
    for (let step = 0; step < 3; step++) {
      const span = spans[step]!;
      const before = normalizeOrientation(
        applyMoves(scrambled, solution.slice(0, span.start)),
      );
      if (crossDistance(before, crossFace) !== 0) break;

      const open = geometry.slots.filter((slot) => !isSlotSolved(before, slot));
      if (open.length !== 4 - step) break;
      const chosenSlot = bySlotName.get(span.slot!);
      if (!chosenSlot || !open.includes(chosenSlot)) break;

      const searched = open.map((slot) => {
        const result = enumerateF2LInsertion(before, crossFace, slot, {
          maxSolutions: WAYS_CAP,
        });
        return {
          slot,
          optimal: result.optimal,
          ways: result.candidates.length,
          bestMoves: result.candidates[0]?.moves ?? [],
        };
      });
      if (searched.some((option) => option.optimal < 0)) break;

      const bestLength = Math.min(...searched.map((option) => option.optimal));
      const previous = step > 0 ? (bySlotName.get(spans[step - 1]!.slot!) ?? null) : null;
      const options = searched.map((candidate) =>
        pairFeatures(before, geometry, candidate, {
          bestLength,
          previous,
          step,
          openCount: open.length,
        }),
      );
      const chosen = searched.findIndex((option) => option.slot === chosenSlot);

      buffer.push(
        JSON.stringify({
          kind: "pair",
          ...meta,
          step,
          chosen,
          options,
          // Kept for the eval so the baseline can be recomputed without re-deriving features.
          lengths: searched.map((option) => option.optimal),
        }),
      );
      pairGroups++;
    }
  }

  if (buffer.length >= 200) flush();
  if ((index + 1) % 250 === 0) {
    const rate = (index + 1) / ((Date.now() - startedAt) / 1000);
    const left = (records.length - index - 1) / rate;
    console.log(
      `  ${index + 1}/${records.length}  ${pairGroups.toLocaleString()} pair, ` +
        `${crossGroups.toLocaleString()} cross  (${rate.toFixed(1)}/s, ~${(left / 60).toFixed(0)} min left)`,
    );
  }
}
flush();

const pct = (n: number) => `${((100 * n) / Math.max(crossAttempted, 1)).toFixed(1)}%`;
console.log(`\n=== CROSS LABELLING ===\n`);
console.log(`  crosses attempted:        ${crossAttempted.toLocaleString()}`);
console.log(`  matched to a candidate:   ${crossGroups.toLocaleString()} (${pct(crossGroups)})`);
console.log(`  longer than optimal:      ${crossNotOptimal.toLocaleString()} (${pct(crossNotOptimal)})`);
console.log(`  optimal but not matched:  ${crossUnmatched.toLocaleString()} (${pct(crossUnmatched)})`);
console.log(`  cross colour not on D:    ${crossOffFrame.toLocaleString()} (${pct(crossOffFrame)})`);
console.log(`\n=== TOTALS ===\n`);
console.log(`  pair decisions:  ${pairGroups.toLocaleString()}`);
console.log(`  cross decisions: ${crossGroups.toLocaleString()}`);
console.log(`  ${((Date.now() - startedAt) / 60000).toFixed(1)} min`);
