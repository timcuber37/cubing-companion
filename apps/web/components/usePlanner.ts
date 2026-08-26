"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { ColourPlan } from "@cubing-companion/planner";
import type { PlanRequest, PlanResponse } from "../workers/planner.worker";

export interface PlannerState {
  /** Plans that have arrived so far, cheapest cross first. */
  readonly plans: readonly ColourPlan[];
  readonly running: boolean;
  readonly elapsedMs: number | null;
  readonly error: string | null;
}

const IDLE: PlannerState = { plans: [], running: false, elapsedMs: null, error: null };

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
          case "colour":
            return {
              ...previous,
              plans: [...previous.plans, message.plan].sort(
                (a, b) => a.crossLength - b.crossLength,
              ),
            };
          case "done":
            return { ...previous, running: false, elapsedMs: message.elapsedMs };
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

  const plan = useCallback((request: Omit<PlanRequest, "id">) => {
    const worker = workerRef.current;
    if (!worker) return;
    const id = requestRef.current + 1;
    requestRef.current = id;
    setState({ plans: [], running: true, elapsedMs: null, error: null });
    worker.postMessage({ ...request, id } satisfies PlanRequest);
  }, []);

  const reset = useCallback(() => {
    // Bumping the id abandons anything still in flight.
    requestRef.current += 1;
    setState(IDLE);
  }, []);

  return { ...state, plan, reset };
}
