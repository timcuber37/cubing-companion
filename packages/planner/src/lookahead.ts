/** Pair-level beam search. Every edge is an executable, preserving F2L insertion. */
import { applyMoves, normalizeOrientation, type CubeState, type Face, type Move } from "@cubing-companion/engine";
import { GEOMETRY, isSlotSolved, slotName, type Slot } from "@cubing-companion/analysis";
import { crossDistance, enumerateF2LInsertion, pairDistance, type SearchResult } from "@cubing-companion/solver";

export interface LookaheadOptions {
  /** Number of additional pairs to plan, including the current pair. */
  readonly depth?: number;
  readonly beamWidth?: number;
  /** Moves above each insertion's optimum to explore. */
  readonly maxExtra?: number;
  /** Total node budget, shared fairly across the first-pair choices. */
  readonly maxNodes?: number;
  readonly maxNodesPerSearch?: number;
}

export interface PairStep {
  /** Slot names and moves in the normalised search frame. */
  readonly slot: string;
  readonly moves: readonly Move[];
  /** Includes any other pairs this insertion happened to solve. */
  readonly solvedSlots: readonly string[];
}

export interface Continuation {
  readonly moves: readonly Move[];
  readonly steps: readonly PairStep[];
  readonly solvedSlots: readonly string[];
}

export interface ContinuationResult {
  /** Complete paths only: a failed search never masquerades as a free continuation. */
  readonly candidates: readonly Continuation[];
  /** Verified shorter prefixes, for inspection plans with a smaller goal. */
  readonly prefixes: readonly Continuation[];
  readonly nodes: number;
  readonly truncated: boolean;
}

export interface PairLookahead {
  readonly slot: Slot;
  /** Null when the budget could not establish a continuation to the requested horizon. */
  readonly plan: Continuation | null;
}

export interface PairLookaheadResult {
  readonly options: readonly PairLookahead[];
  /** Additional pairs each completed plan must solve; reduced near the end of F2L. */
  readonly depth: number;
  readonly nodes: number;
  readonly truncated: boolean;
}

function integer(name: string, value: number, minimum: number, maximum = Infinity): number {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw new RangeError(`${name} must be an integer between ${minimum} and ${maximum}`);
  }
  return value;
}

interface Path extends Continuation {
  readonly state: CubeState;
}

/**
 * Reach a total number of solved slots. Used for both inspection and pair decisions.
 *
 * Deduplication uses the entire resulting cube, not just the slot: equal-length insertions can
 * leave very different next pairs. A per-depth candidate cap reserves room for +1 alternatives.
 * Beam pruning and node limits make these best-found paths, never a global optimality claim.
 */
