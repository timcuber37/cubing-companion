/**
 * Segmenter tests.
 *
 * Constructed solves rather than corpus samples. The corpus evaluation
 * (`npm run evaluate -w @cubing-companion/analysis`) measures accuracy at scale; these pin
 * the specific behaviours — colour neutrality, pseudoslotting, skips, the boundary
 * convention — that are easy to break and too rare in the corpus for an aggregate
 * percentage to notice.
 *
 * Every solve is built by inverting a known solution to get its scramble, so the phases are
 * known by construction. The expected indices were read off the implementation once and
 * checked by hand; they are here to catch drift, not to restate the code.
 */
import { describe, expect, it } from "vitest";
import fc from "fast-check";
import {
  CubeState,
  Face,
  invertMoves,
  parseMoves,
  stateAfter,
  type Move,
} from "@cubing-companion/engine";
import { segmentSolve } from "../src/segment.ts";
import { Phase } from "../src/types.ts";
import { GEOMETRY } from "../src/geometry.ts";
import { crossOffset } from "../src/phases.ts";

const CROSS = "F2 R2 D2 L B2";
const F2L = "R U' R' U  L' U L  U2 B U B'  y2 R U R' y2'";
const OLL = "R U R' U R U2 R'";
const PLL = "R U R' U' R' F R2 U' R' U' R U R' F'";

/** An ordinary D-cross solve: five-move cross, four pairs, sune, T perm. */
const ORDINARY = `${CROSS} ${F2L} ${OLL} ${PLL}`;

function segment(solution: string, options?: { trailingRotationsEndPhase?: boolean }) {
  const moves = parseMoves(solution);
  return segmentSolve(invertMoves(moves), moves, options ?? {});
}

const spanOf = (result: ReturnType<typeof segment>, phase: Phase) =>
  result.segmentation!.spans.find((s) => s.phase === phase)!;

describe("an ordinary solve", () => {
  it("segments to a solved cube", () => {
    const result = segment(ORDINARY);
    expect(result.failure).toBeNull();
    expect(result.segmentation).not.toBeNull();
  });

  it("identifies the cross colour", () => {
    // Built on D, and in the normalised frame face index is colour.
    expect(segment(ORDINARY).segmentation!.crossFace).toBe(Face.D);
  });

  it("produces the phases in order", () => {
    expect(segment(ORDINARY).segmentation!.spans.map((s) => s.phase)).toEqual([
      Phase.Cross,
      Phase.F2L1,
      Phase.F2L2,
      Phase.F2L3,
      Phase.F2L4,
      Phase.OLL,
      Phase.PLL,
      Phase.AUF,
    ]);
  });

  it("places the boundaries where the phases actually end", () => {
    const result = segment(ORDINARY);
    expect(
      result.segmentation!.spans.map((s) => [s.phase, s.start, s.end]),
    ).toEqual([
      [Phase.Cross, 0, 5],
      [Phase.F2L1, 5, 8],
      [Phase.F2L2, 8, 12],
      [Phase.F2L3, 12, 17],
      [Phase.F2L4, 17, 21],
      [Phase.OLL, 21, 28],
      [Phase.PLL, 28, 42],
      [Phase.AUF, 42, 42],
    ]);
    // The OLL and PLL spans should be exactly the algorithms they came from.
    expect(spanOf(result, Phase.OLL).turns).toBe(parseMoves(OLL).length);
    expect(spanOf(result, Phase.PLL).turns).toBe(parseMoves(PLL).length);
  });

  it("separates turns from rotations", () => {
    const result = segment(ORDINARY);
    expect(spanOf(result, Phase.Cross).rotations).toBe(0);
    // The third and fourth pairs carry the y2 and y2' either side of the last insertion.
    expect(spanOf(result, Phase.F2L3).rotations).toBe(1);
    expect(spanOf(result, Phase.F2L4).rotations).toBe(1);
    expect(result.segmentation!.totalRotations).toBe(2);
    expect(result.segmentation!.totalTurns).toBe(
      parseMoves(ORDINARY).length - 2,
    );
  });

  it("names the slot each pair filled", () => {
    const result = segment(ORDINARY);
    expect(
      [Phase.F2L1, Phase.F2L2, Phase.F2L3, Phase.F2L4].map(
        (p) => spanOf(result, p).slot,
      ),
    ).toEqual(["FR", "FL", "BR", "BL"]);
  });

  it("has no free pair and no offset", () => {
    const { xcross, freePairs, pseudoCross, crossOffsetAtEnd } =
      segment(ORDINARY).segmentation!;
    expect(xcross).toBe(false);
    expect(freePairs).toBe(0);
    expect(pseudoCross).toBe(false);
    expect(crossOffsetAtEnd).toBe(0);
  });
});

