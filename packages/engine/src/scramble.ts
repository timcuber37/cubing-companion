/**
 * Scramble generation.
 *
 * Two kinds, and the difference matters enough to be surfaced rather than hidden.
 *
 * **Random-state** is what the WCA uses: a uniformly random cube position, solved backwards to
 * produce the scramble. It needs a solver, which cubing.js runs in a Web Worker loading WASM.
 *
 * **Random-move** is a sequence of random turns with the obvious redundancies excluded. It
 * needs nothing, but it is not uniform over positions — some are far likelier than others, and
 * the distribution of difficulty is subtly different. Timers used this before ~2010.
 *
 * The worker is the problem: it instantiates under Node and fails under some bundlers with
 * "Module worker instantiation failed" — Turbopack, currently, which is what this app builds
 * with. `generateScramble` therefore tries the good one and falls back, **reporting which it
 * produced** so the UI can say so. Silently substituting a weaker scramble would quietly
 * change the difficulty distribution of every recorded solve.
 */
import { randomScrambleForEvent } from "cubing/scramble";
import { setSearchDebug } from "cubing/search";
import { parseMoves, serializeMoves } from "./notation.ts";
import { makeMove, type Move } from "./moves.ts";

let configured = false;

function configureSearch(): void {
  if (configured) return;
  configured = true;
  try {
    // Selects an alternative worker-instantiation path that survives some bundlers. It does
    // not currently rescue Turbopack, but it is harmless and helps elsewhere.
    setSearchDebug({ prioritizeEsbuildWorkaroundForWorkerInstantiation: true });
  } catch {
    // Older versions may not know the flag.
  }
}

/** How a scramble was produced. */
export type ScrambleKind = "random-state" | "random-move";

export interface GeneratedScramble {
  readonly text: string;
  readonly kind: ScrambleKind;
}

/**
 * A WCA-legal random-state scramble, as notation.
 *
 * @throws if the solver cannot start — see {@link generateScramble} for the forgiving version.
 */
export async function randomScrambleString(): Promise<string> {
  configureSearch();
  const alg = await randomScrambleForEvent("333");
  return alg.toString();
}

/** A WCA-legal random-state 3x3 scramble, as a move list. */
export async function randomScramble(): Promise<Move[]> {
  return parseMoves(await randomScrambleString());
}

const FACES = ["U", "D", "L", "R", "F", "B"] as const;
/** Opposite faces share an axis: `U` then `D` then `U` is a redundant ordering. */
const AXIS: Readonly<Record<string, string>> = {
  U: "UD",
  D: "UD",
  L: "LR",
  R: "LR",
  F: "FB",
  B: "FB",
};
const AMOUNTS: readonly (1 | 2 | -1)[] = [1, 2, -1];

export const RANDOM_MOVE_LENGTH = 25;

/**
 * A random-move scramble.
 *
 * Excludes the two redundancies that make a sequence shorter than it looks: repeating a face,
 * and returning to a face on the same axis without having left it (`R L R`, which is just
 * `R2 L` reordered). Longer than a random-state scramble because random moves cover the space
 * less efficiently.
 *
 * @param random injected for tests; defaults to `Math.random`.
 */
export function randomMoveScramble(
  length: number = RANDOM_MOVE_LENGTH,
  random: () => number = Math.random,
): Move[] {
  const moves: Move[] = [];
  let previousFace: string | null = null;
  let faceBefore: string | null = null;

  while (moves.length < length) {
    const face = FACES[Math.floor(random() * FACES.length)]!;
    if (face === previousFace) continue;
    // `R L R` — same axis either side of one move — collapses; skip it.
    if (
      previousFace !== null &&
      faceBefore === face &&
      AXIS[previousFace] === AXIS[face]
    ) {
      continue;
    }
    const amount = AMOUNTS[Math.floor(random() * AMOUNTS.length)]!;
    const move = makeMove(face, amount);
    if (!move) continue;
    moves.push(move);
    faceBefore = previousFace;
    previousFace = face;
  }
  return moves;
}

/**
 * How long to wait for the random-state solver before giving up on it.
 *
 * Generous, because the first call also pays for loading the WASM solver. It exists because a
 * failed worker does not reject — it simply never settles, so a `try`/`catch` alone would wait
 * forever and the UI would sit on "Scrambling…" with no explanation.
 */
export const RANDOM_STATE_TIMEOUT_MS = 5_000;

/**
 * A scramble, preferring random-state and falling back to random-move.
 *
 * The returned `kind` is not decoration: a random-move scramble is a materially different
 * sample of positions, and anything comparing solves across scramble kinds needs to know.
 */
export async function generateScramble(
  timeoutMs: number = RANDOM_STATE_TIMEOUT_MS,
): Promise<GeneratedScramble> {
  const fallback = (): GeneratedScramble => ({
    text: serializeMoves(randomMoveScramble()),
    kind: "random-move",
  });

  try {
    const timeout = new Promise<null>((resolve) => {
      setTimeout(() => resolve(null), timeoutMs);
    });
    const text = await Promise.race([randomScrambleString(), timeout]);
    return text === null ? fallback() : { text, kind: "random-state" };
  } catch {
    return fallback();
  }
}
