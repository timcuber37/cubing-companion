/** Cross and a named pair together, without a mandatory cross-first boundary. */
import type { CubeState, Face } from "@cubing-companion/engine";
import { GEOMETRY, type Slot } from "@cubing-companion/analysis";
import { enumerateF2LInsertion } from "./f2l.ts";
import type { SearchOptions, SearchResult } from "./types.ts";

export const MAX_XCROSS_DEPTH = 11;

/**
 * The insertion search already supports this goal: require the cross and target pair, with no
 * other slots to preserve. Its pair-distance bound also prunes positions that the cross-only
 * heuristic used to explore. Results remain shortest first, in the normalised frame.
 */
export function enumerateXcross(
  state: CubeState,
  crossFace: Face,
  slot: Slot,
  options: SearchOptions = {},
): SearchResult {
  return enumerateF2LInsertion(state, crossFace, slot, {
    ...options,
    maxSolutions: options.maxSolutions ?? 50,
    maxDepth: Math.min(options.maxDepth ?? MAX_XCROSS_DEPTH, MAX_XCROSS_DEPTH),
    preserve: [],
  });
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
