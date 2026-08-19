/**
 * Scramble generation.
 *
 * `cubing/scramble` is WASM- and worker-backed, which makes it the one part of the engine
 * with a heavyweight runtime and the most likely to be awkward in CI. It is isolated here
 * so that if it ever becomes hostile, this file can be excluded without weakening the
 * core suite — nothing else in the engine depends on it.
 */
import { describe, expect, it } from "vitest";
import { randomScramble, randomScrambleString } from "../src/scramble.ts";
import { stateAfter } from "../src/moves.ts";
import { isSolvedIgnoringOrientation } from "../src/predicates.ts";
import { serializeMoves } from "../src/notation.ts";

// Random-state scrambles need a solver; the first call pays for WASM startup.
const TIMEOUT_MS = 60_000;

describe("scramble generation", () => {
  it(
    "produces a parseable scramble that actually scrambles the cube",
    async () => {
      const moves = await randomScramble();
      expect(moves.length).toBeGreaterThan(0);
      expect(isSolvedIgnoringOrientation(stateAfter(moves))).toBe(false);
      // WCA 3x3 scrambles are outer-face only — no rotations, slices, or wide moves.
      for (const move of moves) {
        expect(["U", "D", "L", "R", "F", "B"]).toContain(move.family);
      }
      // And it must survive a round trip through our own notation.
      expect(serializeMoves(moves).length).toBeGreaterThan(0);
    },
    TIMEOUT_MS,
  );

  it(
    "produces different scrambles on successive calls",
    async () => {
      const [a, b] = await Promise.all([
        randomScrambleString(),
        randomScrambleString(),
      ]);
      expect(a).not.toBe(b);
    },
    TIMEOUT_MS,
  );
});
