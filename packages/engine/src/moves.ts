/**
 * Moves and their application to a {@link CubeState}.
 *
 * Every family — face, wide, slice, rotation — goes through one code path: resolve to a
 * precomputed transformation, then compose. There is no special-casing of slices or
 * rotations, which is what keeps rotation handling (and therefore colour neutrality)
 * from drifting out of sync with face turns.
 */
import { CubeState } from "./state.ts";
import {
  resolveFamily,
  transformationFor,
  type Family,
  type Transformation,
} from "./tables.ts";

/** A single move. `amount` is a quarter-turn count, always one of `1`, `2`, `-1`. */
export interface Move {
  readonly family: Family;
  readonly amount: 1 | 2 | -1;
}

/**
 * Reduce a raw quarter-turn count modulo 4.
 *
 * Returns `0` for a whole rotation (`R4`, `R0`), which callers drop — it is a no-op, not
 * an error. Reconstructions do occasionally contain such moves.
 */
export function normalizeAmount(raw: number): 1 | 2 | -1 | 0 {
  const n = ((raw % 4) + 4) % 4;
  return n === 0 ? 0 : n === 1 ? 1 : n === 2 ? 2 : -1;
}

/**
 * Build a {@link Move} from a written family name (canonical or alias) and amount.
 *
 * Returns `undefined` for an unknown family, or `null` for a well-formed no-op such as
 * `R4`. Distinguishing the two lets the notation layer reject typos while silently
 * dropping identity moves.
 */
export function makeMove(
  familyName: string,
  rawAmount: number,
): Move | null | undefined {
  const resolved = resolveFamily(familyName);
  if (resolved === undefined) return undefined;
  const amount = normalizeAmount(rawAmount * resolved.sign);
  if (amount === 0) return null;
  return { family: resolved.family, amount };
}

/** The move that undoes `move`. */
export function invertMove(move: Move): Move {
  return { family: move.family, amount: move.amount === 2 ? 2 : -move.amount as 1 | -1 };
}

/** The sequence that undoes `moves`. */
export function invertMoves(moves: readonly Move[]): Move[] {
  const out: Move[] = new Array(moves.length);
  for (let i = 0; i < moves.length; i++) {
    out[moves.length - 1 - i] = invertMove(moves[i]!);
  }
  return out;
}

function tableIndexFor(amount: 1 | 2 | -1): 1 | 2 | 3 {
  return amount === -1 ? 3 : amount;
}

function transformationOf(move: Move): Transformation {
  const resolved = resolveFamily(move.family);
  if (resolved === undefined) {
    throw new Error(`unknown move family: ${move.family}`);
  }
  return transformationFor(resolved.index, tableIndexFor(move.amount));
}

/**
 * Compose `src` with `t`, writing into `dst`.
 *
 * `dst` must not alias `src`. Semantics match KPuzzle: the piece landing in slot `i`
 * comes from slot `t.xp[i]`, and carries its orientation plus the transformation's delta.
 */
function composeInto(src: CubeState, t: Transformation, dst: CubeState): void {
  const { cp, co, ep, eo, centers } = src;
  for (let i = 0; i < 8; i++) {
    const from = t.cp[i]!;
    dst.cp[i] = cp[from]!;
    dst.co[i] = (co[from]! + t.co[i]!) % 3;
  }
  for (let i = 0; i < 12; i++) {
    const from = t.ep[i]!;
    dst.ep[i] = ep[from]!;
    dst.eo[i] = (eo[from]! + t.eo[i]!) & 1;
  }
  for (let i = 0; i < 6; i++) {
    dst.centers[i] = centers[t.centers[i]!]!;
  }
}

// Reused so that applying a move allocates nothing. Single-threaded by design; a Web
// Worker gets its own module instance, so this is not shared across threads.
const scratch = new CubeState();

/** Apply `move` to `state`, mutating it in place. Allocation-free. */
export function applyMoveInPlace(state: CubeState, move: Move): void {
  scratch.copyFrom(state);
  composeInto(scratch, transformationOf(move), state);
}

/** Apply `moves` to `state`, mutating it in place. Allocation-free. */
export function applyMovesInPlace(
  state: CubeState,
  moves: Iterable<Move>,
): void {
  for (const move of moves) applyMoveInPlace(state, move);
}

/** Apply `moves` to a copy of `state`, leaving the original untouched. */
export function applyMoves(state: CubeState, moves: Iterable<Move>): CubeState {
  const next = state.clone();
  applyMovesInPlace(next, moves);
  return next;
}

/** Apply `moves` to a solved cube. */
export function stateAfter(moves: Iterable<Move>): CubeState {
  return applyMoves(CubeState.solved(), moves);
}