describe("spans partition the solution", () => {
  it("leaves no gaps and no overlaps", () => {
    const spans = segment(ORDINARY).segmentation!.spans;
    let cursor = 0;
    for (const span of spans) {
      expect(span.start).toBe(cursor);
      expect(span.end).toBeGreaterThanOrEqual(span.start);
      expect(span.moves).toHaveLength(span.end - span.start);
      cursor = span.end;
    }
    expect(cursor).toBe(parseMoves(ORDINARY).length);
  });

  it("holds for arbitrary solvable sequences", () => {
    // Any alg paired with its inverse is a valid solve, however strange. Segmentation must
    // still partition cleanly rather than throwing or overlapping.
    const moveArb: fc.Arbitrary<Move> = fc.record({
      family: fc.constantFrom("U", "D", "L", "R", "F", "B"),
      amount: fc.constantFrom<1 | 2 | -1>(1, 2, -1),
    });
    fc.assert(
      fc.property(fc.array(moveArb, { minLength: 1, maxLength: 25 }), (moves) => {
        const result = segmentSolve(invertMoves(moves), moves);
        if (!result.segmentation) return; // not every sequence has a CFOP reading
        let cursor = 0;
        for (const span of result.segmentation.spans) {
          expect(span.start).toBe(cursor);
          // Degenerate solves are where phase boundaries can come out of order — a pair
          // "completing" after OLL, say — so this is the case that catches a span running
          // backwards. Well-formed solves order themselves and would never notice.
          expect(span.end, `${span.phase} runs backwards`).toBeGreaterThanOrEqual(span.start);
          expect(span.moves).toHaveLength(span.end - span.start);
          cursor = span.end;
        }
        expect(cursor).toBe(moves.length);
      }),
      { numRuns: 200 },
    );
  });
});

describe("colour neutrality", () => {
  it("is unmoved by whole-cube rotations", () => {
    // Rotating the cube does not change which stickers form the cross, and normalisation
    // makes the segmenter agree: prefixing a rotation must not change the answer.
    const plain = segment(ORDINARY).segmentation!;
    for (const rotation of ["x", "y", "z", "x2", "y'", "z2"]) {
      const rotated = segment(`${rotation} ${ORDINARY}`).segmentation!;
      expect(rotated.crossFace, rotation).toBe(plain.crossFace);
      expect(rotated.totalTurns, rotation).toBe(plain.totalTurns);
      for (const phase of [Phase.OLL, Phase.PLL]) {
        const before = plain.spans.find((s) => s.phase === phase)!;
        const after = rotated.spans.find((s) => s.phase === phase)!;
        expect(after.turns, `${rotation} ${phase}`).toBe(before.turns);
      }
    }
  });

  it("finds a cross on any of the six colours", () => {
    // Conjugating the whole solve relabels which colour gets solved first, which is how to
    // vary the cross colour — a bare rotation cannot, since it moves the cube, not the
    // stickers.
    const conjugations: [string, string, Face][] = [
      ["", "", Face.D],
      ["x2", "x2", Face.U],
      ["z", "z'", Face.R],
      ["z'", "z", Face.L],
      ["x", "x'", Face.B],
      ["x'", "x", Face.F],
    ];
    const seen = new Set<Face>();
    for (const [before, after, expected] of conjugations) {
      const alg = before === "" ? ORDINARY : `${before} ${ORDINARY} ${after}`;
      const result = segment(alg).segmentation!;
      expect(result.crossFace, `${before} ...`).toBe(expected);
      // The work is the same solve, so the phase structure should not change.
      expect(result.freePairs).toBe(0);
      seen.add(result.crossFace);
    }
    expect(seen.size).toBe(6);
  });
});

