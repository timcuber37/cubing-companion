/**
 * Planning and ranking.
 *
 * The load-bearing property is the end-to-end one: hold the cube the way the plan says, turn the
 * moves the plan gives, and the cross must be solved. Everything else here is about the ranking
 * being honest — specifically that comfort never outranks being shorter.
 */
import { describe, expect, it } from "vitest";
import fc from "fast-check";
import {
  applyMoves,
  CubeState,
  Face,
  normalizeOrientation,
  parseMoves,
  type Move,
} from "@cubing-companion/engine";
import { isSlotSolved, GEOMETRY } from "@cubing-companion/analysis";
import { crossDistance } from "@cubing-companion/solver";
import { planColour, planColours } from "../src/plan.ts";
import { ORIENTATIONS } from "../src/orientation.ts";
import { comfortScore, awkwardTurns, FACE_SHARE } from "../src/comfort.ts";
import { colourName, COLOURS } from "../src/colours.ts";

const ALL_FACES = [Face.U, Face.L, Face.F, Face.R, Face.B, Face.D] as const;

const SCRAMBLES = [
  "D2 F R2 U L B2 R F2 D L U2 B",
  "R U2 F D L2 B R2 U F2 L D2 B",
  "B2 L D R2 U F L2 B U2 R D F",
];

const positionOf = (scramble: string) =>
  applyMoves(CubeState.solved(), parseMoves(scramble));

/** The cube as it stands once you have held it as instructed and turned the moves. */
function executed(state: CubeState, plan: { hold: { rotation: string }; moves: readonly Move[] }) {
  const orientation = ORIENTATIONS.find((o) => o.text === plan.hold.rotation)!;
  expect(orientation, `unknown rotation ${plan.hold.rotation}`).toBeDefined();
  return applyMoves(state, [...orientation.rotation, ...plan.moves]);
}

describe("following the plan", () => {
  it("solves the cross, for every colour and every ranked candidate", () => {
    for (const scramble of SCRAMBLES) {
      const state = positionOf(scramble);
      for (const face of ALL_FACES) {
        const plan = planColour(state, face, { keep: 3, crossOnly: true });
        expect(plan.cross.length, `${scramble} ${colourName(face)}`).toBeGreaterThan(0);
        for (const candidate of plan.cross) {
          expect(
            crossDistance(executed(state, candidate), face),
            `${colourName(face)}: hold [${candidate.hold.rotation}] then ${candidate.text}`,
          ).toBe(0);
        }
      }
    }
  });

  it("solves the cross and fills the pair, for every xcross", () => {
    const state = positionOf(SCRAMBLES[0]!);
    const plan = planColour(state, Face.D, { keep: 4 });
    expect(plan.xcross.length).toBeGreaterThan(0);

    for (const candidate of plan.xcross) {
      const after = executed(state, candidate);
      expect(crossDistance(after, Face.D)).toBe(0);
      // Slot geometry is expressed in the normalised frame, and following the plan leaves the
      // cube rotated — so undo that before asking which slot got filled. (`crossDistance`
      // normalises internally, which is why the cross check above needs no such care.)
      const home = normalizeOrientation(after);
      const filled = GEOMETRY[Face.D]!.slots.filter((slot) => isSlotSolved(home, slot));
      expect(filled.length, candidate.text).toBeGreaterThan(0);
    }
  });

  it("holds the cross colour down, always", () => {
    const state = positionOf(SCRAMBLES[1]!);
    for (const face of ALL_FACES) {
      const plan = planColour(state, face, { keep: 3, crossOnly: true });
      for (const candidate of plan.cross) {
        expect(candidate.hold.down, colourName(face)).toBe(face);
        expect(candidate.hold.front).not.toBe(face);
      }
    }
  });

  it("asks for nothing when the cross is already built", () => {
    const plan = planColour(CubeState.solved(), Face.D, { crossOnly: true });
    expect(plan.crossLength).toBe(0);
    expect(plan.cross[0]!.moves).toEqual([]);
    expect(plan.cross[0]!.length).toBe(0);
  });
});

