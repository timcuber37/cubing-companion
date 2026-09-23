"use client";

import { useCallback, useRef, useState } from "react";
import type { BenchRequest, BenchResult, PlanResponse } from "../workers/planner.worker";

/**
 * How fast is the planner *here*?
 *
 * Every performance number this project quotes was measured on a desktop: a colour-neutral sweep
 * with a median of 1.9 s, and ~490 ms to build the cross tables. Those numbers decided the
 * architecture — per-colour streaming so the first cross appears early, a worker so the UI keeps
 * painting — and none of them had ever been checked on a phone.
 *
 * This runs a fixed workload from a fixed position, so the result is comparable across devices
 * rather than being whatever the cube happened to be showing.
 *
 * The 15-second WCA inspection window is the budget that matters: a planner that cannot sweep six
 * colours inside it is not a planner you can use before a solve.
 */

/** A fixed scramble, so every device does identical work. */
const BENCH_FACELETS = "DRLUUBFBRBLURRLRUBLRDDFDLFUFUFFDBRDUBRUFLLFDDBFLUBLRBD";

/**
 * Desktop reference, measured with *this exact workload* on the development machine.
 *
 * Deliberately not the ~490 ms / 1.9 s figures quoted elsewhere in the codebase: those came from a
 * different position and a different runtime, so comparing a phone against them would be comparing
 * two things that were never the same measurement.
 */
const REFERENCE = { tableBuildMs: 591, sweepMedianMs: 2319 };

const INSPECTION_MS = 15_000;

export function PerformancePanel() {
  const [result, setResult] = useState<BenchResult | null>(null);
  const [running, setRunning] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const workerRef = useRef<Worker | null>(null);

  const run = useCallback(() => {
    setRunning(true);
    setError(null);
    setResult(null);

    // A worker of its own, thrown away afterwards. The cross tables live in module scope and are
    // kept for the worker's lifetime, so reusing the app's worker would measure a warm start and
    // report the cold cost as zero.
    workerRef.current?.terminate();
    const worker = new Worker(new URL("../workers/planner.worker.ts", import.meta.url));
    workerRef.current = worker;

    worker.onmessage = (event: MessageEvent<PlanResponse>) => {
      const message = event.data;
      if (message.kind === "bench") {
        setResult(message.result);
        setRunning(false);
        worker.terminate();
        workerRef.current = null;
      } else if (message.kind === "error") {
        setError(message.message);
        setRunning(false);
        worker.terminate();
        workerRef.current = null;
      }
    };
    worker.onerror = (event) => {
      setError(event.message || "the planner worker failed to start");
      setRunning(false);
    };

    worker.postMessage({
      id: 1,
      kind: "bench",
      facelets: BENCH_FACELETS,
      runs: 3,
    } satisfies BenchRequest);
  }, []);

  const ratio = (measured: number, reference: number) => measured / reference;

  return (
    <details className="rounded-lg border border-neutral-800 bg-neutral-950/40 p-3">
      <summary className="cursor-pointer text-sm font-medium text-neutral-200">
        Planner performance
        {running && <span className="ml-2 text-emerald-400">● Running</span>}
      </summary>
      <div className="mt-3 space-y-3 text-xs text-neutral-400">
        <p>
          Times a fixed workload on this device, so the result is comparable with a desktop rather
          than with whatever the cube was showing. Takes a few seconds and blocks nothing — it runs
          in a worker of its own.
        </p>

        <button
          type="button"
          onClick={run}
          disabled={running}
          className="rounded-md border border-neutral-700 px-3 py-2 text-xs text-neutral-200 hover:bg-neutral-800 disabled:cursor-not-allowed disabled:opacity-40"
        >
          {running ? "Measuring…" : "Run benchmark"}
        </button>

        {error && (
          <p className="text-red-300" role="alert">
            {error}
          </p>
        )}

        {result && (
          <>
            <div className="grid grid-cols-2 gap-x-4 gap-y-2 sm:grid-cols-3">
              <Stat
                label="Cross tables (cold)"
                value={`${result.tableBuildMs.toFixed(0)} ms`}
                note={`${ratio(result.tableBuildMs, REFERENCE.tableBuildMs).toFixed(1)}× desktop`}
              />
              <Stat label="One colour" value={`${result.singleColourMs.toFixed(0)} ms`} />
              <Stat
                label={`Sweep, median of ${result.runs}`}
                value={`${(result.sweepMedianMs / 1000).toFixed(2)} s`}
                note={`${ratio(result.sweepMedianMs, REFERENCE.sweepMedianMs).toFixed(1)}× desktop`}
              />
              <Stat label="Sweep, worst" value={`${(result.sweepWorstMs / 1000).toFixed(2)} s`} />
              <Stat label="Next pair + lookahead" value={`${result.nextPairMs.toFixed(0)} ms`} />
              <Stat
                label="Of inspection"
                value={`${((result.sweepMedianMs / INSPECTION_MS) * 100).toFixed(0)}%`}
                note="15 s budget"
              />
            </div>

            {/*
              Two numbers, two verdicts, because they answer different questions.

              What a user *waits* for is the first colour: results stream per colour, so a sweep's
              total is the longest anyone waits rather than the first thing they see. That is the
              responsiveness number.

              The sweep total is the cost of colour-neutrality. Judging it against inspection is
              not "does it fit" — inspection is for the human to plan in. Spending a third of it
              waiting is not comfortable, whatever fits.
            */}
            <p className={result.singleColourMs > 2000 ? "text-amber-200" : "text-emerald-300"}>
              First result in {(result.singleColourMs / 1000).toFixed(2)} s
              {result.singleColourMs > 2000
                ? " — slow enough to notice before anything appears."
                : " — fast enough to feel immediate."}
            </p>
            <p
              className={
                result.sweepMedianMs > INSPECTION_MS
                  ? "text-red-300"
                  : result.sweepMedianMs > INSPECTION_MS / 3
                    ? "text-amber-200"
                    : "text-emerald-300"
              }
            >
              {result.sweepMedianMs > INSPECTION_MS
                ? "All six colours does not fit inside inspection on this device."
                : result.sweepMedianMs > INSPECTION_MS / 3
                  ? `All six colours costs ${((result.sweepMedianMs / INSPECTION_MS) * 100).toFixed(0)}% of inspection — time the solver spends that you wanted for planning. One colour is the default for that reason.`
                  : "All six colours is affordable on this device."}
            </p>

            <p className="font-mono text-[11px] leading-relaxed text-neutral-500">
              per-face table build:{" "}
              {result.tableBuildPerFaceMs.map((ms) => ms.toFixed(0)).join(" / ")} ms
            </p>
          </>
        )}

        <p>
          Desktop reference, same workload: {REFERENCE.tableBuildMs} ms to build the tables,{" "}
          {(REFERENCE.sweepMedianMs / 1000).toFixed(2)} s median sweep. The first cross appears well
          before a sweep finishes — results stream per colour — so the sweep figure is the longest
          anyone waits, not the first thing they see.
        </p>
      </div>
    </details>
  );
}

function Stat({ label, value, note }: { label: string; value: string; note?: string }) {
  return (
    <div>
      <div>{label}</div>
      <div className="font-mono text-neutral-200">{value}</div>
      {note && <div className="text-[10px] text-neutral-500">{note}</div>}
    </div>
  );
}