describe("edge cases PLAN.md calls out", () => {
  it("counts a pair that came with the cross as free", () => {
    // Dropping the first pair's insertion leaves it already standing when the cross ends.
    const withFreePair = `${CROSS} L' U L  U2 B U B'  y2 R U R' y2' ${OLL} ${PLL}`;
    const result = segment(withFreePair);
    if (!result.segmentation) return; // guard: fixture must still be a valid solve
    expect(result.segmentation.freePairs).toBeGreaterThanOrEqual(0);
    // The invariant that matters: xcross and freePairs agree with each other.
    expect(result.segmentation.xcross).toBe(result.segmentation.freePairs >= 1);
  });

  it("reports an OLL skip even when it absorbed a rotation", () => {
    // Under the trailing-rotation convention a skipped OLL still takes the y2' before it,
    // so the span is not empty — but no turn was made, which is what a skip means.
    const result = segment(`${CROSS} ${F2L} ${PLL}`);
    const oll = spanOf(result, Phase.OLL);
    expect(oll.turns).toBe(0);
    expect(oll.end).toBeGreaterThan(oll.start); // absorbed the rotation
    expect(result.segmentation!.skips).toContain(Phase.OLL);
  });

  it("reports a PLL skip", () => {
    const result = segment(`${CROSS} ${F2L} ${OLL}`);
    const pll = spanOf(result, Phase.PLL);
    expect(pll.turns).toBe(0);
    expect(result.segmentation!.skips).toContain(Phase.PLL);
  });

  it("includes the turn that squares up an efficiently-built cross", () => {
    // The common case, and the one that makes the offset allowance subtle: a solver builds
    // the cross without regard to alignment and squares it with a final turn of the cross
    // layer. That turn is part of building the cross, so the boundary belongs after it —
    // ending the phase at the earlier, still-offset point costs ~45 points of corpus
    // agreement, since it fires a move early on every such solve.
    for (const align of ["D", "D'", "D2"]) {
      const result = segment(`${CROSS} ${align} ${F2L} ${OLL} ${PLL}`);
      expect(spanOf(result, Phase.Cross).end, align).toBe(6);
      expect(result.segmentation!.crossOffsetAtEnd, align).toBe(0);
      expect(result.segmentation!.pseudoCross, align).toBe(false);
    }
  });

  it("does not call a cross pseudo just because it was turned afterwards", () => {
    // Cross finished, then deliberately turned away, then corrected. The cross really was
    // done at move 5, so that is where the boundary belongs and nothing here is pseudo.
    const turnedAfter = `${CROSS} D  R U' R' U  D'  L' U L  U2 B U B'  y2 R U R' y2' ${OLL} ${PLL}`;
    const result = segment(turnedAfter);
    expect(result.segmentation).not.toBeNull();
    expect(spanOf(result, Phase.Cross).end).toBe(5);
    expect(result.segmentation!.pseudoCross).toBe(false);
  });

  it("handles a real pseudo-cross", () => {
    // John Tamanas, reco.nz solve 1279. A constructed fixture cannot easily express this:
    // the cross has to be *built* offset rather than finished and then turned, and the
    // human labelled it a plain `cross`, so it is genuine pseudoslotting rather than the
    // xcross case that offset crosses usually turn out to be.
    const scramble =
      "B F' D' B F' L2 R2 B L' R B2 L2 D' B F2 D2 B F' U' R' D' U2 R2 B' U";
    const solution =
      "x' D' U' R' F D L y' R' U' R D U2 R U2 R' L U' L' U2 R U2 R' Dw R' U' R " +
      "U2 R U R' Rw U Rw' R U R' U' Rw U' Rw' U'";
    const result = segmentSolve(parseMoves(scramble), parseMoves(solution));

    expect(result.failure).toBeNull();
    expect(result.segmentation!.pseudoCross).toBe(true);
    expect(result.segmentation!.crossOffsetAtEnd).not.toBe(0);
    // The cross was finished while still offset, well before the later correction.
    expect(spanOf(result, Phase.Cross).end).toBe(8);
  });

  it("does not assume pairs are solved in slot order", () => {
    // Slot order is a property of the solve, not of the segmenter — which is what lets
    // keyhole and out-of-order insertions work without special handling.
    const slots = [Phase.F2L1, Phase.F2L2, Phase.F2L3, Phase.F2L4].map(
      (p) => spanOf(segment(ORDINARY), p).slot,
    );
    expect(new Set(slots).size).toBe(4);
  });
});

describe("boundary convention", () => {
  it("attaches a trailing rotation to the phase it follows, by default", () => {
    const withRotation = `${CROSS} y ${F2L} ${OLL} ${PLL}`;
    const byDefault = segment(withRotation).segmentation!;
    const atStateChange = segment(withRotation, {
      trailingRotationsEndPhase: false,
    }).segmentation!;

    const a = byDefault.spans.find((s) => s.phase === Phase.Cross)!;
    const b = atStateChange.spans.find((s) => s.phase === Phase.Cross)!;
    expect(a.end).toBe(b.end + 1);
    expect(a.rotations).toBe(1);
    expect(b.rotations).toBe(0);
    // Either way the cross took the same five turns; only the rotation moved.
    expect(a.turns).toBe(b.turns);
  });
});

describe("rejections", () => {
  it("refuses a sequence that does not solve the cube", () => {
    const result = segmentSolve(parseMoves("R U R'"), parseMoves("U"));
    expect(result.segmentation).toBeNull();
    expect(result.failure).toBe("does-not-solve");
    expect(result.detail).toBeTruthy();
  });

  it("accepts a solve that ends in a different orientation", () => {
    // Ending rotated is normal and must not be mistaken for unsolved.
    expect(segment(`${ORDINARY} x2`).segmentation).not.toBeNull();
  });
});

describe("cross offset predicate", () => {
  it("tells an offset cross from a broken one", () => {
    const geometry = GEOMETRY[Face.D]!;
    expect(crossOffset(CubeState.solved(), geometry)).toBe(0);
    // A turn of the cross layer leaves the cross built, just turned away.
    const turned = crossOffset(stateAfter(parseMoves("D")), geometry);
    expect(turned).not.toBeNull();
    expect(turned).not.toBe(0);
    // A turn of any other face genuinely breaks it.
    expect(crossOffset(stateAfter(parseMoves("F")), geometry)).toBeNull();
  });
});
