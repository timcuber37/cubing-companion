/**
 * Inferring which way the cube was held.
 *
 * The evidence is that solvers do not turn faces uniformly — once the cross is down, F2L is 46%
 * U and 37% R and essentially never B. So the tests here are built the way the inference is
 * validated: take a solve written in a known grip, re-express it in the cube's frame the way a
 * smart cube would report it, and check the grip comes back.
 */
import { describe, expect, it } from "vitest";
import { Face, parseMoves, type Move } from "@cubing-companion/engine";
import { Phase } from "@cubing-companion/analysis";
import {
  framesPuttingColourDown,
  ORIENTATIONS,
  renameMoves,
} from "../src/orientation.ts";
import {
  gripObservations,
  inferGrip,
  phaseGroup,
  PHASE_FACE_SHARE,
  type GripObservation,
} from "../src/grip.ts";

const HOME = [0, 1, 2, 3, 4, 5];
const span = (phase: Phase, moves: string) => ({ phase, moves: parseMoves(moves) });

/** What a cube reports when a solve turned in `grip` happens on a cube in the home frame. */
function asReported(grip: (typeof ORIENTATIONS)[number], userMoves: readonly Move[]): Move[] {
  const inverse: Record<string, string> = {};
  for (const [from, to] of Object.entries(grip.rename)) inverse[to] = from;
  return userMoves.map((move) => ({ family: inverse[move.family]!, amount: move.amount }) as Move);
}

describe("the emission model", () => {
  it("is a distribution per stage, and the stages really differ", () => {
    for (const group of ["cross", "f2l", "lastLayer"] as const) {
      const total = Object.values(PHASE_FACE_SHARE[group]).reduce((a, b) => a + b, 0);
      expect(total, group).toBeCloseTo(1, 2);
    }
    // The reason a single distribution failed: nobody turns D once the cross is down, and the
    // cross is mostly D and R.
    expect(PHASE_FACE_SHARE.cross.D!).toBeGreaterThan(0.2);
    expect(PHASE_FACE_SHARE.f2l.D!).toBeLessThan(0.02);
    // And B is all but absent from F2L, which is what carries most of the signal.
    expect(PHASE_FACE_SHARE.f2l.B!).toBeLessThan(0.001);
    expect(PHASE_FACE_SHARE.f2l.B!).toBeGreaterThan(0);
  });

  it("groups the phases that share a distribution, and ignores an AUF", () => {
    expect(phaseGroup(Phase.Cross)).toBe("cross");
    expect(phaseGroup(Phase.F2L1)).toBe("f2l");
    expect(phaseGroup(Phase.F2L4)).toBe("f2l");
    expect(phaseGroup(Phase.OLL)).toBe("lastLayer");
    // A single U turn by definition, so it says nothing about the grip.
    expect(phaseGroup(Phase.AUF)).toBeNull();
  });
});

describe("observations", () => {
  it("takes the face turns of every stage that has a distribution", () => {
    const observations = gripObservations([
      span(Phase.Cross, "D R F"),
      span(Phase.F2L1, "R U R'"),
      span(Phase.AUF, "U"),
    ]);
    expect(observations.map((o) => o.face)).toEqual(["D", "R", "F", "R", "U", "R"]);
    expect(observations.map((o) => o.group)).toEqual([
      "cross", "cross", "cross", "f2l", "f2l", "f2l",
    ]);
  });

  it("leaves out what the model cannot score", () => {
    // Rotations say nothing alone; wide and slice moves are not in the distribution.
    const observations = gripObservations([span(Phase.F2L1, "y R Rw U M")]);
    expect(observations.map((o) => o.face)).toEqual(["R", "U"]);
  });
});

describe("inferGrip", () => {
  const candidates = framesPuttingColourDown(HOME, Face.D);

  it("offers exactly the four frames that agree on what is underneath", () => {
    expect(candidates).toHaveLength(4);
    for (const frame of candidates) expect(frame.colourAt[Face.D]).toBe(Face.D);
    // They differ only in what faces you — which is the choice being made.
    expect(new Set(candidates.map((f) => f.colourAt[Face.F])).size).toBe(4);
    // Shortest first, so a caller with no opinion gets the least fiddly view.
    expect(candidates[0]!.rotation).toEqual([]);
  });

  it("recovers a grip from a solve reported in the cube's frame", () => {
    // A perfectly ordinary F2L in the solver's own frame: all R and U.
    const asSolved = parseMoves("R U R' U' R U R' U' R U2 R' U R U' R'");
    for (const grip of candidates) {
      const reported = asReported(grip, asSolved);
      const found = inferGrip(
        gripObservations([{ phase: Phase.F2L1, moves: reported }]),
        candidates,
      );
      expect(found.text || "identity", `grip ${grip.text || "identity"}`).toBe(
        grip.text || "identity",
      );
    }
  });

  it("uses the stage, not just the faces", () => {
    // Every candidate keeps the cross colour underneath, so a D turn reads as D in all four and
    // discriminates nothing — only the side faces carry information. What separates the stages
    // there is that F and L swap ranks: a cross uses F more than L (.140 against .094), F2L the
    // other way round and far more sharply (.138 against .025). So the same turns point at
    // different grips depending on when they happened.
    const moves = parseMoves("F F R");
    const asCross = inferGrip(gripObservations([{ phase: Phase.Cross, moves }]), candidates);
    const asF2L = inferGrip(gripObservations([{ phase: Phase.F2L1, moves }]), candidates);
    expect(asCross.text).not.toBe(asF2L.text);
    // The cross is happy to leave them where they are; F2L moves the F turns onto L.
    expect(asCross.rename.F).toBe("F");
    expect(asF2L.rename.F).toBe("L");
  });

  it("falls back to the caller's first choice when there is nothing to go on", () => {
    // Degrades to the shortest rotation — exactly the behaviour before any of this existed.
    expect(inferGrip([], candidates)).toBe(candidates[0]);
    expect(inferGrip(gripObservations([span(Phase.AUF, "U")]), candidates)).toBe(candidates[0]);
  });

  it("always returns one of the candidates it was given", () => {
    const observations: GripObservation[] = [
      { face: "B", group: "f2l" },
      { face: "B", group: "f2l" },
      { face: "D", group: "f2l" },
    ];
    const found = inferGrip(observations, candidates);
    expect(candidates).toContain(found);
    // Turns that read as B and D during F2L are the signature of a rotated cube, so the answer
    // must not be the frame that leaves them there.
    expect(found.rename.B).not.toBe("B");
  });

  it("refuses an empty candidate list rather than inventing a frame", () => {
    expect(() => inferGrip([], [])).toThrow(/candidate/);
  });
});
