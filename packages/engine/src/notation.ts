/**
 * Notation parsing and serialization.
 *
 * Parsing delegates to cubing.js rather than reimplementing a grammar. That buys the full
 * alg.cubing.net dialect for free — `//` line comments, `F2'`, lowercase wide moves,
 * repeated tokens like `D D`, commutators and conjugates — which is exactly what the
 * reconstruction corpus is written in.
 */
import { Alg, Move as AlgMove } from "cubing/alg";
import { makeMove, type Move } from "./moves.ts";

export class NotationError extends Error {
  override readonly name = "NotationError";
}

/**
 * Parse an algorithm into a flat move list.
 *
 * Commutators, conjugates, and groupings are expanded. Comments, newlines, and pauses are
 * dropped, as are no-op moves such as `R4`.
 *
 * @throws {NotationError} on malformed syntax or an unrecognized move family.
 */
export function parseMoves(text: string): Move[] {
  let alg: Alg;
  try {
    alg = Alg.fromString(text).expand();
  } catch (cause) {
    throw new NotationError(
      `could not parse algorithm: ${(cause as Error).message}`,
      { cause },
    );
  }

  const moves: Move[] = [];
  for (const node of alg.childAlgNodes()) {
    if (!(node instanceof AlgMove)) continue; // comments, newlines, pauses

    // Layer-prefixed moves (`2U`, `3Rw`, `2-3r`) parse with a bare family plus layer
    // numbers, so accepting them blindly would silently apply `U` for `2U`. They are
    // big-cube notation, absent from CFOP reconstructions, and the tables do not model
    // them — reject rather than guess.
    const { innerLayer, outerLayer } = node.quantum;
    if (innerLayer !== null || outerLayer !== null) {
      throw new NotationError(
        `layer-prefixed moves are not supported: ${node.toString()}`,
      );
    }

    const move = makeMove(node.family, node.amount);
    if (move === undefined) {
      throw new NotationError(`unrecognized move family: ${node.toString()}`);
    }
    if (move === null) continue; // whole rotation, e.g. R4
    moves.push(move);
  }
  return moves;
}

/** Serialize one move, e.g. `{ family: "R", amount: -1 }` becomes `R'`. */
export function serializeMove(move: Move): string {
  return `${move.family}${move.amount === 1 ? "" : move.amount === 2 ? "2" : "'"}`;
}

/** Serialize a move list to space-separated notation. */
export function serializeMoves(moves: readonly Move[]): string {
  return moves.map(serializeMove).join(" ");
}

/** Convert a move list to a cubing.js {@link Alg}, for the twisty player or solvers. */
export function toAlg(moves: readonly Move[]): Alg {
  return Alg.fromString(serializeMoves(moves));
}
