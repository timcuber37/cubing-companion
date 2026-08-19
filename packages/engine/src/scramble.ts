/**
 * Scramble generation.
 *
 * A thin async wrapper over cubing.js. Kept isolated because `cubing/scramble` is
 * WASM- and worker-backed: it is the one part of the engine with a heavyweight runtime,
 * and nothing else should have to care.
 */
import { randomScrambleForEvent } from "cubing/scramble";
import { parseMoves } from "./notation.ts";
import type { Move } from "./moves.ts";

/** A WCA-legal random-state 3x3 scramble, as notation. */
export async function randomScrambleString(): Promise<string> {
  const alg = await randomScrambleForEvent("333");
  return alg.toString();
}

/** A WCA-legal random-state 3x3 scramble, as a move list. */
export async function randomScramble(): Promise<Move[]> {
  return parseMoves(await randomScrambleString());
}
