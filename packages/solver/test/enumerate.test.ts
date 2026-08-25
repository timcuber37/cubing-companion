/**
 * Enumeration tests.
 *
 * Two properties matter more than any specific number, because A5 and B3 both depend on them:
 * every candidate must genuinely work, and the set at a given length must be *complete* rather
 * than a sample. A ranking model trained on an incomplete candidate set learns from negatives
 * that were never really alternatives.
 */
import { describe, expect, it } from "vitest";
import fc from "fast-check";
import {
  applyMoveInPlace,
  applyMoves,
  CubeState,
  Face,
  invertMove,
  parseMoves,
  serializeMoves,
  type Move,
} from "@cubing-companion/engine";
import { GEOMETRY, type Slot } from "@cubing-companion/analysis";
import { enumerateCross, optimalCrossLength, solveCross } from "../src/cross.ts";
import { enumerateAllXcrosses, enumerateXcross } from "../src/xcross.ts";
import { crossDistance } from "../src/crossTable.ts";
import { allowed, SEARCH_MOVES } from "../src/moves.ts";

const moveArb: fc.Arbitrary<Move> = fc.record({
  family: fc.constantFrom("U", "D", "L", "R", "F", "B"),
  amount: fc.constantFrom<1 | 2 | -1>(1, 2, -1),
});

const scrambled = (alg: string) => applyMoves(CubeState.solved(), parseMoves(alg));

const SCRAMBLES = [
  "D2 F R2 U L B2 R F2 D L U2 B",
  "R U2 F D L2 B R2 U F2 L D2 B",
  "B2 L D R2 U F L2 B U2 R D F",
  "F R2 D B L U2 R F2 L2 D U B2",
];

const crossDone = (state: CubeState, face: Face) =>
  GEOMETRY[face]!.crossEdges.every(
    (e) => state.ep[e] === e && state.eo[e] === 0,
  );

const slotDone = (state: CubeState, slot: Slot) =>
  state.cp[slot.corner] === slot.corner &&
  state.co[slot.corner] === 0 &&
  state.ep[slot.edge] === slot.edge &&
  state.eo[slot.edge] === 0;

