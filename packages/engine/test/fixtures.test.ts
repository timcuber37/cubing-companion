/**
 * Verification against real reconstructions.
 *
 * `PLAN.md` requires that every solve in the corpus verifies against the engine
 * (parse -> apply -> solved?). This is that check at A0 scale: a checked-in sample of
 * reco.nz solves, exercising notation the community actually writes rather than notation
 * we thought to invent. The B1 crawl reuses this predicate at corpus scale.
 *
 * Data: https://reco.nz, refreshed via `npm run fetch-fixtures -w @cubing-companion/engine`.
 * Each fixture credits its solver and reconstructor.
 */
import { describe, expect, it } from "vitest";
import { Alg, Move as AlgMove } from "cubing/alg";
import corpus from "./fixtures/reconstructions.json" with { type: "json" };
import { parseMoves, serializeMoves } from "../src/notation.ts";
import { invertMoves, stateAfter } from "../src/moves.ts";
import { isSolvedIgnoringOrientation } from "../src/predicates.ts";

const { fixtures } = corpus;

describe("reco.nz reconstructions", () => {
  it("has a sample to check", () => {
    expect(fixtures.length).toBeGreaterThanOrEqual(15);
  });

  it.each(fixtures.map((f) => [`${f.id} — ${f.title}`, f] as const))(
    "verifies %s",
    (_label, fixture) => {
      const moves = [
        ...parseMoves(fixture.scramble),
        ...parseMoves(fixture.solution),
      ];
      const final = stateAfter(moves);

      // A solve legitimately ends rotated — many contain x2 in inspection — so the
      // standard-orientation check would reject valid solves here.
      expect(isSolvedIgnoringOrientation(final)).toBe(true);
    },
  );

  it("does not verify solves whose solution has been tampered with", () => {
    // Guards against the above passing for a degenerate reason, e.g. a predicate that
    // returns true unconditionally.
    for (const fixture of fixtures.slice(0, 5)) {
      const moves = [
        ...parseMoves(fixture.scramble),
        ...parseMoves(fixture.solution),
        ...parseMoves("R"),
      ];
      expect(isSolvedIgnoringOrientation(stateAfter(moves))).toBe(false);
    }
  });

  it("round-trips every solution through serialization", () => {
    for (const fixture of fixtures) {
      const moves = parseMoves(fixture.solution);
      expect(parseMoves(serializeMoves(moves))).toEqual(moves);
    }
  });

  it("parses every written move, cross-checked against cubing.js and the published STM", () => {
    // Two independent checks on the move count, because "ends solved" can miss a parse
    // error that happens to compensate.
    //
    // On the published figure: for 19 of these 20 solves it equals the written
    // non-rotation count exactly. Solve 2000 is written with uncancelled sequences
    // (`U' U'`, `D D`, even a cancelling `U' U`) giving 67 written moves against a
    // published 59 — the reconstruction records what the solver's hands did, while the
    // stated figure is canonical. Preserving the written form is correct: those are
    // separate finger motions, and A3's TPS and pause metrics depend on them. So the
    // engine must never silently cancel, and the published STM is approximate metadata
    // rather than ground truth — a B1 filtering consideration, not an engine bug.
    const dropped: string[] = [];
    for (const fixture of fixtures) {
      const written = Alg.fromString(fixture.solution).expand();
      const algMoveCount = [...written.childAlgNodes()].filter(
        (n) => n instanceof AlgMove,
      ).length;

      // The engine and cubing.js must agree on how many moves were written.
      expect(parseMoves(fixture.solution).length).toBe(algMoveCount);

      // A reconstruction never writes fewer turns than its canonical count, so falling
      // below it means the parser lost moves.
      const stated = fixture.attribution.match(/([\d.]+) STM/)?.[1];
      if (stated === undefined) continue;
      const turns = parseMoves(fixture.solution).filter(
        (m) => !["x", "y", "z"].includes(m.family),
      ).length;
      if (turns < Number(stated)) {
        dropped.push(`${fixture.id}: parsed ${turns} turns, published ${stated}`);
      }
    }
    expect(dropped).toEqual([]);
  });

  it("undoes a solve by inverting scramble and solution together", () => {
    for (const fixture of fixtures) {
      const full = [
        ...parseMoves(fixture.scramble),
        ...parseMoves(fixture.solution),
      ];
      expect(stateAfter([...full, ...invertMoves(full)]).isSolved()).toBe(true);
    }
  });
});
