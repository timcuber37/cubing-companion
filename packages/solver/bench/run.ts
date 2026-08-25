/**
 * Timings, so a performance regression is visible rather than merely felt.
 *
 * Kept out of the test suite deliberately: timing assertions in CI are flaky on shared runners,
 * and a benchmark that fails at random gets muted, which is worse than not having one.
 *
 * Run: npm run bench -w @cubing-companion/solver
 */
import {
  applyMoves,
  CubeState,
  Face,
  parseMoves,
  type Move,
} from "@cubing-companion/engine";
import { GEOMETRY } from "@cubing-companion/analysis";
import { normalizeOrientation } from "@cubing-companion/engine";
import { crossTable } from "../src/crossTable.ts";
import { enumerateCross, solveCross } from "../src/cross.ts";
import { enumerateXcross } from "../src/xcross.ts";
import { enumerateF2LInsertion, enumerateNextPair } from "../src/f2l.ts";
import { pairTable } from "../src/pairTable.ts";

const SAMPLES = 40;

function summarise(label: string, timings: number[], extra = ""): void {
  const sorted = [...timings].sort((a, b) => a - b);
  const at = (p: number) => sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * p))]!;
  console.log(
    `  ${label.padEnd(34)} median ${at(0.5).toFixed(1).padStart(7)} ms   ` +
      `p90 ${at(0.9).toFixed(1).padStart(7)} ms   max ${at(1).toFixed(1).padStart(7)} ms${extra}`,
  );
}

console.log("\n=== TABLE BUILD ===\n");
// Face.B is used here because the tests may already have warmed the others; a cached table
// would report a build time of zero and hide a regression.
const buildStart = performance.now();
crossTable(Face.B);
console.log(
  `  first build (190,080 positions)   ${(performance.now() - buildStart).toFixed(1)} ms`,
);
const cachedStart = performance.now();
crossTable(Face.B);
console.log(`  cached                            ${(performance.now() - cachedStart).toFixed(3)} ms`);

// The same sample every run. A benchmark whose input is re-randomised each time cannot tell a
// regression from an unlucky draw — the last pair in particular has a long tail, and a single
// hard scramble moves the maximum by an order of magnitude.
let seed = 0x9e3779b9;
const nextRandom = (): number => {
  // xorshift32, so the sample is reproducible without pulling in a dependency.
  seed ^= seed << 13;
  seed ^= seed >>> 17;
  seed ^= seed << 5;
  return (seed >>> 0) / 0x100000000;
};
const FAMILIES = ["U", "D", "L", "R", "F", "B"] as const;
const AMOUNTS = [1, 2, -1] as const;
const seededScramble = (length: number): Move[] => {
  const moves: Move[] = [];
  let previous = "";
  while (moves.length < length) {
    const family = FAMILIES[Math.floor(nextRandom() * FAMILIES.length)]!;
    if (family === previous) continue;
    previous = family;
    moves.push({ family, amount: AMOUNTS[Math.floor(nextRandom() * AMOUNTS.length)]! });
  }
  return moves;
};

const states = Array.from({ length: SAMPLES }, () =>
  applyMoves(CubeState.solved(), seededScramble(25)),
);
// Warm the table for the colour under test so the first sample is not an outlier.
crossTable(Face.D);

console.log("\n=== CROSS ===\n");
for (const [label, options] of [
  ["optimal only", { maxSolutions: 1000 }],
  ["within +1", { maxExtra: 1, maxSolutions: 1000 }],
  ["within +2", { maxExtra: 2, maxSolutions: 1000 }],
] as const) {
  const timings: number[] = [];
  let candidates = 0;
  for (const state of states) {
    const start = performance.now();
    const result = enumerateCross(state, Face.D, options);
    timings.push(performance.now() - start);
    candidates += result.candidates.length;
  }
  summarise(label, timings, `   ${(candidates / SAMPLES).toFixed(0)} candidates avg`);
}

console.log("\n=== XCROSS ===\n");
const slot = GEOMETRY[Face.D]!.slots.find((s) => s.edge === 8)!;
for (const [label, options] of [
  ["first solution", { maxSolutions: 1 }],
  ["all optimal", { maxSolutions: 1000 }],
] as const) {
  const timings: number[] = [];
  let candidates = 0;
  let depth = 0;
  for (const state of states) {
    const start = performance.now();
    const result = enumerateXcross(state, Face.D, slot, options);
    timings.push(performance.now() - start);
    candidates += result.candidates.length;
    depth += result.optimal;
  }
  summarise(
    label,
    timings,
    `   ${(candidates / SAMPLES).toFixed(1)} candidates, depth ${(depth / SAMPLES).toFixed(1)} avg`,
  );
}

console.log("\n=== F2L INSERTION ===\n");

const pairStart = performance.now();
pairTable(slot);
console.log(
  `  pair table build (576 positions)  ${(performance.now() - pairStart).toFixed(2)} ms`,
);

// Insertions start from a solved cross, so the sample has to get there first.
const afterCross = states
  .map((state) => {
    const solution = solveCross(state, Face.D);
    return solution ? normalizeOrientation(applyMoves(state, solution)) : undefined;
  })
  .filter((state) => state !== undefined);

// First and fourth pair are the two ends of the difficulty range: the first has only the cross
// to protect, the fourth has the cross and three pairs, on a cube with far less freedom left.
for (const [which, label, options] of [
  [1, "pair 1, all optimal", { maxSolutions: 1000 }],
  [4, "pair 4, first solution", { maxSolutions: 1 }],
  [4, "pair 4, all optimal", { maxSolutions: 1000 }],
] as const) {
  const timings: number[] = [];
  let depth = 0;
  let candidates = 0;
  let solved = 0;

  for (const start of afterCross) {
    let state = start;
    let elapsed = 0;
    let last: ReturnType<typeof enumerateF2LInsertion> | undefined;

    // Walk up to the pair being measured, greedily taking the cheapest each time.
    for (let i = 0; i < which; i++) {
      const options = enumerateNextPair(state, Face.D, { maxSolutions: 1 });
      if (options.length === 0) break;
      const best = options[0]!;
      if (best.result.optimal === -1) break;
      if (i === which - 1) {
        // Time the real question, all candidates, on the position actually reached.
        const t = performance.now();
        last = enumerateF2LInsertion(state, Face.D, best.slot, options);
        elapsed = performance.now() - t;
      }
      state = applyMoves(state, best.result.candidates[0]!.moves);
    }

    if (!last) continue;
    timings.push(elapsed);
    depth += last.optimal;
    candidates += last.candidates.length;
    solved++;
  }

  summarise(
    label,
    timings,
    `   ${(candidates / solved).toFixed(1)} candidates, depth ${(depth / solved).toFixed(1)} avg`,
  );
}

// What a planner asks per position: every remaining slot costed at once.
const nextPairTimings: number[] = [];
for (const state of afterCross) {
  const start = performance.now();
  enumerateNextPair(state, Face.D, { maxSolutions: 1 });
  nextPairTimings.push(performance.now() - start);
}
summarise("all four slots costed", nextPairTimings, "   what a planner asks per position");

console.log("\n=== SANITY ===\n");
const check = applyMoves(CubeState.solved(), parseMoves("D2 F R2 U L B2 R F2 D L U2 B"));
const cross = enumerateCross(check, Face.D, { maxSolutions: 3 });
console.log(`  known scramble optimal cross: ${cross.optimal} moves, ${cross.candidates.length} shown`);
console.log();
