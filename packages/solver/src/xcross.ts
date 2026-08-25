/**
 * xcross enumeration — cross plus one F2L pair, together.
 *
 * Unlike the cross, this genuinely needs search: adding a corner and an edge takes the position
 * count from 190,080 to roughly 73 million, past what a full table is worth. Depth-limited
 * depth-first search, pruned by the cross table, does it in tens of milliseconds.
 *
 * **Why the cross table is an admissible heuristic.** A finished xcross has a finished cross, so
 * a position needing six moves to finish its cross needs at least six to finish an xcross.
 * Pruning on it can therefore never discard a solution — which is what lets the search claim to
 * find *all* solutions at a given length, not merely some.
 *
 * The search keeps one mutable cube state and undoes each move on the way back out, rather than
 * allocating a state per node. At tens of thousands of nodes per query that is the difference
 * between comfortable and sluggish.
 */
import {
  applyMoveInPlace,
  invertMove,
  normalizeOrientation,
  type CubeState,
  type Face,
  type Move,
} from "@cubing-companion/engine";
import {
  GEOMETRY,
  isSlotSolved,
  slotName,
  type Slot,
} from "@cubing-companion/analysis";
import { allowed, SEARCH_MOVES } from "./moves.ts";
import { crossIndexNormalised, crossTable, UNREACHABLE } from "./crossTable.ts";
import type { Candidate, SearchOptions, SearchResult } from "./types.ts";

const DEFAULT_MAX_SOLUTIONS = 50;
/** Beyond this, the search stops being interactive and the answer stops being interesting. */
export const MAX_XCROSS_DEPTH = 11;

/**
 * Every way to finish the cross and one named slot together, shortest first.
 *
 * @param state position to solve from, in any orientation.
 * @param crossFace which colour's cross, as a face index in the normalised frame.
 * @param slot which pair to include.
 */
export function enumerateXcross(
  state: CubeState,
  crossFace: Face,
  slot: Slot,
  options: SearchOptions = {},
): SearchResult {
  const startedAt = Date.now();
  const table = crossTable(crossFace);
  const geometry = GEOMETRY[crossFace]!;

  // Normalise once. The search only applies face turns, which never permute centres, so every
  // position it reaches stays normalised and the hot path never re-normalises.
  const working = normalizeOrientation(state);

  const crossEdges = geometry.crossEdges;
  const crossIsSolvable =
    table.distance[crossIndexNormalised(working, crossEdges)] !== UNREACHABLE;
  if (!crossIsSolvable) {
    return {
      candidates: [],
      optimal: -1,
      stats: { nodes: 0, elapsedMs: Date.now() - startedAt, truncated: false },
    };
  }

  const maxSolutions = options.maxSolutions ?? DEFAULT_MAX_SOLUTIONS;
  const ceiling = Math.min(options.maxDepth ?? MAX_XCROSS_DEPTH, MAX_XCROSS_DEPTH);

  const candidates: Candidate[] = [];
  const path: Move[] = [];
  let nodes = 0;
  let truncated = false;
  let optimal = -1;

  const slotLabel = slotName(slot);

  /** Depth-first for solutions of exactly `remaining` more moves. */
  function search(remaining: number): void {
    if (candidates.length >= maxSolutions) {
      truncated = true;
      return;
    }
    nodes++;

    // Computed once and used for both the goal test and the prune. Indexing walks twelve slots
    // looking for four pieces, and this runs at every node of a search that visits hundreds of
    // thousands — doing it twice was costing roughly half the search time.
    const distance = table.distance[crossIndexNormalised(working, crossEdges)]!;

    if (distance === 0 && isSlotSolved(working, slot)) {
      if (remaining === 0) {
        candidates.push({
          moves: [...path],
          length: path.length,
          overOptimal: optimal === -1 ? 0 : path.length - optimal,
          slot: slotLabel,
        });
      }
      return;
    }
    if (remaining === 0) return;
    // Admissible: finishing the xcross cannot take fewer moves than finishing the cross alone.
    if (distance > remaining) return;

    for (let m = 0; m < SEARCH_MOVES.length; m++) {
      const move = SEARCH_MOVES[m]!;
      if (!allowed(move, path[path.length - 1])) continue;
      applyMoveInPlace(working, move);
      path.push(move);
      search(remaining - 1);
      path.pop();
      applyMoveInPlace(working, invertMove(move));
      if (candidates.length >= maxSolutions) return;
    }
  }

  // Iterative deepening: the first depth that yields anything is the optimum, and searching
  // depth by depth means a solution cap keeps the *shortest* candidates rather than a sample.
  for (let depth = 0; depth <= ceiling; depth++) {
    search(depth);
    if (candidates.length > 0) {
      if (optimal === -1) {
        optimal = candidates[0]!.length;
        // Recorded before `optimal` was known, so fix it up.
        for (let i = 0; i < candidates.length; i++) {
          candidates[i] = { ...candidates[i]!, overOptimal: 0 };
        }
      }
      const maxExtra = options.maxExtra ?? 0;
      if (depth >= optimal + maxExtra) break;
    }
    if (candidates.length >= maxSolutions) break;
  }

  return {
    candidates,
    optimal,
    stats: { nodes, elapsedMs: Date.now() - startedAt, truncated },
  };
}

/** Enumerate xcrosses for every slot, so a planner can compare which pair is cheapest. */
export function enumerateAllXcrosses(
  state: CubeState,
  crossFace: Face,
  options: SearchOptions = {},
): SearchResult[] {
  return GEOMETRY[crossFace]!.slots.map((slot) =>
    enumerateXcross(state, crossFace, slot, options),
  );
}