describe("cross candidates", () => {
  it("all actually solve the cross", () => {
    fc.assert(
      fc.property(fc.array(moveArb, { minLength: 4, maxLength: 14 }), (setup) => {
        const state = applyMoves(CubeState.solved(), setup);
        const { candidates } = enumerateCross(state, Face.D, { maxSolutions: 20 });
        expect(candidates.length).toBeGreaterThan(0);
        for (const candidate of candidates) {
          expect(crossDone(applyMoves(state, candidate.moves), Face.D)).toBe(true);
        }
      }),
      { numRuns: 120 },
    );
  });

  it("never returns anything shorter than the table says is possible", () => {
    fc.assert(
      fc.property(fc.array(moveArb, { minLength: 4, maxLength: 14 }), (setup) => {
        const state = applyMoves(CubeState.solved(), setup);
        const optimal = crossDistance(state, Face.D);
        const { candidates } = enumerateCross(state, Face.D, { maxSolutions: 10 });
        for (const candidate of candidates) {
          expect(candidate.length).toBeGreaterThanOrEqual(optimal);
        }
      }),
      { numRuns: 120 },
    );
  });

  it("finds every optimal solution, not merely some", () => {
    // Compared against an unpruned brute-force sweep of every sequence of the optimal length.
    // If the move-ordering prunings were unsound, this is where it would show.
    //
    // Restricted to positions with a shallow optimum, because brute force is 15^d: at depth 5
    // that is 760k sequences, and at depth 7 it is 170 million. The pruning being checked does
    // not vary with depth, so a shallow case tests it just as well.
    const shallow: CubeState[] = [];
    for (let seed = 0; shallow.length < 3 && seed < 400; seed++) {
      const setup: Move[] = [];
      let value = seed * 2654435761;
      for (let i = 0; i < 6; i++) {
        value = (value * 1103515245 + 12345) & 0x7fffffff;
        setup.push(SEARCH_MOVES[value % SEARCH_MOVES.length]!);
      }
      const state = applyMoves(CubeState.solved(), setup);
      const distance = crossDistance(state, Face.D);
      if (distance >= 3 && distance <= 5) shallow.push(state);
    }
    expect(shallow.length).toBeGreaterThan(0);

    for (const state of shallow) {
      const optimal = crossDistance(state, Face.D);
      const { candidates } = enumerateCross(state, Face.D, { maxSolutions: 5000 });

      // In-place walk: apply on the way down, undo on the way back, so no state is allocated.
      const brute = new Set<string>();
      const working = state.clone();
      const path: Move[] = [];
      const walk = (remaining: number): void => {
        if (remaining === 0) {
          if (crossDone(working, Face.D)) brute.add(serializeMoves(path));
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
      // Every candidate must be a genuine solution brute force also found...
      for (const solution of found) expect([...brute]).toContain(solution);
      // ...and the only ones missing must be the redundant spelling of a commuting pair, which
      // means each brute-force solution has an equivalent among the candidates.
      for (const solution of brute) {
        const moves = parseMoves(solution);
        const canonical = moves.every((move, i) => allowed(move, moves[i - 1]));
        if (canonical) expect(found).toContain(solution);
      }
    }
  });

  it("returns distinct candidates", () => {
    for (const scramble of SCRAMBLES) {
      const { candidates } = enumerateCross(scrambled(scramble), Face.D, {
        maxExtra: 1,
        maxSolutions: 300,
      });
      const texts = candidates.map((c) => serializeMoves(c.moves));
      expect(new Set(texts).size, scramble).toBe(texts.length);
    }
  });

  it("returns candidates shortest first", () => {
    const { candidates } = enumerateCross(scrambled(SCRAMBLES[0]!), Face.D, {
      maxExtra: 2,
      maxSolutions: 300,
    });
    for (let i = 1; i < candidates.length; i++) {
      expect(candidates[i]!.length).toBeGreaterThanOrEqual(candidates[i - 1]!.length);
    }
  });

  it("offers more alternatives as maxExtra rises", () => {
    // The point of the knob: a coach wants options, not just the optimum.
    const state = scrambled(SCRAMBLES[0]!);
    const optimalOnly = enumerateCross(state, Face.D, { maxSolutions: 1000 });
    const looser = enumerateCross(state, Face.D, { maxExtra: 1, maxSolutions: 1000 });
    expect(looser.candidates.length).toBeGreaterThan(optimalOnly.candidates.length);
    expect(looser.optimal).toBe(optimalOnly.optimal);
    expect(Math.max(...looser.candidates.map((c) => c.overOptimal))).toBeLessThanOrEqual(1);
  });

  it("reports an already-solved cross as zero moves", () => {
    const result = enumerateCross(CubeState.solved(), Face.D);
    expect(result.optimal).toBe(0);
    expect(result.candidates[0]!.moves).toEqual([]);
    expect(solveCross(CubeState.solved(), Face.D)).toBeNull();
  });

  it("agrees with the table on optimal length", () => {
    for (const scramble of SCRAMBLES) {
      const state = scrambled(scramble);
      expect(optimalCrossLength(state, Face.D)).toBe(crossDistance(state, Face.D));
    }
  });

  it("works for any cross colour", () => {
    const state = scrambled(SCRAMBLES[0]!);
    for (const face of [Face.U, Face.L, Face.F, Face.R, Face.B, Face.D]) {
      const { candidates, optimal } = enumerateCross(state, face, { maxSolutions: 5 });
      expect(optimal, `face ${face}`).toBeGreaterThanOrEqual(0);
      for (const candidate of candidates) {
        expect(crossDone(applyMoves(state, candidate.moves), face), `face ${face}`).toBe(true);
      }
    }
  });
});

describe("xcross candidates", () => {
  const slot = GEOMETRY[Face.D]!.slots.find((s) => s.edge === 8)!; // FR

  it("all solve the cross and the named pair", () => {
    for (const scramble of SCRAMBLES) {
      const state = scrambled(scramble);
      const { candidates, optimal } = enumerateXcross(state, Face.D, slot, {
        maxSolutions: 10,
      });
      expect(candidates.length, scramble).toBeGreaterThan(0);
      expect(optimal, scramble).toBeGreaterThan(0);
      for (const candidate of candidates) {
        const after = applyMoves(state, candidate.moves);
        expect(crossDone(after, Face.D), scramble).toBe(true);
        expect(slotDone(after, slot), scramble).toBe(true);
      }
    }
  });

  it("is never shorter than the cross alone", () => {
    // The admissibility argument the pruning rests on, checked rather than assumed.
    for (const scramble of SCRAMBLES) {
      const state = scrambled(scramble);
      const { optimal } = enumerateXcross(state, Face.D, slot, { maxSolutions: 1 });
      expect(optimal, scramble).toBeGreaterThanOrEqual(crossDistance(state, Face.D));
    }
  });

  it("names the slot it filled", () => {
    const { candidates } = enumerateXcross(scrambled(SCRAMBLES[0]!), Face.D, slot, {
      maxSolutions: 3,
    });
    for (const candidate of candidates) expect(candidate.slot).toBe("FR");
  });

  it("returns distinct candidates, shortest first", () => {
    const { candidates } = enumerateXcross(scrambled(SCRAMBLES[0]!), Face.D, slot, {
      maxSolutions: 30,
    });
    const texts = candidates.map((c) => serializeMoves(c.moves));
    expect(new Set(texts).size).toBe(texts.length);
    for (let i = 1; i < candidates.length; i++) {
      expect(candidates[i]!.length).toBeGreaterThanOrEqual(candidates[i - 1]!.length);
    }
  });

  it("marks every optimal candidate as zero over optimal", () => {
    const { candidates, optimal } = enumerateXcross(
      scrambled(SCRAMBLES[0]!),
      Face.D,
      slot,
      { maxSolutions: 20 },
    );
    for (const candidate of candidates) {
      expect(candidate.length).toBe(optimal);
      expect(candidate.overOptimal).toBe(0);
    }
  });

  it("covers all four slots", () => {
    // What a planner needs: which pair is cheapest to take along with the cross.
    const results = enumerateAllXcrosses(scrambled(SCRAMBLES[0]!), Face.D, {
      maxSolutions: 2,
    });
    expect(results).toHaveLength(4);
    const slots = new Set(results.flatMap((r) => r.candidates.map((c) => c.slot)));
    expect(slots.size).toBe(4);
    for (const result of results) expect(result.optimal).toBeGreaterThan(0);
  });

  it("ignores how the cube is being held", () => {
    const state = scrambled(SCRAMBLES[0]!);
    const base = enumerateXcross(state, Face.D, slot, { maxSolutions: 1 }).optimal;
    for (const rotation of ["y", "x2", "z'"]) {
      const rotated = applyMoves(state, parseMoves(rotation));
      expect(
        enumerateXcross(rotated, Face.D, slot, { maxSolutions: 1 }).optimal,
        rotation,
      ).toBe(base);
    }
  });

  it("stays interactive", () => {
    // Not a benchmark, a guard: if this ever takes seconds, the pruning has broken.
    for (const scramble of SCRAMBLES) {
      const { stats } = enumerateXcross(scrambled(scramble), Face.D, slot, {
        maxSolutions: 5,
      });
      expect(stats.elapsedMs, scramble).toBeLessThan(2000);
    }
  });
});

describe("move pruning is sound", () => {
  it("rejects only redundant spellings", () => {
    // Same face twice, and the non-canonical order of a commuting pair. Both have an
    // equivalent the search does keep, which is why nothing is lost.
    const R: Move = { family: "R", amount: 1 };
    const R2: Move = { family: "R", amount: 2 };
    const L: Move = { family: "L", amount: 1 };
    const U: Move = { family: "U", amount: 1 };

    expect(allowed(R, undefined)).toBe(true);
    expect(allowed(R2, R)).toBe(false); // same face
    expect(allowed(U, R)).toBe(true); // unrelated faces
    // Exactly one order of the commuting pair survives.
    expect(allowed(L, R) !== allowed(R, L)).toBe(true);
  });
});
