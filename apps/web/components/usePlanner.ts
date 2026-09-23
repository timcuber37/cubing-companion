"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { emitDiagnosticTiming } from "./diagnosticTimings";
import type { ColourPlan } from "@cubing-companion/planner";
import type {
  CrossDiff,
  DiffRequest,
  NextPairRequest,
  PairDiff,
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
  /** False when the learned preference is unavailable; continuation search still runs. */
  readonly learned: boolean | null;
  /** The cross the pair ranking was done against; null when none is built. */
  readonly rankedCross: number | null;
  /** True once B3's cross model has re-ranked at least one colour. */
  readonly revised: boolean;
  /** A5's decision-by-decision comparison of a recorded solve. */
  readonly diff: {
    readonly cross: CrossDiff | null;
    readonly pairs: readonly PairDiff[];
    readonly learned: boolean;
    readonly failure?: string;
  } | null;
}

const IDLE: PlannerState = {
  plans: [],
  running: false,
  elapsedMs: null,
  error: null,
  ranked: null,
  learned: null,
  rankedCross: null,
  revised: false,
  diff: null,
};

/**
 * Owns the planner worker.
 *
 * One worker for the life of the panel: the cross tables it builds are worth keeping, and
 * throwing it away between requests would pay the ~490 ms build every time.
 *
 * The worker yields between colours so a new position can cancel the remaining sweep. The
 * caller also debounces, and request IDs keep superseded results out of the view.
 */
export function usePlanner() {
  const workerRef = useRef<Worker | null>(null);
  const requestRef = useRef(0);
  const requestStartedAt = useRef<number | null>(null);
  const [state, setState] = useState<PlannerState>(IDLE);

  useEffect(() => {
    // Constructed with `new URL(..., import.meta.url)` because that is the form the bundler
    // recognises; a string path is not rewritten and fails at runtime.
    const worker = new Worker(new URL("../workers/planner.worker.ts", import.meta.url));
    workerRef.current = worker;

    worker.onmessage = (event: MessageEvent<PlanResponse>) => {
      const message = event.data;
      if (message.id !== requestRef.current) return; // a position we have moved on from

      if (["done", "next-pair", "diff"].includes(message.kind) && requestStartedAt.current !== null) {
        emitDiagnosticTiming("planner", performance.now() - requestStartedAt.current, message.kind);
        requestStartedAt.current = null;
      }

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
          case "diff":
            return {
              ...previous,
              running: false,
              diff: {
                cross: message.cross,
                pairs: message.pairs,
                learned: message.learned,
                ...(message.failure === undefined ? {} : { failure: message.failure }),
              },
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
    requestStartedAt.current = performance.now();
    worker.postMessage({ ...request, kind: "plan", id } satisfies PlanRequest);
  }, []);

  /** Ask B3's ranker which pair to do next from the position given. */
  const rankPairs = useCallback((request: Omit<NextPairRequest, "id" | "kind">) => {
    const worker = workerRef.current;
    if (!worker) return;
    const id = requestRef.current + 1;
    requestRef.current = id;
    setState({ ...IDLE, running: true });
    requestStartedAt.current = performance.now();
    worker.postMessage({ ...request, kind: "next-pair", id } satisfies NextPairRequest);
  }, []);

  /** A5: compare a recorded solve against what a top solver would likely have done. */
  const diffSolve = useCallback((request: Omit<DiffRequest, "id" | "kind">) => {
    const worker = workerRef.current;
    if (!worker) return;
    const id = requestRef.current + 1;
    requestRef.current = id;
    setState({ ...IDLE, running: true });
    requestStartedAt.current = performance.now();
    worker.postMessage({ ...request, kind: "diff", id } satisfies DiffRequest);
  }, []);

  const reset = useCallback(() => {
    // Bumping the id abandons anything still in flight.
    requestRef.current += 1;
    requestStartedAt.current = null;
    setState(IDLE);
  }, []);

  return { ...state, plan, rankPairs, diffSolve, reset };
}
