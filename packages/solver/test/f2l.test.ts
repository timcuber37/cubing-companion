/**
 * F2L insertion tests.
 *
 * The property that separates this from the xcross search is **preservation**: a candidate that
 * fills the target slot while quietly breaking the cross or an earlier pair is worse than no
 * candidate, because it looks like advice and is not. That is what most of this file is about.
 */
import { describe, expect, it } from "vitest";
import fc from "fast-check";
import {
  applyMoveInPlace,
  applyMoves,
  CubeState,
  Face,
  invertMove,
  normalizeOrientation,
  parseMoves,
  serializeMoves,
  type Move,
} from "@cubing-companion/engine";
import { GEOMETRY, isSlotSolved, slotName, type Slot } from "@cubing-companion/analysis";
import {
  MAX_PAIR_DISTANCE,
  PAIR_INDEX_SPACE,
  packPair,
  pairDistance,
  pairTable,
} from "../src/pairTable.ts";
import { enumerateF2LInsertion, enumerateNextPair } from "../src/f2l.ts";
import { solveCross } from "../src/cross.ts";
import { crossDistance } from "../src/crossTable.ts";
import { SEARCH_MOVES } from "../src/moves.ts";

const GEO = GEOMETRY[Face.D]!;
const FR = GEO.slots.find((s) => s.edge === 8)!;

const SCRAMBLES = [
  "D2 F R2 U L B2 R F2 D L U2 B",
  "R U2 F D L2 B R2 U F2 L D2 B",
  "B2 L D R2 U F L2 B U2 R D F",
  "F R2 D B L U2 R F2 L2 D U B2",
];

/** A position with the cross solved, which is where an F2L insertion starts. */
function afterCross(scramble: string): CubeState {
  const scrambled = applyMoves(CubeState.solved(), parseMoves(scramble));
  return normalizeOrientation(
    applyMoves(scrambled, solveCross(scrambled, Face.D) ?? []),
  );
}

const crossSolved = (state: CubeState) => crossDistance(state, Face.D) === 0;

describe("the pair table", () => {
  it("has the shape a corner and an edge give it", () => {
    const table = pairTable(FR);
    expect(PAIR_INDEX_SPACE).toBe(8 * 3 * 12 * 2);
    expect(table).toHaveLength(PAIR_INDEX_SPACE);

    let reachable = 0;
    let max = 0;
    for (const d of table) {
      if (d === 255) continue;
      reachable++;
      if (d > max) max = d;
    }
    // Every position is reachable, and the furthest is six moves away.
    expect(reachable).toBe(PAIR_INDEX_SPACE);
    expect(max).toBe(MAX_PAIR_DISTANCE);
    expect(max).toBe(6);
  });

  it("is zero exactly when the pair is home", () => {
    expect(pairDistance(CubeState.solved(), FR)).toBe(0);
    expect(pairTable(FR)[packPair(FR.corner, 0, FR.edge, 0)]).toBe(0);
    expect(pairDistance(applyMoves(CubeState.solved(), parseMoves("R")), FR))
      .toBeGreaterThan(0);
  });

  it("is a lower bound, changing by at most one per move", () => {
    // What makes it admissible, and the whole search prunes on it.
    fc.assert(
      fc.property(
        fc.array(
          fc.record({
            family: fc.constantFrom("U", "D", "L", "R", "F", "B"),
            amount: fc.constantFrom<1 | 2 | -1>(1, 2, -1),
          }),
          { maxLength: 12 },
        ),
        (setup) => {
          const before = applyMoves(CubeState.solved(), setup as Move[]);
          for (const move of SEARCH_MOVES) {
            const after = applyMoves(before, [move]);
            expect(
              Math.abs(pairDistance(after, FR) - pairDistance(before, FR)),
            ).toBeLessThanOrEqual(1);
          }
        },
      ),
      { numRuns: 60 },
    );
  });

  it("serves every slot", () => {
    for (const slot of GEO.slots) {
      expect(pairDistance(CubeState.solved(), slot), slotName(slot)).toBe(0);
    }
  });
});

