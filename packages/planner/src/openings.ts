/** Cross-first and joint cross/pair plans, compared at the same two-pair goal. */
import { applyMoves, makeMove, normalizeOrientation, type CubeState, type Face, type Move } from "@cubing-companion/engine";
import { GEOMETRY, isSlotSolved, slotName } from "@cubing-companion/analysis";
import { enumerateCross, enumerateF2LInsertion, pairDistance } from "@cubing-companion/solver";
import { continueF2L } from "./lookahead.ts";
import { slotColours } from "./colours.ts";

export interface OpeningStep {
  readonly label: string;
  readonly moves: readonly Move[];
}

export interface Opening {
  readonly moves: readonly Move[];
  readonly steps: readonly OpeningStep[];
  readonly solvedSlots: readonly string[];
}

interface Seed {
  readonly state: CubeState;
  readonly moves: readonly Move[];
  readonly steps: OpeningStep[];
}

/** Cancelling a boundary can remove an intermediate milestone, so label the result jointly. */
function combineTurns(moves: readonly Move[]): Move[] {
  const combined: Move[] = [];
  for (const move of moves) {
    const previous = combined[combined.length - 1];
    if (previous?.family !== move.family) combined.push(move);
    else {
      combined.pop();
      const merged = makeMove(move.family, previous.amount + move.amount);
      if (merged) combined.push(merged);
    }
  }
  return combined;
}

export function searchOpenings(
  raw: CubeState,
  crossFace: Face,
  xcrosses: readonly { readonly searchMoves: readonly Move[] }[],
): { crossPlusOne: Opening[]; crossPlusTwo: Opening[] } {
  const state = normalizeOrientation(raw);
  const slots = GEOMETRY[crossFace]!.slots;
  const solved = (position: CubeState) => slots.filter((slot) => isSlotSolved(position, slot));
  const crossPlusOne: Opening[] = [];
  const crossPlusTwo: Opening[] = [];
  const collect = (moves: readonly Move[], steps: readonly OpeningStep[], after: CubeState) => {
    const built = solved(after);
    const solvedSlots = built.map(slotName);
    const combined = combineTurns(moves);
    const opening = combined.length < moves.length ? {
      moves: combined,
      steps: [{ label: `cross + ${built.map(slotColours).join(" + ")}`, moves: combined }],
      solvedSlots,
    } : { moves, steps, solvedSlots };
    if (solvedSlots.length >= 1) crossPlusOne.push(opening);
    if (solvedSlots.length >= 2) crossPlusTwo.push(opening);
  };

  const cross = enumerateCross(state, crossFace, {
    maxExtra: 1,
    maxSolutions: 24,
    maxSolutionsPerDepth: 12,
    maxNodes: 100_000,
  });
  const seeds = new Map<string, Seed>();
  for (const moves of [...cross.candidates.map((c) => c.moves), ...xcrosses.map((c) => c.searchMoves)]) {
    const after = applyMoves(state, moves);
    const built = solved(after);
    const label = built.length === 0 ? "cross" : `cross + ${built.map(slotColours).join(" + ")}`;
    const previous = seeds.get(after.key());
    if (!previous || previous.moves.length > moves.length) {
      seeds.set(after.key(), { state: after, moves, steps: [{ label, moves }] });
    }
    collect(moves, [{ label, moves }], after);
  }
  const estimate = (seed: { state: CubeState; moves: readonly Move[] }) => {
    const needed = Math.max(0, 2 - solved(seed.state).length);
    const distances = slots.filter((slot) => !isSlotSolved(seed.state, slot))
      .map((slot) => pairDistance(seed.state, slot)).sort((a, b) => a - b);
    return seed.moves.length + (needed === 0 ? 0 : distances[needed - 1]!);
  };
  // Reserve seeds from each cross length and each built-slot set. A crowd of optimal crosses
  // must not consume every place before a +1 cross or an x-cross can be explored.
  const groups = new Map<string, Seed[]>();
  for (const seed of [...seeds.values()].sort((a, b) => estimate(a) - estimate(b))) {
    const key = `${seed.moves.length}:${solved(seed.state).map(slotName).join(",")}`;
    const group = groups.get(key) ?? [];
    group.push(seed);
    groups.set(key, group);
  }
  const selected = [...groups.values()].map((group) => group.shift()!).slice(0, 8);
  for (const seed of [...groups.values()].flat().sort((a, b) => estimate(a) - estimate(b))) {
    if (selected.length >= 8) break;
    selected.push(seed);
  }
  for (const seed of selected) {
    const result = continueF2L(seed.state, crossFace, 2, { maxNodes: 300_000 });
    for (const continuation of [...result.prefixes, ...result.candidates]) {
      let after = seed.state;
      let moves = [...seed.moves];
      const steps = [...seed.steps];
      for (const step of continuation.steps) {
        after = applyMoves(after, step.moves);
        moves = [...moves, ...step.moves];
        const slot = slots.find((s) => slotName(s) === step.slot)!;
        steps.push({ label: slotColours(slot), moves: step.moves });
        collect(moves, [...steps], after);
      }
    }
  }

  // Search joint two-pair goals too. This can find an XX-cross that never passes through any
  // retained cross or x-cross seed. Each of the six slot combinations receives an equal budget.
  for (let first = 0; first < slots.length; first++) {
    for (let second = first + 1; second < slots.length; second++) {
      const pair = [slots[first]!, slots[second]!] as const;
      const result = enumerateF2LInsertion(state, crossFace, pair[0], {
        preserve: [pair[1]],
        maxDepth: 11,
        maxSolutions: 3,
        maxNodes: 50_000,
      });
      for (const candidate of result.candidates) {
        collect(candidate.moves, [{ label: `cross + ${pair.map(slotColours).join(" + ")}`, moves: candidate.moves }],
          applyMoves(state, candidate.moves));
      }
    }
  }
  // A route can solve extra pairs incidentally. Count the actual result, and deduplicate identical
  // move sequences so a joint solution found for two target slots is shown only once.
  const unique = (openings: Opening[]) => [...new Map(openings.map((opening) => [
    opening.moves.map((move) => `${move.family}${move.amount}`).join(" "), opening,
  ])).values()];
  return { crossPlusOne: unique(crossPlusOne), crossPlusTwo: unique(crossPlusTwo) };
}
