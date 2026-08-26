"use client";

import { useEffect, useState } from "react";
import { usePlanner } from "../../components/usePlanner";

/**
 * Does the model in the browser agree with the model that was trained?
 *
 * The failure this exists to catch is a quiet one. If the feature order in `features.ts` drifts
 * from the order the weights were fitted to, nothing throws — the model simply gets worse, and
 * looks like a model that was never very good. Scoring a fixture exported alongside the weights
 * and comparing against what PyTorch produced turns that into a number.
 *
 * It runs through `loadScorer`, the same path the planner uses, so it tests the shipped loader
 * rather than a parallel copy of it.
 */
export default function SelfTest() {
  const { parity, error, running, checkParity } = usePlanner();
  const [model, setModel] = useState<"pair" | "cross">("pair");

  useEffect(() => {
    checkParity(model);
  }, [checkParity, model]);

  const verdict =
    error !== null
      ? `FAIL — ${error}`
      : parity === null
        ? running
          ? "running…"
          : "idle"
        : parity.worst < 1e-4
          ? `PASS — ${parity.rows} rows, worst difference ${parity.worst.toExponential(2)}`
          : `FAIL — ${parity.rows} rows, worst difference ${parity.worst.toExponential(2)}`;

  return (
    <main className="mx-auto max-w-2xl space-y-4 p-8">
      <h1 className="text-lg font-medium text-neutral-100">Model self-test</h1>
      <p className="text-sm text-neutral-500">
        Scores the exported fixture in the browser and compares it against the values PyTorch
        produced for the same inputs. A mismatch means training and inference disagree.
      </p>

      <div className="flex gap-2">
        {(["pair", "cross"] as const).map((option) => (
          <button
            key={option}
            type="button"
            onClick={() => setModel(option)}
            className={`rounded px-2 py-1 text-xs ${
              model === option
                ? "bg-neutral-700 text-neutral-100"
                : "text-neutral-500 hover:text-neutral-300"
            }`}
          >
            {option}
          </button>
        ))}
      </div>

      <pre id="parity-result" className="rounded border border-neutral-800 p-3 text-sm text-neutral-200">
        {model}: {verdict}
      </pre>
    </main>
  );
}
