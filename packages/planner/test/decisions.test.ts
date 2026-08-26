/**
 * Decision extraction and explanation.
 *
 * The position below is chosen, not invented: after this scramble and cross, **FR and FL both go
 * in in six moves**, but FR's corner is sitting in the last layer and FL's is buried in a slot.
 * That is precisely the situation the corpus measurement is about — where move count ties, pros
 * take the reachable corner 89.9% of the time — so a solve that fills FL first is a solve with a
 * known, nameable mistake, and the diff has to name it.
 */
import { describe, expect, it } from "vitest";
import {
  applyMoves,
  CubeState,
  Face,
  normalizeOrientation,
  parseMoves,
  type Move,
} from "@cubing-companion/engine";
import { GEOMETRY, Phase, slotName, type PhaseSpan, type Slot } from "@cubing-companion/analysis";
import { enumerateF2LInsertion, solveCross } from "@cubing-companion/solver";
import { pairDecisions, crossDecision } from "../src/decisions.ts";
import { attribute, confidenceWording, phrase, reasons } from "../src/explain.ts";
import { PAIR_FEATURES } from "../src/features.ts";
import type { ScoreFn } from "../src/rank.ts";

const SCRAMBLE = "D2 F R2 U L B2 R F2 D L U2 B";
const GEO = GEOMETRY[Face.D]!;
const index = (name: string) => PAIR_FEATURES.indexOf(name as never);
const slotBy = (name: string) => GEO.slots.find((s) => slotName(s) === name)!;

/** Build a full F2L in a chosen order, and the spans a segmenter would have produced for it. */
function buildSolve(order: readonly string[]) {
  const start = applyMoves(CubeState.solved(), parseMoves(SCRAMBLE));
  const cross = solveCross(start, Face.D)!;
  const moves: Move[] = [...cross];
  const spans: PhaseSpan[] = [
    {
      phase: Phase.Cross,
      start: 0,
      end: cross.length,
      moves: cross,
      turns: cross.length,
      rotations: 0,
    },
  ];

  let state = normalizeOrientation(applyMoves(start, cross));
  const phases = [Phase.F2L1, Phase.F2L2, Phase.F2L3, Phase.F2L4];
  for (const [i, name] of order.entries()) {
    const slot = slotBy(name);
    const insertion = enumerateF2LInsertion(state, Face.D, slot, { maxSolutions: 1 })
      .candidates[0]!.moves;
    spans.push({
      phase: phases[i]!,
      start: moves.length,
      end: moves.length + insertion.length,
      moves: [...insertion],
      turns: insertion.length,
      rotations: 0,
      slot: name,
    });
    moves.push(...insertion);
    state = normalizeOrientation(applyMoves(state, insertion));
  }
  return { start, moves, spans, crossLength: cross.length };
}

/** A stand-in model that cares about exactly one feature, so attribution has a known answer. */
const only = (feature: string, weight = 3): ScoreFn =>
  async (rows) => rows.map((row) => weight * row[index(feature)]!);

describe("the position these tests rest on", () => {
  it("really does tie on move count while differing on the corner", () => {
    const { start, spans } = buildSolve(["FR", "FL", "BL", "BR"]);
    const decision = pairDecisions(start, buildSolve(["FR", "FL", "BL", "BR"]).moves, spans, Face.D)[0]!;

    const fr = decision.options.find((o) => o.name === "FR")!;
    const fl = decision.options.find((o) => o.name === "FL")!;
    expect(fr.optimal).toBe(6);
    expect(fl.optimal).toBe(6);
    expect(fr.features[index("cornerOnTop")]).toBe(1);
    expect(fl.features[index("cornerOnTop")]).toBe(0);
  });
});

describe("pairDecisions", () => {
  const { start, moves, spans } = buildSolve(["FL", "FR", "BL", "BR"]);

  it("finds three decisions, because the fourth pair is forced", () => {
    const decisions = pairDecisions(start, moves, spans, Face.D);
    expect(decisions).toHaveLength(3);
    expect(decisions.map((d) => d.step)).toEqual([0, 1, 2]);
    expect(decisions.map((d) => d.options.length)).toEqual([4, 3, 2]);
  });

  it("records which slot was actually filled, and what it cost", () => {
    const [first, second] = pairDecisions(start, moves, spans, Face.D);
    expect(first!.options[first!.chosen]!.name).toBe("FL");
    expect(second!.options[second!.chosen]!.name).toBe("FR");
    expect(first!.playedMoves.length).toBe(first!.options[first!.chosen]!.optimal);
  });

  it("points at the move where the decision was acted on", () => {
    const decisions = pairDecisions(start, moves, spans, Face.D);
    for (const decision of decisions) {
      expect(decision.at).toBe(spans.find((s) => s.slot === decision.options[decision.chosen]!.name)!.start);
    }
  });

  it("gives every option a full feature vector", () => {
    for (const decision of pairDecisions(start, moves, spans, Face.D)) {
      for (const option of decision.options) {
        expect(option.features).toHaveLength(PAIR_FEATURES.length);
        for (const value of option.features) expect(Number.isFinite(value)).toBe(true);
      }
    }
  });

  it("declines rather than guessing when the solve cannot be read", () => {
    // Spans with no slot labels describe a solve the segmenter did not understand; a diff built
    // on positions that are not what they claim would be confidently wrong.
    const unlabelled = spans.map(({ slot: _slot, ...rest }) => rest);
    expect(pairDecisions(start, moves, unlabelled, Face.D)).toEqual([]);
  });

  it("reads the cross as length against the optimum", () => {
    const decision = crossDecision(start, moves, spans, Face.D, 6)!;
    expect(decision.played).toBe(6);
    expect(decision.optimal).toBe(6);
    expect(decision.at).toBe(0);
  });
});

