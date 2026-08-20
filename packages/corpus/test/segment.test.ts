import { describe, expect, it } from "vitest";
import { labelsOf, segmentSolve, splitAnnotatedLines } from "../src/segment.ts";
import { Method, Phase, type RawSolve } from "../src/types.ts";

/** Max Park's 3.13 WR — a real solve, used because it exercises xxcross and OLL(CP). */
const MAX_PARK: RawSolve = {
  id: 9155,
  url: "https://reco.nz/solve/9155",
  solver: "Max Park",
  solverSlug: "Max_Park",
  timeSeconds: 3.13,
  event: "3x3",
  date: "2023-06-11",
  competition: "Pride in Long Beach 2023",
  tags: ["WR"],
  reconstructor: "BlueAcidball",
  reconstructorSlug: "BlueAcidball",
  hardware: "X-Man Tornado V3",
  scramble: "D U F2' L2 U' B2 F2 D L2 U R' F' D R' F' U L D' F' D R2",
  solution: [
    "x2 // inspection",
    "R' D D R' D L' U L D R' U' R D // xxcross",
    "L U' L' // 3rd pair",
    "U' R U R' d R' U' R // 4th pair",
    "r' U' R U' R' U U r // OLL(CP)",
    "U // AUF",
  ].join("\n"),
  stats: null,
};

const withSolution = (solution: string, scramble = MAX_PARK.scramble): RawSolve => ({
  ...MAX_PARK,
  solution,
  scramble,
});

describe("splitting annotated solutions", () => {
  it("separates moves from labels", () => {
    expect(splitAnnotatedLines("R U // cross\nF2 // 1st pair")).toEqual([
      { moveText: "R U", label: "cross" },
      { moveText: "F2", label: "1st pair" },
    ]);
  });

  it("handles unlabelled and blank lines", () => {
    expect(splitAnnotatedLines("R U\n\nF2 // pair")).toEqual([
      { moveText: "R U", label: "" },
      { moveText: "F2", label: "pair" },
    ]);
  });

  it("collects labels in order", () => {
    expect(labelsOf(MAX_PARK.solution)).toEqual([
      "inspection",
      "xxcross",
      "3rd pair",
      "4th pair",
      "OLL(CP)",
      "AUF",
    ]);
  });
});

describe("segmenting a solve", () => {
  it("verifies and segments a real reconstruction", () => {
    const { record, error } = segmentSolve(MAX_PARK);
    expect(error).toBeNull();
    expect(record).not.toBeNull();
    expect(record!.verified).toBe(true);
    expect(record!.method).toBe(Method.CFOP);
    expect(record!.segments).toHaveLength(6);
  });

  it("counts turns and rotations separately", () => {
    const { record } = segmentSolve(MAX_PARK);
    const inspection = record!.segments[0]!;
    expect(inspection.rawLabel).toBe("inspection");
    expect(inspection.rotations).toBe(1); // x2
    expect(inspection.turns).toBe(0); // rotations are not turns

    // The published STM for this solve is 33, all non-rotation moves.
    expect(record!.totalTurns).toBe(33);
    expect(record!.totalRotations).toBe(1);
  });

  it("marks an xxcross as merged across three phases", () => {
    const { record } = segmentSolve(MAX_PARK);
    const xxcross = record!.segments.find((s) => s.rawLabel === "xxcross")!;
    expect(xxcross.merged).toBe(true);
    expect(xxcross.phases).toEqual([Phase.Cross, Phase.F2L1, Phase.F2L2]);
    // A merged solve cannot contribute to per-phase distributions.
    expect(record!.quality).toBe("merged");
  });

  it("calls a fully-annotated solve clean", () => {
    const { record } = segmentSolve(
      withSolution(
        [
          "x2 // inspection",
          "R' D D R' D L' U L D // cross",
          "R' U' R D // 1st pair",
          "L U' L' // 2nd pair",
          "U' R U R' // 3rd pair",
          "d R' U' R // 4th pair",
          "r' U' R U' R' U U r // OLL",
          "U // PLL",
        ].join("\n"),
      ),
    );
    // Same moves in the same order as the real solve, just annotated phase by phase
    // instead of as an xxcross — so it still verifies, and now every phase stands alone.
    expect(record).not.toBeNull();
    expect(record!.verified).toBe(true);
    expect(record!.quality).toBe("clean");
    expect(record!.segments.every((s) => !s.merged)).toBe(true);
  });

  it("rejects a solve whose moves do not solve the scramble", () => {
    const { record, error } = segmentSolve(
      withSolution("R U R' // cross\nU // OLL\nU // PLL\nR // 1st pair"),
    );
    expect(record).toBeNull();
    expect(error?.reason).toBe("does-not-solve");
  });

  it("rejects unparseable notation with a usable message", () => {
    const { record, error } = segmentSolve(withSolution("R U (Q' // cross"));
    expect(record).toBeNull();
    expect(error?.reason).toBe("unparseable-notation");
    expect(error?.detail).toBeTruthy();
  });

  it("repairs a missing space after a prime, and records that it did", () => {
    // Real typo, from Mats Valk's 7.13 (solve 195): `y' U'F R' F' R`. A prime always
    // terminates a move and no family starts with `'`, so `U' F` is the only reading.
    const squashed = MAX_PARK.solution.replace("U' R U R' d", "U'R U R' d");
    const { record, error } = segmentSolve(withSolution(squashed));
    expect(error).toBeNull();
    expect(record!.repaired).toBe(true);
    expect(record!.verified).toBe(true);
    // The repair must not change the solve.
    expect(record!.totalTurns).toBe(33);
  });

  it("leaves untouched solves unmarked", () => {
    expect(segmentSolve(MAX_PARK).record!.repaired).toBe(false);
  });

  it("does not let a repair rescue a solve that still does not solve", () => {
    // Repair makes it parseable; verification must still reject it.
    const { record, error } = segmentSolve(
      withSolution("R'U R // cross\nU // OLL\nU // PLL\nR // 1st pair"),
    );
    expect(record).toBeNull();
    expect(error?.reason).toBe("does-not-solve");
  });

  it("reports a malformed scramble distinctly from a malformed solution", () => {
    const { error } = segmentSolve(withSolution("R U R'", "R U %ZZ"));
    expect(error?.reason).toBe("unparseable-notation");
    expect(error?.detail).toMatch(/^scramble:/);
  });

  it("surfaces unknown labels", () => {
    const { unknownLabels } = segmentSolve(
      withSolution(MAX_PARK.solution.replace("// AUF", "// wibble")),
    );
    expect(unknownLabels).toContain("wibble");
  });

  it("rejects a solution with no moves at all", () => {
    const { record, error } = segmentSolve(withSolution("// just a comment"));
    expect(record).toBeNull();
    expect(error?.reason).toBe("no-segments");
  });
});