describe("ranking", () => {
  it("never puts a longer solution above a shorter one", () => {
    // Comfort breaks ties; it must not break the ordering. A planner that talks you into a
    // seven-move cross because it reads nicely is worse than one that says nothing.
    const state = positionOf(SCRAMBLES[0]!);
    for (const face of ALL_FACES) {
      const plan = planColour(state, face, { keep: 8, maxExtra: 2, crossOnly: true });
      for (let i = 1; i < plan.cross.length; i++) {
        expect(plan.cross[i]!.length).toBeGreaterThanOrEqual(plan.cross[i - 1]!.length);
      }
    }
  });

  it("orders equal-length solutions by comfort, best first", () => {
    const state = positionOf(SCRAMBLES[2]!);
    const plan = planColour(state, Face.D, { keep: 10, crossOnly: true });
    for (let i = 1; i < plan.cross.length; i++) {
      if (plan.cross[i]!.length === plan.cross[i - 1]!.length) {
        expect(plan.cross[i]!.comfort).toBeLessThanOrEqual(plan.cross[i - 1]!.comfort);
      }
    }
  });

  it("puts the cheapest colour first when planning several", () => {
    const plans = planColours(positionOf(SCRAMBLES[0]!), [...ALL_FACES], {
      keep: 1,
      crossOnly: true,
    });
    expect(plans).toHaveLength(6);
    for (let i = 1; i < plans.length; i++) {
      expect(plans[i]!.crossLength).toBeGreaterThanOrEqual(plans[i - 1]!.crossLength);
    }
  });

  it("picks the frame that avoids the back face, when one exists", () => {
    // The measured payoff of choosing a frame: over these positions the recommendation should
    // almost never ask for a back turn, even though most raw optimal solutions contain one.
    let candidates = 0;
    let withBack = 0;
    for (const scramble of SCRAMBLES) {
      const state = positionOf(scramble);
      for (const face of ALL_FACES) {
        for (const candidate of planColour(state, face, { keep: 3, crossOnly: true }).cross) {
          candidates++;
          if (candidate.awkward.back > 0) withBack++;
        }
      }
    }
    expect(candidates).toBeGreaterThan(20);
    expect(withBack / candidates).toBeLessThan(0.3);
  });
});

describe("the comfort model", () => {
  it("is a distribution over the six faces", () => {
    const total = Object.values(FACE_SHARE).reduce((a, b) => a + b, 0);
    expect(total).toBeCloseTo(1, 2);
    expect(Object.keys(FACE_SHARE).sort()).toEqual(["B", "D", "F", "L", "R", "U"]);
  });

  it("ranks the back face far below the right, as the corpus does", () => {
    expect(FACE_SHARE.R! / FACE_SHARE.B!).toBeGreaterThan(10);
    expect(comfortScore(parseMoves("R D R D"))).toBeGreaterThan(
      comfortScore(parseMoves("B L B L")),
    );
  });

  it("scores between zero and one, at the ends too", () => {
    expect(comfortScore(parseMoves("B B2 B'"))).toBeCloseTo(0, 6);
    expect(comfortScore(parseMoves("D D2 D'"))).toBeCloseTo(1, 6);
    fc.assert(
      fc.property(
        fc.array(
          fc.record({
            family: fc.constantFrom("U", "D", "L", "R", "F", "B"),
            amount: fc.constantFrom<1 | 2 | -1>(1, 2, -1),
          }),
          { minLength: 1, maxLength: 15 },
        ),
        (moves) => {
          const score = comfortScore(moves as Move[]);
          expect(score).toBeGreaterThanOrEqual(0);
          expect(score).toBeLessThanOrEqual(1);
        },
      ),
      { numRuns: 100 },
    );
  });

  it("does not reward being short, which is ranked separately", () => {
    // The mean, not the sum: doubling a sequence must not change how comfortable it looks.
    const once = parseMoves("R U F");
    expect(comfortScore([...once, ...once])).toBeCloseTo(comfortScore(once), 9);
  });

  it("treats a move it does not know as the worst case, never the best", () => {
    const unknown = [{ family: "Rw", amount: 1 }] as Move[];
    expect(comfortScore(unknown)).toBeCloseTo(0, 6);
  });

  it("counts the turns that explain a low score", () => {
    expect(awkwardTurns(parseMoves("B R L B2 D"))).toEqual({ back: 2, left: 1 });
  });

  it("calls an empty solution perfectly comfortable", () => {
    expect(comfortScore([])).toBe(1);
  });
});

describe("colours", () => {
  it("names all six, opposite faces never sharing a name", () => {
    expect(COLOURS).toHaveLength(6);
    expect(new Set(COLOURS.map((c) => c.name)).size).toBe(6);
    expect(colourName(Face.U)).toBe("white");
    expect(colourName(Face.D)).toBe("yellow");
    expect(colourName(Face.F)).toBe("green");
  });
});