describe("attribution", () => {
  const { start, moves, spans } = buildSolve(["FL", "FR", "BL", "BR"]);
  const decision = pairDecisions(start, moves, spans, Face.D)[0]!;
  const mine = decision.options.find((o) => o.name === "FL")!;
  const better = decision.options.find((o) => o.name === "FR")!;

  it("names the feature that actually moved the score", async () => {
    // The stub weights cornerOnTop and nothing else, so the arithmetic says it must come top.
    const found = await attribute(mine.features, better.features, only("cornerOnTop"));
    expect(found[0]!.feature).toBe("cornerOnTop");
    expect(found[0]!.share).toBeCloseTo(1, 6);
    expect(found[0]!.yours).toBe(0);
    expect(found[0]!.theirs).toBe(1);
  });

  it("follows the model, not the size of the difference", async () => {
    // `ways` differs more in raw magnitude than the corner does, and must still lose: what
    // matters is what the model reacted to, not which numbers happen to be furthest apart.
    const found = await attribute(mine.features, better.features, only("cornerOnTop"));
    expect(found.map((entry) => entry.feature)).toEqual(["cornerOnTop"]);
  });

  it("says nothing when the model does not actually prefer the alternative", async () => {
    const backwards = await attribute(better.features, mine.features, only("cornerOnTop"));
    expect(backwards).toEqual([]);
  });

  it("never credits a feature the two options share", async () => {
    const found = await attribute(mine.features, better.features, only("stepIndex"));
    expect(found).toEqual([]);
  });

  it("caps a single feature at explaining all of the gap, never more", async () => {
    // One swap can overshoot the gap; a share above 1 would read as nonsense.
    const found = await attribute(mine.features, better.features, only("cornerOnTop", 50));
    for (const entry of found) expect(entry.share).toBeLessThanOrEqual(1);
  });
});

describe("plain language", () => {
  it("has a phrasing for every feature, so a reason is never blank", () => {
    for (const feature of PAIR_FEATURES) {
      for (const [yours, theirs] of [
        [0, 1] as const,
        [1, 0] as const,
      ]) {
        const text = phrase(
          { feature, delta: 1, share: 1, yours, theirs },
          { yours: "FL", theirs: "FR" },
        );
        expect(text, feature).toBeTruthy();
        expect(text.length, feature).toBeGreaterThan(10);
      }
    }
  });

  it("explains the known mistake by naming the buried corner", async () => {
    const { start, moves, spans } = buildSolve(["FL", "FR", "BL", "BR"]);
    const decision = pairDecisions(start, moves, spans, Face.D)[0]!;
    const mine = decision.options.find((o) => o.name === "FL")!;
    const better = decision.options.find((o) => o.name === "FR")!;

    const said = reasons(
      await attribute(mine.features, better.features, only("cornerOnTop")),
      { yours: "FL", theirs: "FR" },
    );
    expect(said).toHaveLength(1);
    expect(said[0]).toContain("corner");
    expect(said[0]).toContain("buried");
    expect(said[0]).toContain("FR");
  });

  it("keeps at most two reasons, and drops the ones that barely moved", async () => {
    const { start, moves, spans } = buildSolve(["FL", "FR", "BL", "BR"]);
    const decision = pairDecisions(start, moves, spans, Face.D)[0]!;
    const mine = decision.options.find((o) => o.name === "FL")!;
    const better = decision.options.find((o) => o.name === "FR")!;

    // A model that weights everything a little produces many small movers; only the top survive.
    const everything: ScoreFn = async (rows) =>
      rows.map((row) => row.reduce((sum, value) => sum + value * 0.1, 0));
    const said = reasons(await attribute(mine.features, better.features, everything), {
      yours: "FL",
      theirs: "FR",
    });
    expect(said.length).toBeLessThanOrEqual(2);
  });

  it("softens its wording as the model gets less sure", () => {
    expect(confidenceWording(0.9)).toContain("most likely");
    expect(confidenceWording(0.45)).toContain("more often");
    expect(confidenceWording(0.3)).toContain("leans");
    // Never a verdict: the model agrees with a real pro under 70% of the time.
    for (const confidence of [0.3, 0.45, 0.9]) {
      expect(confidenceWording(confidence)).not.toContain("should");
    }
  });
});
