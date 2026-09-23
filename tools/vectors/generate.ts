/**
 * Writes the oracle.
 *
 * Run: npm run vectors
 *
 * The TypeScript implementation is the reference the Swift port is built against — see
 * `SWIFT_PLAN.md`. Rather than reimplementing 758 tests in a language the logic does not exist in
 * yet, this runs the existing implementation over a broad input space and records what it answers.
 * The Swift tests then assert against the recordings.
 *
 * That is the same move P2 made with the GAN protocol: keep the reference, diff against it
 * forever. The difference is that these are pure functions with no radio attached, so the
 * comparison can be exhaustive rather than opportunistic.
 *
 * Output is committed. It is data, it is reproducible from a seed, and a Swift project that cannot
 * run this repository's TypeScript still needs to be able to read it.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { GENERATORS } from "./cases.ts";

const OUT = fileURLToPath(new URL("../../vectors/", import.meta.url));

/**
 * Fixed per generator, so regenerating never churns the files.
 *
 * Counts are a balance: enough that a systematic error cannot hide, few enough that the corpus is
 * a reasonable thing to keep in a repository. The solver's are lower because each case runs a real
 * search rather than a table lookup.
 */
const JOBS: readonly { name: string; seed: number; count: number }[] = [
  { name: "engine", seed: 0x0e_11_11_e0, count: 3000 },
  { name: "solver", seed: 0x50_1e_12_00, count: 1200 },
  { name: "analysis", seed: 0xa1_a1_15_15, count: 1200 },
  // Bounded by the twenty committed reconstructions times three timing profiles, not by the seed.
  { name: "metrics", seed: 0x11_e7_21_c5, count: 60 },
  { name: "planner", seed: 0x91_a1_11_e2, count: 1200 },
  { name: "s2", seed: 0x52_02_20_26, count: 24 },
];

mkdirSync(OUT, { recursive: true });

for (const job of JOBS) {
  const generate = GENERATORS[job.name];
  if (!generate) throw new Error(`no generator named ${job.name}`);

  const started = Date.now();
  const file = generate(job.seed, job.count);
  // Two-space JSON: the diff of a regenerated corpus should be readable, because a diff that
  // cannot be read is a diff nobody checks.
  const json = `${JSON.stringify(file, null, 2)}\n`;
  writeFileSync(`${OUT}${job.name}.json`, json);
  console.log(
    `  ${job.name.padEnd(9)} ${String(file.cases.length).padStart(5)} cases  ` +
      `${(json.length / 1024).toFixed(0).padStart(5)} KB  ${Date.now() - started} ms`,
  );
}
