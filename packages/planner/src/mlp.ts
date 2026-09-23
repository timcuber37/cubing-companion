/**
 * B3's rankers, evaluated here rather than by a runtime.
 *
 * The model is a three-layer MLP — `Linear(n, 16) → ReLU → Linear(16, 8) → ReLU → Linear(8, 1)` —
 * with standardisation carried as buffers inside the module, so the caller sends raw features and
 * there is no normalisation on this side to get wrong. That is about forty lines of arithmetic.
 *
 * It used to be forty lines of arithmetic behind ONNX Runtime Web, which fetched a **27.8 MB**
 * WASM runtime to do them. The model itself is 2.9 KB. That trade is defensible on a desktop and
 * indefensible on a phone over cellular, and it bought nothing that mattered: the runtime was a
 * dependency, a download, a `fetch` of a URL that a native WebView resolves differently, and a
 * reason the pure packages could not evaluate their own model. Now `rank.ts` can be handed a
 * {@link ScoreFn} that runs anywhere JavaScript runs — web, WebView, Node, a test.
 *
 * Weights live in `weights.generated.ts`, following the `baselines.generated.ts` precedent: small,
 * committed, and bundled, so there is no runtime fetch and no asset to lose.
 *
 * `test/mlp.test.ts` asserts the scores against the values PyTorch produced for the same inputs.
 * That parity test is the whole safety net — if the feature order in `features.ts` ever drifts from
 * the order the weights were fitted to, nothing throws, the model just quietly gets worse.
 */
import type { ScoreFn } from "./rank.ts";

/** One `nn.Linear`. */
export interface MlpLayer {
  readonly inputs: number;
  readonly outputs: number;
  /**
   * Row-major `[outputs][inputs]`, which is how PyTorch stores `Linear.weight` — so `y = x·Wᵀ + b`
   * reads as one contiguous pass per output.
   */
  readonly weight: readonly number[];
  readonly bias: readonly number[];
}

export interface MlpWeights {
  readonly features: number;
  /** Standardisation, applied before the first layer: `(x - mean) / scale`. */
  readonly mean: readonly number[];
  readonly scale: readonly number[];
  /** ReLU between consecutive layers, never after the last one. */
  readonly layers: readonly MlpLayer[];
}

/**
 * Checks a weight set is internally consistent.
 *
 * Worth doing once at load rather than trusting the generator, because every way this can be wrong
 * produces plausible numbers instead of an error: a transposed weight matrix still multiplies, and
 * a short bias vector just reads `undefined` as a hole in the output.
 */
export function validateWeights(weights: MlpWeights): void {
  const { features, mean, scale, layers } = weights;
  if (mean.length !== features || scale.length !== features) {
    throw new Error(
      `normalisation is ${mean.length}/${scale.length} wide, expected ${features}`,
    );
  }
  if (layers.length === 0) throw new Error("no layers");
  if (layers[0]!.inputs !== features) {
    throw new Error(`first layer takes ${layers[0]!.inputs} inputs, expected ${features}`);
  }
  if (layers[layers.length - 1]!.outputs !== 1) {
    throw new Error("the last layer must produce a single score");
  }
  for (const [i, layer] of layers.entries()) {
    if (layer.weight.length !== layer.outputs * layer.inputs) {
      throw new Error(
        `layer ${i} has ${layer.weight.length} weights, expected ${layer.outputs * layer.inputs}`,
      );
    }
    if (layer.bias.length !== layer.outputs) {
      throw new Error(`layer ${i} has ${layer.bias.length} biases, expected ${layer.outputs}`);
    }
    const previous = layers[i - 1];
    if (previous && previous.outputs !== layer.inputs) {
      throw new Error(
        `layer ${i} takes ${layer.inputs} inputs after a layer producing ${previous.outputs}`,
      );
    }
  }
}

/**
 * Score one feature row.
 *
 * Synchronous and allocation-light: this runs once per candidate, and the cross head is handed
 * every (solution, grip) pair in a colour-neutral sweep — hundreds of rows per decision.
 */
export function scoreRow(weights: MlpWeights, row: readonly number[]): number {
  const { features, mean, scale, layers } = weights;
  if (row.length !== features) {
    throw new Error(`feature row has ${row.length} values, expected ${features}`);
  }

  let activations = new Float64Array(features);
  for (let i = 0; i < features; i++) {
    activations[i] = (row[i]! - mean[i]!) / scale[i]!;
  }

  for (const [index, layer] of layers.entries()) {
    const output = new Float64Array(layer.outputs);
    for (let o = 0; o < layer.outputs; o++) {
      const offset = o * layer.inputs;
      let sum = layer.bias[o]!;
      for (let i = 0; i < layer.inputs; i++) {
        sum += layer.weight[offset + i]! * activations[i]!;
      }
      // ReLU between layers, not after the output — the score is signed.
      output[o] = index === layers.length - 1 ? sum : Math.max(0, sum);
    }
    activations = output;
  }

  return activations[0]!;
}

/** Score a batch. Pure, so the ragged-row check is the only thing that can fail. */
export function scoreRows(
  weights: MlpWeights,
  rows: readonly (readonly number[])[],
): number[] {
  return rows.map((row) => scoreRow(weights, row));
}

/**
 * A {@link ScoreFn} over a weight set.
 *
 * The async signature is the seam's, not this function's: `rank.ts` was written against a scorer
 * that might have to fetch something, and keeping that shape means the model's provenance stays
 * the caller's business.
 */
export function scorerFrom(weights: MlpWeights): ScoreFn {
  validateWeights(weights);
  return async (rows) => scoreRows(weights, rows);
}
