"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { ColourPlan } from "@cubing-companion/planner";
import type {
  NextPairRequest,
  ParityRequest,
  PlanRequest,
  PlanResponse,
  RankedPair,
} from "../workers/planner.worker";

export interface PlannerState {
  /** Plans that have arrived so far, cheapest cross first. */
  readonly plans: readonly ColourPlan[];
  readonly running: boolean;
  readonly elapsedMs: number | null;
  readonly error: string | null;
  /** B3's pair-order ranking, when that is what was asked for. */
  readonly ranked: readonly RankedPair[] | null;
  /** False when the model could not be loaded and move count stood in for it. */
  readonly learned: boolean | null;
  /** The cross the pair ranking was done against; null when none is built. */
  readonly rankedCross: number | null;
  /** Result of a model parity self-check, when one has been asked for. */
  readonly parity: { readonly rows: number; readonly worst: number } | null;
  /** True once B3's cross model has re-ranked at least one colour. */
  readonly revised: boolean;
}

const IDLE: PlannerState = {
  plans: [],
  running: false,
  elapsedMs: null,
  error: null,
  ranked: null,
  learned: null,
  rankedCross: null,
  parity: null,
  revised: false,
};

/**
 * Owns the planner worker.
 *
 * One worker for the life of the panel: the cross tables it builds are worth keeping, and
 * throwing it away between requests would pay the ~490 ms build every time.
 *
 * The worker processes messages one at a time and cannot be interrupted mid-sweep, so a rapid
 * series of requests would queue up behind each other. Two things keep that in hand — the caller
 * debounces, and every result carries the id of the request that produced it, so anything
 * arriving for a superseded position is dropped rather than shown.
 */
export function usePlanner() {
  const workerRef = useRef<Worker | null>(null);
  const requestRef = useRef(0);
  const [state, setState] = useState<PlannerState>(IDLE);

  useEffect(() => {
    // Constructed with `new URL(..., import.meta.url)` because that is the form the bundler
    // recognises; a string path is not rewritten and fails at runtime.
    const worker = new Worker(new URL("../workers/planner.worker.ts", import.meta.url));
    workerRef.current = worker;

    worker.onmessage = (event: MessageEvent<PlanResponse>) => {
      const message = event.data;
      if (message.id !== requestRef.current) return; // a position we have moved on from

      setState((previous) => {
        switch (message.kind) {
          case "colour": {
            // A revision replaces the colour it revises rather than appending beside it.
            const others = previous.plans.filter(
              (plan) => plan.crossFace !== message.plan.crossFace,
            );
            return {
              ...previous,
              revised: message.revised === true || previous.revised,
              plans: [...others, message.plan].sort(
                (a, b) => a.crossLength - b.crossLength,
              ),
            };
          }
          case "done":
            return { ...previous, running: false, elapsedMs: message.elapsedMs };
          case "next-pair":
            return {
              ...previous,
              running: false,
              ranked: message.ranked,
              learned: message.learned,
              rankedCross: message.crossFace,
            };
          case "parity":
            return {
              ...previous,
              running: false,
              parity: { rows: message.rows, worst: message.worst },
            };
          case "error":
            return { ...previous, running: false, error: message.message };
        }
      });
    };

    worker.onerror = (event) =>
      setState((previous) => ({
        ...previous,
        running: false,
        error: event.message || "the planner worker failed to start",
      }));

    return () => {
      worker.terminate();
      workerRef.current = null;
    };
  }, []);

  const plan = useCallback((request: Omit<PlanRequest, "id" | "kind">) => {
    const worker = workerRef.current;
    if (!worker) return;
    const id = requestRef.current + 1;
    requestRef.current = id;
    setState({ ...IDLE, running: true });
    worker.postMessage({ ...request, kind: "plan", id } satisfies PlanRequest);
  }, []);

  /** Ask B3's ranker which pair to do next from the position given. */
  const rankPairs = useCallback((request: Omit<NextPairRequest, "id" | "kind">) => {
    const worker = workerRef.current;
    if (!worker) return;
    const id = requestRef.current + 1;
    requestRef.current = id;
    setState({ ...IDLE, running: true });
    worker.postMessage({ ...request, kind: "next-pair", id } satisfies NextPairRequest);
  }, []);

  /** Diagnostic: score the exported fixture and compare with what PyTorch produced. */
  const checkParity = useCallback((model: ParityRequest["model"]) => {
    const worker = workerRef.current;
    if (!worker) return;
    const id = requestRef.current + 1;
    requestRef.current = id;
    setState({ ...IDLE, running: true });
    worker.postMessage({ kind: "parity", model, id } satisfies ParityRequest);
  }, []);

  const reset = useCallback(() => {
    // Bumping the id abandons anything still in flight.
    requestRef.current += 1;
    setState(IDLE);
  }, []);

  return { ...state, plan, rankPairs, checkParity, reset };
}