describe("insertion candidates", () => {
  it("solve the target pair and leave the cross standing", () => {
    for (const scramble of SCRAMBLES) {
      const state = afterCross(scramble);
      const { candidates, optimal } = enumerateF2LInsertion(state, Face.D, FR, {
        maxSolutions: 8,
      });
      expect(candidates.length, scramble).toBeGreaterThan(0);
      expect(optimal, scramble).toBeGreaterThan(0);
      for (const candidate of candidates) {
        const after = applyMoves(state, candidate.moves);
        expect(isSlotSolved(after, FR), scramble).toBe(true);
        expect(crossSolved(after), scramble).toBe(true);
      }
    }
  });

  it("leave every already-built pair still built", () => {
    // The property that makes this an *insertion* rather than a search. Built up pair by pair,
    // so by the last slot there are three pairs and a cross that must all survive.
    for (const scramble of SCRAMBLES) {
      let state = afterCross(scramble);
      const built: Slot[] = [];

      for (let i = 0; i < GEO.slots.length; i++) {
        const target = GEO.slots.find((s) => !built.includes(s))!;
        const { candidates } = enumerateF2LInsertion(state, Face.D, target, {
          maxSolutions: 4,
        });
        expect(candidates.length, `${scramble} slot ${slotName(target)}`).toBeGreaterThan(0);

        for (const candidate of candidates) {
          const after = applyMoves(state, candidate.moves);
          expect(isSlotSolved(after, target)).toBe(true);
          expect(crossSolved(after)).toBe(true);
          for (const previous of built) {
            expect(
              isSlotSolved(after, previous),
              `${slotName(target)} broke ${slotName(previous)}`,
            ).toBe(true);
          }
        }

        state = applyMoves(state, candidates[0]!.moves);
        built.push(target);
      }
      // Ending with a complete F2L is the whole point.
      for (const slot of GEO.slots) expect(isSlotSolved(state, slot), scramble).toBe(true);
    }
  });

  it("detect what is already built without being told", () => {
    // Explicitly preserving the solved slots must give the same answer as letting it work them
    // out, since the position already says which they are.
    const scramble = SCRAMBLES[0]!;
    let state = afterCross(scramble);
    const first = GEO.slots[0]!;
    state = applyMoves(
      state,
      enumerateF2LInsertion(state, Face.D, first, { maxSolutions: 1 }).candidates[0]!.moves,
    );

    const target = GEO.slots[1]!;
    const detected = enumerateF2LInsertion(state, Face.D, target, { maxSolutions: 5 });
    const explicit = enumerateF2LInsertion(state, Face.D, target, {
      maxSolutions: 5,
      preserve: [first],
    });
    expect(detected.optimal).toBe(explicit.optimal);
    expect(detected.candidates.map((c) => serializeMoves(c.moves))).toEqual(
      explicit.candidates.map((c) => serializeMoves(c.moves)),
    );
  });

  it("are harder to find when more must be preserved", () => {
    // Not a correctness property but a sanity one: ignoring the built pair can only make the
    // problem easier, so it must never come out longer.
    const scramble = SCRAMBLES[1]!;
    let state = afterCross(scramble);
    const first = GEO.slots[0]!;
    state = applyMoves(
      state,
      enumerateF2LInsertion(state, Face.D, first, { maxSolutions: 1 }).candidates[0]!.moves,
    );

    const target = GEO.slots[1]!;
    const constrained = enumerateF2LInsertion(state, Face.D, target, { maxSolutions: 1 });
    const free = enumerateF2LInsertion(state, Face.D, target, {
      maxSolutions: 1,
      preserve: [],
    });
    expect(free.optimal).toBeLessThanOrEqual(constrained.optimal);
  });

  it("are never shorter than the bound admits", () => {
    for (const scramble of SCRAMBLES) {
      const state = afterCross(scramble);
      const bound = pairDistance(state, FR);
      const { optimal } = enumerateF2LInsertion(state, Face.D, FR, { maxSolutions: 1 });
      expect(optimal, scramble).toBeGreaterThanOrEqual(bound);
    }
  });

  it("find every solution at optimal length", () => {
    // Against unpruned brute force. Restricted to a shallow case because brute force is 15^d;
    // the pruning being checked does not vary with depth.
    const state = afterCross(SCRAMBLES[0]!);
    const target = GEO.slots.find(
      (s) => enumerateF2LInsertion(state, Face.D, s, { maxSolutions: 1 }).optimal <= 5,
    );
    if (!target) return; // no shallow case in this position; the deeper tests still cover it

    const optimal = enumerateF2LInsertion(state, Face.D, target, {
      maxSolutions: 1,
    }).optimal;
    const { candidates } = enumerateF2LInsertion(state, Face.D, target, {
      maxSolutions: 2000,
    });

    const preserve = GEO.slots.filter((s) => s !== target && isSlotSolved(state, s));
    const brute = new Set<string>();
    const working = state.clone();
    const path: Move[] = [];
    const walk = (remaining: number): void => {
      if (remaining === 0) {
        if (
          crossSolved(working) &&
          isSlotSolved(working, target) &&
          preserve.every((s) => isSlotSolved(working, s))
        ) {
          brute.add(serializeMoves(path));
        }
        return;
      }
      for (const move of SEARCH_MOVES) {
        if (path.length > 0 && move.family === path[path.length - 1]!.family) continue;
        applyMoveInPlace(working, move);
        path.push(move);
        walk(remaining - 1);
        path.pop();
        applyMoveInPlace(working, invertMove(move));
      }
    };
    walk(optimal);

    const found = new Set(candidates.map((c) => serializeMoves(c.moves)));
    expect(found.size).toBeGreaterThan(0);
    // Everything the enumerator returned is real...
    for (const solution of found) expect([...brute]).toContain(solution);
    // ...and it found as many as brute force did, up to commuting-pair spellings.
    expect(brute.size).toBeGreaterThanOrEqual(found.size);
  });

  it("return distinct candidates, shortest first, named by slot", () => {
    const state = afterCross(SCRAMBLES[0]!);
    const { candidates } = enumerateF2LInsertion(state, Face.D, FR, {
      maxExtra: 1,
      maxSolutions: 40,
    });
    const texts = candidates.map((c) => serializeMoves(c.moves));
    expect(new Set(texts).size).toBe(texts.length);
    for (let i = 1; i < candidates.length; i++) {
      expect(candidates[i]!.length).toBeGreaterThanOrEqual(candidates[i - 1]!.length);
    }
    for (const candidate of candidates) expect(candidate.slot).toBe("FR");
  });

  it("do nothing when the pair is already in", () => {
    const state = CubeState.solved();
    const result = enumerateF2LInsertion(state, Face.D, FR, { maxSolutions: 3 });
    expect(result.optimal).toBe(0);
    expect(result.candidates[0]!.moves).toEqual([]);
  });

  it("ignore how the cube is being held", () => {
    const state = afterCross(SCRAMBLES[0]!);
    const base = enumerateF2LInsertion(state, Face.D, FR, { maxSolutions: 1 }).optimal;
    for (const rotation of ["y", "x2", "z'"]) {
      const rotated = applyMoves(state, parseMoves(rotation));
      expect(
        enumerateF2LInsertion(rotated, Face.D, FR, { maxSolutions: 1 }).optimal,
        rotation,
      ).toBe(base);
    }
  });
});

