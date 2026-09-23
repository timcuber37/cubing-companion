/**
 * Emits the corpus baselines and the planner's model weights as Swift.
 *
 * Run: npm run swift-tables (which runs this after the move tables)
 *
 * Both are data the TypeScript already carries as generated source — `baselines.generated.ts` from
 * the reco.nz corpus, `weights.generated.ts` from the PyTorch checkpoints — and both port as data
 * rather than code. Read from the live exports rather than re-derived, so the two implementations
 * cannot disagree about a percentile or a weight, only about what they do with it.
 *
 * Every literal is written with its type spelled out: Swift's type checker is quadratic-ish on large
 * untyped nested literals, and a few hundred doubles is enough to make it time out.
 */
import { writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { BASELINES, type Distribution } from "@cubing-companion/metrics";
import { WEIGHTS, type MlpWeights } from "@cubing-companion/planner";

const DIR = new URL("../../swift/CubingCore/Sources/CubingCore/", import.meta.url);

/** Shortest round-tripping decimal, which is also what Swift parses back to the same double. */
const num = (value: number) => (Number.isInteger(value) ? `${value}.0` : `${value}`);
const list = (values: readonly number[]) => `[${values.map(num).join(", ")}]`;

const distribution = (d: Distribution) =>
  `Distribution(n: ${d.n}, mean: ${num(d.mean)}, min: ${num(d.min)}, p10: ${num(d.p10)}, ` +
  `p25: ${num(d.p25)}, median: ${num(d.median)}, p75: ${num(d.p75)}, p90: ${num(d.p90)}, ` +
  `max: ${num(d.max)})`;

const turns = BASELINES.turns
  .map(
    (t) =>
      `        TurnBaseline(\n            key: "${t.key}",\n` +
      `            turns: ${distribution(t.turns)},\n` +
      `            rotations: ${t.rotations ? distribution(t.rotations) : "nil"}),`,
  )
  .join("\n");

const times = BASELINES.times
  .map(
    (t) =>
      `        TimeBaseline(\n            window: .${swiftWindow(t.window)},\n` +
      `            seconds: ${distribution(t.seconds)},\n` +
      `            tps: ${distribution(t.tps)},\n` +
      `            overheadCorrectionSeconds: ${num(t.overheadCorrectionSeconds)}),`,
  )
  .join("\n");

function swiftWindow(window: string): string {
  const names: Record<string, string> = {
    "cross+1": "crossPlusOne",
    "pairs2-3": "pairs23",
    pair4: "pair4",
    oll: "oll",
    pll: "pll",
    f2l: "f2l",
    "last-layer": "lastLayer",
    total: "total",
  };
  const name = names[window];
  if (!name) throw new Error(`no Swift name for time window ${window}`);
  return name;
}

writeFileSync(
  fileURLToPath(new URL("Baselines.generated.swift", DIR)),
  `// GENERATED FILE — do not edit by hand.
// Regenerate with: npm run swift-tables
// Source: packages/metrics/src/baselines.generated.ts (B1's reco.nz corpus).

public let baselines = Baselines(
    generatedAt: "${BASELINES.generatedAt}",
    corpusSolves: ${BASELINES.corpusSolves},
    timedSolves: ${BASELINES.timedSolves},
    timeEraFrom: ${BASELINES.timeEraFrom},
    turns: [
${turns}
    ],
    times: [
${times}
    ]
)
`,
);

function weights(w: MlpWeights | null): string {
  if (!w) return "nil";
  const layers = w.layers
    .map(
      (layer) =>
        `            MlpLayer(\n                inputs: ${layer.inputs}, outputs: ${layer.outputs},\n` +
        `                weight: ${list(layer.weight)},\n` +
        `                bias: ${list(layer.bias)}),`,
    )
    .join("\n");
  return `MlpWeights(
        features: ${w.features},
        mean: ${list(w.mean)},
        scale: ${list(w.scale)},
        layers: [
${layers}
        ])`;
}

writeFileSync(
  fileURLToPath(new URL("Weights.generated.swift", DIR)),
  `// GENERATED FILE — do not edit by hand.
// Regenerate with: npm run swift-tables
// Source: packages/planner/src/weights.generated.ts (ml/export.py, from ml/out/*.pt).

public enum Weights {
    public static let cross: MlpWeights? = ${weights(WEIGHTS.cross)}

    public static let pair: MlpWeights? = ${weights(WEIGHTS.pair)}
}
`,
);

console.log(
  `  ${BASELINES.turns.length} turn and ${BASELINES.times.length} time baselines -> Baselines.generated.swift`,
);
console.log(`  cross and pair rankers -> Weights.generated.swift`);
