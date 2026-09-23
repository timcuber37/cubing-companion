/**
 * Does the model we evaluate agree with the model that was trained?
 *
 * The failure this exists to catch is a quiet one. If the feature order in `features.ts` drifts
 * from the order the weights were fitted to, nothing throws — the model simply gets worse, and
 * looks like a model that was never very good. Scoring a fixture exported alongside the weights
 * and comparing against what PyTorch produced for the same inputs turns that into a number.
 *
 * This used to be a page in the browser (`/selftest`), because inference used to need a WASM
 * runtime that only existed there. Now that `mlp.ts` is arithmetic, the check belongs in CI, where
 * it runs on every commit rather than when someone remembers to open a tab.
 *
 * Both fixtures are 256 real feature rows from held-out decisions — solvers the model never
 * trained on — so a mismatch shows up on the ranges the model actually sees.
 */
import { describe, expect, it } from "vitest";
import crossFixture from "./fixtures/cross.fixture.json" with { type: "json" };
import pairFixture from "./fixtures/pair.fixture.json" with { type: "json" };
import { scoreRows, validateWeights, type MlpWeights } from "../src/mlp.ts";
import { scorerFor } from "../src/scorer.ts";
import { WEIGHTS, type RankerName } from "../src/weights.generated.ts";

const FIXTURES: Record<RankerName, { input: number[][]; expected: number[] }> = {
  cross: crossFixture,
  pair: pairFixture,
};

/**
 * PyTorch computes in float32; this computes in float64, so the two cannot agree exactly.
 *
 * Measured worst case: **8.6e-7** for cross, 6.0e-7 for pair. The ONNX runtime this replaced sat
 * around 6e-8 — tighter, because it also computed in float32 and so made the *same* rounding
 * errors rather than fewer of them. Matching that would mean `Math.fround` around every multiply
 * and add, which is real cost in the hot loop for agreement we do not need: candidate scores in a
 * decision differ by tenths, and a feature-order mismatch — the thing this test exists to catch —
 * shifts them by whole units.
 *
 * So the threshold is 1e-5: an order of magnitude above what float64 drift produces, four below
 * what a real mismatch would.
 */
const TOLERANCE = 1e-5;

describe.each(["cross", "pair"] as const)("the %s ranker", (name) => {
  const weights = WEIGHTS[name];
  const fixture = FIXTURES[name];

  it("has weights in this build", () => {
    // If this fails, `ml/export.py` has not been run since the head was trained.
    expect(weights).not.toBeNull();
  });

  it("is internally consistent", () => {
    expect(() => validateWeights(weights!)).not.toThrow();
  });

  it("is the architecture the exporter documents", () => {
    const shape = weights!.layers.map((layer) => [layer.inputs, layer.outputs]);
    expect(shape).toEqual([
      [weights!.features, 16],
      [16, 8],
      [8, 1],
    ]);
  });

  it("agrees with PyTorch on every fixture row", () => {
    const got = scoreRows(weights!, fixture.input);
    expect(got).toHaveLength(fixture.expected.length);

    let worst = 0;
    let at = -1;
    for (const [i, value] of got.entries()) {
      const difference = Math.abs(value - fixture.expected[i]!);
      if (difference > worst) {
        worst = difference;
        at = i;
      }
    }
    // Reported rather than just asserted, so a regression says how far off it was and where.
    expect(worst, `worst disagreement ${worst.toExponential(2)} at row ${at}`).toBeLessThan(
      TOLERANCE,
    );
  });

  it("scores through the seam the planner actually uses", async () => {
    const scorer = scorerFor(name);
    expect(scorer).not.toBeNull();
    const got = await scorer!(fixture.input.slice(0, 8));
    expect(got).toHaveLength(8);
    for (const [i, value] of got.entries()) {
      expect(value).toBeCloseTo(fixture.expected[i]!, 5);
    }
  });
});

describe("scorerFor", () => {
  it("returns the same scorer each time", () => {
    expect(scorerFor("cross")).toBe(scorerFor("cross"));
  });

  it("keeps the two heads apart", () => {
    expect(scorerFor("cross")).not.toBe(scorerFor("pair"));
  });
});

describe("validateWeights", () => {
  const good = WEIGHTS.cross!;
  const bend = (patch: Partial<MlpWeights>): MlpWeights => ({ ...good, ...patch });

  it("rejects normalisation of the wrong width", () => {
    expect(() => validateWeights(bend({ mean: good.mean.slice(1) }))).toThrow(/wide/);
  });

  it("rejects a weight matrix that does not match its shape", () => {
    const layers = [{ ...good.layers[0]!, weight: good.layers[0]!.weight.slice(1) }, ...good.layers.slice(1)];
    expect(() => validateWeights(bend({ layers }))).toThrow(/weights/);
  });

  it("rejects layers that do not compose", () => {
    const layers = [{ ...good.layers[0]!, outputs: 15, weight: good.layers[0]!.weight.slice(0, 15 * 12), bias: good.layers[0]!.bias.slice(0, 15) }, ...good.layers.slice(1)];
    expect(() => validateWeights(bend({ layers }))).toThrow(/inputs after a layer/);
  });

  it("rejects a head that does not end in one score", () => {
    expect(() => validateWeights(bend({ layers: good.layers.slice(0, 2) }))).toThrow(/single score/);
  });
});

describe("scoreRow", () => {
  it("rejects a row of the wrong width", () => {
    // A ragged batch would otherwise read `undefined` as a hole and produce NaN silently.
    expect(() => scoreRows(WEIGHTS.cross!, [[1, 2, 3]])).toThrow(/expected 12/);
  });
});