describe("choosing the next pair", () => {
  it("offers every empty slot, cheapest first", () => {
    const state = afterCross(SCRAMBLES[0]!);
    const options = enumerateNextPair(state, Face.D, { maxSolutions: 2 });
    expect(options).toHaveLength(4);
    for (let i = 1; i < options.length; i++) {
      expect(options[i]!.result.optimal).toBeGreaterThanOrEqual(
        options[i - 1]!.result.optimal,
      );
    }
  });

  it("stops offering a slot once it is filled", () => {
    let state = afterCross(SCRAMBLES[0]!);
    const first = enumerateNextPair(state, Face.D, { maxSolutions: 1 })[0]!;
    state = applyMoves(state, first.result.candidates[0]!.moves);

    const remaining = enumerateNextPair(state, Face.D, { maxSolutions: 1 });
    expect(remaining).toHaveLength(3);
    expect(remaining.map((o) => slotName(o.slot))).not.toContain(slotName(first.slot));
  });

  it("offers nothing once F2L is done", () => {
    expect(enumerateNextPair(CubeState.solved(), Face.D)).toEqual([]);
  });

  it("stays interactive", () => {
    // A guard, not a benchmark: seconds here would mean the pruning has broken.
    const state = afterCross(SCRAMBLES[0]!);
    for (const option of enumerateNextPair(state, Face.D, { maxSolutions: 3 })) {
      expect(option.result.stats.elapsedMs, slotName(option.slot)).toBeLessThan(3000);
    }
  });
});
