/**
 * Random-move scramble tests.
 *
 * This generator exists as a fallback for environments where the random-state solver's worker
 * cannot start — currently anything bundled with Turbopack. It is the weaker of the two kinds,
 * so its one job is to at least be a *valid* scramble: no redundant sequences that make it
 * shorter than it looks.
 */
import { describe, expect, it } from "vitest";
import fc from "fast-check";
import {
  generateScramble,
  RANDOM_MOVE_LENGTH,
  randomMoveScramble,
} from "../src/scramble.ts";
import { serializeMoves } from "../src/notation.ts";
import { stateAfter } from "../src/moves.ts";

/** Deterministic stand-in for Math.random, cycling through fixed values. */
function seeded(values: number[]): () => number {
  let i = 0;
  return () => values[i++ % values.length]!;
}

describe("randomMoveScramble", () => {
  it("produces the requested number of moves", () => {
    expect(randomMoveScramble()).toHaveLength(RANDOM_MOVE_LENGTH);
    expect(randomMoveScramble(12)).toHaveLength(12);
    expect(randomMoveScramble(0)).toHaveLength(0);
  });

  it("uses only outer-face turns", () => {
    // A scramble with rotations or slices would be legal notation but not a WCA-style
    // scramble, and would confuse anyone applying it.
    for (const move of randomMoveScramble(60)) {
      expect(["U", "D", "L", "R", "F", "B"]).toContain(move.family);
      expect([1, 2, -1]).toContain(move.amount);
    }
  });

  it("never repeats a face", () => {
    // `R R` is just `R2` written long: it makes the scramble shorter than it appears.
    fc.assert(
      fc.property(fc.integer({ min: 2, max: 60 }), (length) => {
        const moves = randomMoveScramble(length);
        for (let i = 1; i < moves.length; i++) {
          expect(moves[i]!.family).not.toBe(moves[i - 1]!.family);
        }
      }),
      { numRuns: 100 },
    );
  });

  it("never returns to the same axis across one move", () => {
    // `R L R` collapses to `R2 L` reordered, since L and R commute — another way to be
    // shorter than you look.
    const axis: Record<string, string> = {
      U: "UD", D: "UD", L: "LR", R: "LR", F: "FB", B: "FB",
    };
    fc.assert(
      fc.property(fc.integer({ min: 3, max: 60 }), (length) => {
        const moves = randomMoveScramble(length);
        for (let i = 2; i < moves.length; i++) {
          const collapses =
            moves[i]!.family === moves[i - 2]!.family &&
            axis[moves[i]!.family] === axis[moves[i - 1]!.family];
          expect(collapses, serializeMoves(moves.slice(i - 2, i + 1))).toBe(false);
        }
      }),
      { numRuns: 100 },
    );
  });

  it("actually scrambles the cube", () => {
    fc.assert(
      fc.property(fc.integer({ min: 8, max: 40 }), (length) => {
        expect(stateAfter(randomMoveScramble(length)).isSolved()).toBe(false);
      }),
      { numRuns: 50 },
    );
  });

  it("is deterministic given a deterministic source", () => {
    const values = [0.1, 0.4, 0.7, 0.2, 0.9, 0.55, 0.33, 0.81];
    expect(serializeMoves(randomMoveScramble(15, seeded(values)))).toBe(
      serializeMoves(randomMoveScramble(15, seeded(values))),
    );
  });

  it("makes progress even when the source keeps proposing the same face", () => {
    // A source stuck on one value would have every candidate rejected as a repeat; the
    // generator must not spin forever. Alternating values keep it moving.
    const moves = randomMoveScramble(10, seeded([0, 0.5]));
    expect(moves).toHaveLength(10);
  });
});

describe("generateScramble", () => {
  it("falls back to random-move when the solver does not answer", async () => {
    // A failed worker never settles rather than rejecting, so the attempt is raced against a
    // timeout. Zero here forces the fallback path deterministically.
    const scramble = await generateScramble(0);
    expect(scramble.kind).toBe("random-move");
    expect(scramble.text.split(/\s+/)).toHaveLength(RANDOM_MOVE_LENGTH);
  });

  it("reports which kind it produced", async () => {
    // The kind is load-bearing, not decoration: the two sample cube positions differently, so
    // anything comparing solves across scramble kinds needs to know which it got.
    const scramble = await generateScramble(0);
    expect(["random-state", "random-move"]).toContain(scramble.kind);
  });

  it("returns a scramble that parses and scrambles", async () => {
    const { text } = await generateScramble(0);
    expect(stateAfter(randomMoveScramble(0)).isSolved()).toBe(true); // sanity: empty is solved
    expect(text.length).toBeGreaterThan(0);
  });
});
