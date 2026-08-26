/**
 * Loading B3's rankers, inside the worker.
 *
 * This is the only file that knows ONNX exists. `packages/planner` takes a plain
 * `(rows) => Promise<number[]>` and never learns where the numbers came from, which keeps the
 * pure packages testable without a WASM runtime anywhere near them.
 *
 * Whether this works at all was checked in a browser before anything was built on it — A2 found
 * that Turbopack cannot instantiate cubing.js's WASM module worker, and ONNX Runtime Web leans on
 * the same machinery. It runs, and matches PyTorch to about 6e-8. The one thing that does not
 * work is torch's default export, which writes weights to a `.onnx.data` sidecar the browser has
 * no filesystem to mount; `ml/export.py` passes `external_data=False` for exactly that reason.
 */
import * as ort from "onnxruntime-web";
import type { ScoreFn } from "@cubing-companion/planner";

export type ModelName = "pair" | "cross";

const sessions = new Map<ModelName, Promise<ort.InferenceSession>>();

function sessionFor(name: ModelName): Promise<ort.InferenceSession> {
  let session = sessions.get(name);
  if (!session) {
    session = ort.InferenceSession.create(`/models/${name}.onnx`);
    sessions.set(name, session);
  }
  return session;
}

/**
 * A scorer backed by the exported model, or `null` when there is no usable model.
 *
 * Returning null rather than throwing is deliberate: a missing model should cost the *learned*
 * ranking, not the whole planner. The caller falls back to move count and says so.
 */
export async function loadScorer(name: ModelName): Promise<ScoreFn | null> {
  let session: ort.InferenceSession;
  try {
    session = await sessionFor(name);
  } catch {
    sessions.delete(name);
    return null;
  }

  return async (rows) => {
    if (rows.length === 0) return [];
    const width = rows[0]!.length;
    const flat = new Float32Array(rows.length * width);
    for (let i = 0; i < rows.length; i++) {
      // A ragged batch would be silently mis-shaped by the tensor constructor rather than
      // rejected, so it is caught here where the cause is still obvious.
      if (rows[i]!.length !== width) {
        throw new Error(`feature row ${i} has ${rows[i]!.length} values, expected ${width}`);
      }
      flat.set(rows[i]!, i * width);
    }

    const output = await session.run({
      features: new ort.Tensor("float32", flat, [rows.length, width]),
    });
    const scores = output.score?.data;
    if (!scores) throw new Error("model produced no 'score' output");
    return Array.from(scores as Float32Array);
  };
}