export function continueF2L(
  raw: CubeState,
  crossFace: Face,
  targetPairs: number,
  options: LookaheadOptions & { readonly firstSlot?: Slot } = {},
): ContinuationResult {
  integer("targetPairs", targetPairs, 0, 4);
  const beamWidth = integer("beamWidth", options.beamWidth ?? 4, 1);
  const maxExtra = integer("maxExtra", options.maxExtra ?? 1, 0, 3);
  const maxNodes = integer("maxNodes", options.maxNodes ?? 400_000, 0);
  const perSearch = integer("maxNodesPerSearch", options.maxNodesPerSearch ?? 50_000, 1);
  const state = normalizeOrientation(raw);
  if (crossDistance(state, crossFace) !== 0) {
    throw new RangeError("F2L lookahead requires a solved cross");
  }
  const geometry = GEOMETRY[crossFace]!;
  const solved = (position: CubeState) => geometry.slots.filter((slot) => isSlotSolved(position, slot));
  if (options.firstSlot && !geometry.slots.some((s) => slotName(s) === slotName(options.firstSlot!))) {
    throw new RangeError("firstSlot must belong to the selected cross");
  }
  const names = (position: CubeState) => solved(position).map(slotName);
  const lowerBound = (path: Path) => {
    const needed = targetPairs - path.solvedSlots.length;
    if (needed <= 0) return 0;
    const distances = geometry.slots
      .filter((slot) => !isSlotSolved(path.state, slot))
      .map((slot) => pairDistance(path.state, slot))
      .sort((a, b) => a - b);
    // At least this many turns are needed even if other pieces may be disturbed freely.
    return distances[needed - 1]!;
  };
  const accessible = (path: Path) => geometry.slots.reduce((total, slot) => {
    if (isSlotSolved(path.state, slot)) return total;
    return total + Number(geometry.llCorners.includes(path.state.cp.indexOf(slot.corner))) +
      Number(geometry.llEdges.includes(path.state.ep.indexOf(slot.edge)));
  }, 0);
  const compare = (a: Path, b: Path) =>
    a.moves.length + lowerBound(a) - b.moves.length - lowerBound(b) ||
    b.solvedSlots.length - a.solvedSlots.length || accessible(b) - accessible(a);

  let nodes = 0;
  let truncated = false;
  const cache = new Map<string, SearchResult>();
  let beam: Path[] = [{ state, moves: [], steps: [], solvedSlots: names(state) }];
  const completed: Path[] = [];
  const prefixes = new Map<string, Path>();

  // Every insertion solves at least one previously open slot, so four layers suffice.
  for (let level = 0; level <= 4; level++) {
    const next = new Map<string, Path>();
    for (const path of beam) {
      if (path.solvedSlots.length >= targetPairs) {
        completed.push(path);
        continue;
      }
      const open = geometry.slots.filter((slot) => !isSlotSolved(path.state, slot) &&
        (level !== 0 || !options.firstSlot || slotName(slot) === slotName(options.firstSlot)));
      for (const slot of open) {
        const key = `${path.state.key()}:${slotName(slot)}`;
        let result = cache.get(key);
        if (!result) {
          if (nodes >= maxNodes) {
            truncated = true;
            continue;
          }
          result = enumerateF2LInsertion(path.state, crossFace, slot, {
            maxExtra,
            maxSolutions: beamWidth * (maxExtra + 1),
            maxSolutionsPerDepth: beamWidth,
            maxNodes: Math.min(perSearch, maxNodes - nodes),
          });
          nodes += result.stats.nodes;
          truncated ||= result.stats.truncated;
          cache.set(key, result);
        }
        for (const candidate of result.candidates) {
          const after = applyMoves(path.state, candidate.moves);
          const solvedSlots = names(after);
          const child: Path = {
            state: after,
            moves: [...path.moves, ...candidate.moves],
            steps: [...path.steps, { slot: slotName(slot), moves: candidate.moves, solvedSlots }],
            solvedSlots,
          };
          const previous = next.get(after.key());
          if (!previous || compare(child, previous) < 0) next.set(after.key(), child);
          if (solvedSlots.length < targetPairs) {
            const prefix = prefixes.get(after.key());
            if (!prefix || child.moves.length < prefix.moves.length) prefixes.set(after.key(), child);
          }
        }
      }
    }
    const pending: Path[] = [];
    for (const path of next.values()) {
      if (path.solvedSlots.length >= targetPairs) completed.push(path);
      else pending.push(path);
    }
    pending.sort(compare);
    if (pending.length > beamWidth) truncated = true;
    beam = pending.slice(0, beamWidth);
    if (beam.length === 0) break;
  }
  const unique = new Map<string, Path>();
  for (const path of completed.sort(compare)) {
    if (!unique.has(path.state.key())) unique.set(path.state.key(), path);
  }
  return {
    candidates: [...unique.values()].slice(0, beamWidth).map(({ state: _state, ...path }) => path),
    prefixes: [...prefixes.values()].map(({ state: _state, ...path }) => path),
    nodes,
    truncated: truncated || unique.size > beamWidth,
  };
}

/** Compare each first pair over the same horizon, with a separate beam and equal work budget. */
export function lookaheadPairs(
  raw: CubeState,
  crossFace: Face,
  options: LookaheadOptions = {},
): PairLookaheadResult {
  const requestedDepth = integer("depth", options.depth ?? 2, 1, 4);
  const maxNodes = integer("maxNodes", options.maxNodes ?? 1_600_000, 0);
  const state = normalizeOrientation(raw);
  if (crossDistance(state, crossFace) !== 0) throw new RangeError("F2L lookahead requires a solved cross");
  const open = GEOMETRY[crossFace]!.slots.filter((slot) => !isSlotSolved(state, slot));
  const depth = Math.min(requestedDepth, open.length);
  let nodes = 0;
  let truncated = false;
  const results = open.map((slot) => {
    const result = continueF2L(state, crossFace, 4 - open.length + depth, {
      ...options,
      firstSlot: slot,
      maxNodes: Math.floor(maxNodes / open.length),
    });
    nodes += result.nodes;
    truncated ||= result.truncated;
    return { slot, plan: result.candidates[0] ?? null };
  });
  results.sort((a, b) => (a.plan?.moves.length ?? Infinity) - (b.plan?.moves.length ?? Infinity));
  return { options: results, depth, nodes, truncated };
}
