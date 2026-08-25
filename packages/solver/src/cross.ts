/**
 * Cross enumeration.
 *
 * With an exact distance table there is no search in the usual sense: from any position, the
 * moves that make progress are exactly those that step to a lower distance, so *every* optimal
 * solution is found by walking down the table. Longer solutions are found by allowing a bounded
 * number of non-progressing steps, which is what turns this from a solver into a source of
 * alternatives — and a coach usually wants alternatives, since the shortest cross is often not
 * the one a person would find.
 */
import {
  normalizeOrientation,
  type CubeState,
  type Face,
  type Move,
} from "@cubing-companion/engine";
import { allowed, SEARCH_MOVES } from "./moves.ts";
import {
  crossIndexNormalised,
  crossTable,
  stepCross,
  UNREACHABLE,
} from "./crossTable.ts";
import type { Candidate, SearchOptions, SearchResult } from "./types.ts";

const DEFAULT_MAX_SOLUTIONS = 200;

/**
 * Every way to finish the cross, shortest first.
 *
 * Runs entirely on packed integer positions — no cube states are touched, which is what keeps
 * this fast enough to call while somebody waits.
 */
export function enumerateCross(
  state: CubeState,
  crossFace: Face,
  options: SearchOptions = {},
): SearchResult {
  const startedAt = Date.now();
  const table = crossTable(crossFace);
  const startIndex = crossIndexNormalised(
    normalizeOrientation(state),
    table.edges,
  );

  const optimal = table.distance[startIndex]!;
  if (optimal === UNREACHABLE) {
    // Cannot happen for a state the engine produced; a position outside the reachable set
    // means the caller built one by hand.
    return {
      candidates: [],
      optimal: -1,
      stats: { nodes: 0, elapsedMs: Date.now() - startedAt, truncated: false },
    };
  }

  const maxExtra = options.maxExtra ?? 0;
  const maxSolutions = options.maxSolutions ?? DEFAULT_MAX_SOLUTIONS;
  const limit = Math.min(optimal + maxExtra, options.maxDepth ?? Infinity);

  const candidates: Candidate[] = [];
  const path: Move[] = [];
  let nodes = 0;
  let truncated = false;

  /**
   * Depth-first for solutions of *exactly* `remaining` more moves.
   *
   * Exact length, not "at most": the caller searches each depth in turn, and accepting shorter
   * solutions here would re-find every optimal one at every subsequent depth.
   */
  function search(index: number, remaining: number): void {
    if (candidates.length >= maxSolutions) {
      truncated = true;
      return;
    }
    nodes++;

    if (index === table.solvedIndex) {
      // Only a path that finishes exactly here counts, and a cross solution never continues
      // past a finished cross — so this returns either way.
      if (remaining === 0) {
        candidates.push({
          moves: [...path],
          length: path.length,
          overOptimal: path.length - optimal,
        });
      }
      return;
    }
    if (remaining === 0) return;
    // Exact distance, so this prunes everything that cannot finish in time.
    if (table.distance[index]! > remaining) return;

    for (let m = 0; m < SEARCH_MOVES.length; m++) {
      const move = SEARCH_MOVES[m]!;
      if (!allowed(move, path[path.length - 1])) continue;
      path.push(move);
      search(stepCross(index, m), remaining - 1);
      path.pop();
      if (candidates.length >= maxSolutions) return;
    }
  }

  // Shortest first: search each length in turn rather than sorting afterwards, so a solution
  // cap keeps the *shortest* candidates rather than an arbitrary sample.
  for (let depth = optimal; depth <= limit; depth++) {
    search(startIndex, depth);
    if (candidates.length >= maxSolutions) break;
  }

  return {
    candidates,
    optimal,
    stats: { nodes, elapsedMs: Date.now() - startedAt, truncated },
  };
}

/** The optimal cross length, without building the solutions. */
export function optimalCrossLength(state: CubeState, crossFace: Face): number {
  const table = crossTable(crossFace);
  return table.distance[
    crossIndexNormalised(normalizeOrientation(state), table.edges)
  ]!;
}

/** One optimal solution, or `null` if the cross is already finished. */
export function solveCross(state: CubeState, crossFace: Face): Move[] | null {
  const first = enumerateCross(state, crossFace, { maxSolutions: 1 }).candidates[0];
  if (!first || first.moves.length === 0) return null;
  return [...first.moves];
}
