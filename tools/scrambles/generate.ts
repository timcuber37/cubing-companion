/**
 * The native app's scramble pool: WCA random-state 3x3 scrambles, generated ahead of time.
 *
 * Run: npm run scrambles
 *
 * Random-state scrambles need a two-phase solver, which the Swift app does not have. S1 measured
 * the alternative: cubing.js makes one in a few milliseconds and it costs about sixty bytes, so a
 * pool of ten thousand is well under a megabyte and a couple of minutes to build. The app deals it
 * out in a shuffled order it remembers, so none repeats until all have been used — sampling it at
 * random would make a repeat likely within about 120 solves, which is recognisable.
 *
 * One scramble per line, nothing else, into the app's resources.
 */
import { writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { randomScrambleForEvent } from "cubing/scramble";

const COUNT = Number(process.argv[2] ?? 10_000);
const OUT = fileURLToPath(new URL("../../swift/CubingApp/CubingApp/Resources/scrambles.txt", import.meta.url));

// cubing.js logs a timing line for every scramble; ten thousand of those bury anything useful.
const log = console.log;
console.log = () => {};
console.info = () => {};

const started = Date.now();
const scrambles = new Set<string>();
while (scrambles.size < COUNT) {
  scrambles.add((await randomScrambleForEvent("333")).toString());
  if (scrambles.size % 1000 === 0) log(`  ${scrambles.size} scrambles, ${Math.round((Date.now() - started) / 1000)} s`);
}
writeFileSync(OUT, [...scrambles].join("\n") + "\n");
log(`  ${scrambles.size} random-state scrambles -> ${OUT.split("/").slice(-3).join("/")}`);
process.exit(0);
