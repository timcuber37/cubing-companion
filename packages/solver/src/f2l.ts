/**
 * F2L insertion enumeration — finishing one pair without wrecking the rest.
 *
 * This search has a constraint the cross and xcross searches do not: the position it lands on
 * must have the cross intact, the new pair solved, **and every pair that was already built still
 * built**. It may break all of them along the way — every real F2L algorithm does — but only the
 * final position is judged.
 *
 * That also breaks the pruning the other searches lean on. Once the cross is solved its distance
 * is zero and prunes nothing at the root. The heuristic here is a **maximum of admissible lower
 * bounds**: the cross distance, plus the pair distance for the target and for each pair that has
 * to survive. Each is a genuine lower bound on the moves remaining — restoring a disturbed cross
 * cannot cost less than its distance, and nor can restoring a disturbed pair — so their maximum
 * is admissible too, and the search still finds every solution at a given length rather than
 * merely some.
 *
 * The cross term stops being useless the moment the search breaks the cross, which is exactly
 * when pruning is needed.
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
import { crossIndexNormalised, crossTable } from "./crossTable.ts";
import { pairIndexFrom, pairTable } from "./pairTable.ts";
import type { Candidate, SearchOptions, SearchResult } from "./types.ts";

const DEFAULT_MAX_SOLUTIONS = 50;
/** Optimal insertions run 6–7 moves; well past that the answer stops being interesting. */
export const MAX_INSERTION_DEPTH = 12;

export interface InsertionOptions extends SearchOptions {
  /**
   * Slots that must still be solved afterwards.
   *
   * Defaults to whichever slots are solved in the position given. Detecting it is better than
   * demanding it: the position already knows what has been built, and asking a caller to repeat
   * it is a pointless opportunity to get it wrong.
   */
  readonly preserve?: readonly Slot[];
}

/**
 * Every way to insert one pair, shortest first, leaving everything else standing.
 *
 * @param state position to solve from, in any orientation.
 * @param crossFace which colour's cross, as a face index in the normalised frame.
 * @param target the slot to fill.
 */
export function enumerateF2LInsertion(
  state: CubeState,
  crossFace: Face,
  target: Slot,
  options: InsertionOptions = {},
): SearchResult {
  const startedAt = Date.now();
  const table = crossTable(crossFace);
  const geometry = GEOMETRY[crossFace]!;
  const crossEdges = geometry.crossEdges;

  // Normalise once: the search applies only face turns, which never permute centres, so every
  // position it reaches stays normalised.
  const working = normalizeOrientation(state);

  const preserve =
    options.preserve ??
    geometry.slots.filter((slot) => slot !== target && isSlotSolved(working, slot));

  // Every slot whose pair must be standing at the end, and the table to measure each by.
  const required: { slot: Slot; distances: Uint8Array }[] = [
    { slot: target, distances: pairTable(target) },
    ...preserve.map((slot) => ({ slot, distances: pairTable(slot) })),
  ];

  const maxSolutions = options.maxSolutions ?? DEFAULT_MAX_SOLUTIONS;
  const ceiling = Math.min(options.maxDepth ?? MAX_INSERTION_DEPTH, MAX_INSERTION_DEPTH);
  const maxExtra = options.maxExtra ?? 0;
  const targetLabel = slotName(target);

  const candidates: Candidate[] = [];
  const path: Move[] = [];
  // Reused across every node: inverting the two permutations once beats scanning them for each
  // of up to four pairs. Written afresh in full each time, so nothing stale survives.
  const inverseCp = new Uint8Array(8);
  const inverseEp = new Uint8Array(12);
  let nodes = 0;
  let truncated = false;
  let optimal = -1;

  /** Depth-first for solutions of exactly `remaining` more moves. */
  function search(remaining: number): void {
    if (candidates.length >= maxSolutions) {
      truncated = true;
      return;
    }
    nodes++;

    const crossLeft = table.distance[crossIndexNormalised(working, crossEdges)]!;
    let bound = crossLeft;
    let allHome = crossLeft === 0;
    for (let i = 0; i < 8; i++) inverseCp[working.cp[i]!] = i;
    for (let i = 0; i < 12; i++) inverseEp[working.ep[i]!] = i;
    for (const { slot, distances } of required) {
      const left = distances[pairIndexFrom(working, slot, inverseCp, inverseEp)]!;
      if (left > bound) bound = left;
      if (left !== 0) allHome = false;
    }

    // A pair at distance zero is home *and* oriented, so this is the goal test too — no separate
    // per-slot check is needed.
    if (allHome) {
      if (remaining === 0) {
        candidates.push({
          moves: [...path],
          length: path.length,
          overOptimal: optimal === -1 ? 0 : path.length - optimal,
          slot: targetLabel,
        });
      }
      return;
    }
    if (remaining === 0 || bound > remaining) return;

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

  for (let depth = 0; depth <= ceiling; depth++) {
    search(depth);
    if (candidates.length > 0) {
      if (optimal === -1) {
        optimal = candidates[0]!.length;
        for (let i = 0; i < candidates.length; i++) {
          candidates[i] = { ...candidates[i]!, overOptimal: 0 };
        }
      }
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

export interface NextPairOption {
  readonly slot: Slot;
  readonly result: SearchResult;
}

/**
 * Insertion candidates for every slot still empty.
 *
 * The question a planner actually asks — not "how do I fill FR" but "which pair should I do
 * next, and what does each cost". Ordered cheapest first.
 */
export function enumerateNextPair(
  state: CubeState,
  crossFace: Face,
  options: InsertionOptions = {},
): NextPairOption[] {
  const normalised = normalizeOrientation(state);
  const geometry = GEOMETRY[crossFace]!;
  const remaining = geometry.slots.filter((slot) => !isSlotSolved(normalised, slot));

  return remaining
    .map((slot) => ({
      slot,
      result: enumerateF2LInsertion(state, crossFace, slot, options),
    }))
    .sort((a, b) => {
      // Slots with no solution inside the depth ceiling sink to the bottom rather than sorting
      // as though they were free.
      const left = a.result.optimal === -1 ? Infinity : a.result.optimal;
      const right = b.result.optimal === -1 ? Infinity : b.result.optimal;
      return left - right;
    });
}
