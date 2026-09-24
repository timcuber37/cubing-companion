/**
 * The planner sweep, off the main thread.
 *
 * A colour-neutral sweep — cross plus all four xcrosses, for every colour — runs a median of
 * 1.9 s and a worst case over 5 s. That is not something the UI thread can absorb: the cube stops
 * animating, the buttons stop responding, and the app looks broken exactly when it is working.
 *
 * A2 concluded workers were unusable here, but that was cubing.js's WASM *module* worker
 * specifically. A plain worker built from our own TypeScript loads and runs fine under Turbopack,
 * which was verified in a browser before this was written.
 *
 * Results are posted **per colour rather than in one batch**, so the first cross appears in about
 * 150 ms instead of after the whole sweep. The cross tables live in module scope, so a second
 * request to the same worker skips the ~490 ms of table building the first one paid.
 */
import { applyMoves, fromFacelets, normalizeOrientation, parseMoves, type Face } from "@cubing-companion/engine";
import { crossDistance, solveCross } from "@cubing-companion/solver";
import {
  diffSolve as reviewSolve,
  lookaheadPairs,
  planColour,
  rankOpenPairs,
  rerankCross,
  scorerFor,
  type ColourPlan,
} from "@cubing-companion/planner";

export interface PlanRequest {
  /** Echoed back, so the page can drop results for a position it has already moved on from. */
  readonly id: number;
  readonly kind: "plan";
  readonly facelets: string;
  readonly crossFaces: number[];
  readonly keep?: number;
  readonly crossOnly?: boolean;
  readonly lookahead?: boolean;
  /**
   * Wall-clock budget per colour, in milliseconds.
   *
   * Insurance rather than routine: a colour typically costs ~425 ms on a desktop and ~966 ms on an
   * iPhone 11, so a budget set generously above that only ever bites on a position that has gone
   * pathological. Where it does bite the advice is truncated rather than absent, which is the
   * better failure — and `stats.truncated` records that it happened.
   */
  readonly deadlineMs?: number;
}

/** "Which pair next" — B3's learned ranking, over the slots still open. */
export interface NextPairRequest {
  readonly id: number;
  readonly kind: "next-pair";
  readonly facelets: string;
  /** Colours to consider; whichever already has its cross built is the one used. */
  readonly crossFaces: number[];
  /** Include the current pair in the horizon. Defaults to two pairs. */
  readonly lookaheadDepth?: number;
}

// The review's result types moved with its logic to `packages/planner/src/review.ts`; re-exported
// so the components that read them from here need not change.
import type { CrossDiff, PairDiff, RankedPair } from "@cubing-companion/planner";
export type { CrossDiff, DiffOption, PairDiff, PairForecast, RankedPair } from "@cubing-companion/planner";

export type NextPairCross = number | null;

export interface DiffRequest {
  readonly id: number;
  readonly kind: "diff";
  readonly startFacelets: string;
  readonly solution: string;
}

export interface BenchRequest {
  readonly id: number;
  readonly kind: "bench";
  /** Position to plan from. The caller supplies one so the workload is identical across devices. */
  readonly facelets: string;
  /** Sweeps to time after the tables are warm. The median is reported. */
  readonly runs?: number;
}

export interface BenchResult {
  /** Building all six cross tables from cold: 190,080 positions each, breadth-first. */
  readonly tableBuildMs: number;
  readonly tableBuildPerFaceMs: readonly number[];
  /** One colour, tables warm. */
  readonly singleColourMs: number;
  /** All six colours — the colour-neutral sweep, and the number that has to fit inspection. */
  readonly sweepMedianMs: number;
  readonly sweepWorstMs: number;
  /** Ranking which pair to do next, including the two-pair lookahead. */
  readonly nextPairMs: number;
  readonly runs: number;
}

export type PlanResponse =
  | {
      readonly id: number;
      readonly kind: "colour";
      readonly plan: ColourPlan;
      /** True when B3's model has re-ranked this colour, replacing the heuristic order. */
      readonly revised?: boolean;
    }
  | { readonly id: number; readonly kind: "done"; readonly elapsedMs: number }
  | { readonly id: number; readonly kind: "error"; readonly message: string }
  | {
      readonly id: number;
      readonly kind: "diff";
      readonly cross: CrossDiff | null;
      readonly pairs: readonly PairDiff[];
      /** False when the model would not load and only the search-based numbers are present. */
      readonly learned: boolean;
      readonly failure?: string;
    }
  | { readonly id: number; readonly kind: "bench"; readonly result: BenchResult }
  | {
      readonly id: number;
      readonly kind: "next-pair";
      readonly ranked: readonly RankedPair[];
      /** False when learned preference is unavailable; lookahead still runs. */
      readonly learned: boolean;
      readonly crossFace: NextPairCross;
    };

let activeRequest = 0;
const post = (message: PlanResponse): void => {
  if (message.id !== activeRequest) return;
  (self as unknown as Worker).postMessage(message);
};

self.onmessage = async (
  event: MessageEvent<PlanRequest | NextPairRequest | DiffRequest | BenchRequest>,
) => {
  const request = event.data;
  activeRequest = request.id;
  const startedAt = Date.now();

  if (request.kind === "next-pair") {
    void rankPairs(request);
    return;
  }
  if (request.kind === "diff") {
    void diffSolve(request);
    return;
  }
  if (request.kind === "bench") {
    void bench(request);
    return;
  }

  try {
    const state = fromFacelets(request.facelets);
    const plans: ColourPlan[] = [];
    for (const face of request.crossFaces) {
      const plan = planColour(state, face as Face, {
        keep: request.keep ?? 3,
        crossOnly: request.crossOnly ?? false,
        lookahead: request.lookahead ?? true,
        ...(request.deadlineMs === undefined ? {} : { deadlineMs: request.deadlineMs }),
      });
      plans.push(plan);
      post({ id: request.id, kind: "colour", plan });
      // Let a newer scramble cancel the rest of this sweep before starting another colour.
      await new Promise<void>((resolve) => setTimeout(resolve, 0));
      if (request.id !== activeRequest) return;
    }
    post({ id: request.id, kind: "done", elapsedMs: Date.now() - startedAt });
    // Then improve on it. The search is what takes the time, so the heuristic ordering goes out
    // immediately and the model's revision follows a moment later rather than holding it up.
    void reviseWithModel(request.id, plans, state.centers);
  } catch (error) {
    // A malformed facelet string is the likely cause, and it must not kill the worker: the next
    // request would then find nothing listening.
    post({
      id: request.id,
      kind: "error",
      message: error instanceof Error ? error.message : String(error),
    });
  }
};

/** All six cross colours, in the protocol's own face order. */
const ALL_FACES = [0, 1, 2, 3, 4, 5] as Face[];

/** Median, which is what to quote for a sweep: one slow run should not define the budget. */
function median(values: readonly number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0
    ? ((sorted[middle - 1] ?? 0) + (sorted[middle] ?? 0)) / 2
    : (sorted[middle] ?? 0);
}

/** Time the planner on whatever device this worker is running on. */
async function bench(request: BenchRequest): Promise<void> {
  try {
    const state = fromFacelets(request.facelets);
    const runs = request.runs ?? 3;
    const options = { keep: 3, crossOnly: false, lookahead: true } as const;

    // Cold: the first touch of each colour is what pays for its table.
    const tableBuildPerFaceMs: number[] = [];
    for (const face of ALL_FACES) {
      const started = performance.now();
      crossDistance(state, face);
      tableBuildPerFaceMs.push(performance.now() - started);
    }
    const tableBuildMs = tableBuildPerFaceMs.reduce((total, ms) => total + ms, 0);

    // Warm from here: tables are built, so this is search time and nothing else.
    const singleStarted = performance.now();
    planColour(state, ALL_FACES[0]!, options);
    const singleColourMs = performance.now() - singleStarted;

    const sweeps: number[] = [];
    for (let run = 0; run < runs; run++) {
      const started = performance.now();
      for (const face of ALL_FACES) planColour(state, face, options);
      sweeps.push(performance.now() - started);
      // Yield between runs so a long benchmark cannot wedge the worker.
      await new Promise<void>((resolve) => setTimeout(resolve, 0));
    }

    // Pair ranking only means anything once a cross is built, so build one first — and leave it
    // out of the timing, because the measurement is of the lookahead rather than of the cross.
    const normalised = normalizeOrientation(state);
    const crossFace = ALL_FACES[0]!;
    const crossMoves = solveCross(normalised, crossFace);
    let nextPairMs = 0;
    if (crossMoves) {
      const afterCross = applyMoves(normalised, crossMoves);
      const pairStarted = performance.now();
      lookaheadPairs(afterCross, crossFace);
      nextPairMs = performance.now() - pairStarted;
    }

    post({
      id: request.id,
      kind: "bench",
      result: {
        tableBuildMs,
        tableBuildPerFaceMs,
        singleColourMs,
        sweepMedianMs: median(sweeps),
        sweepWorstMs: Math.max(...sweeps),
        nextPairMs,
        runs,
      },
    });
  } catch (error) {
    post({
      id: request.id,
      kind: "error",
      message: error instanceof Error ? error.message : String(error),
    });
  }
}

/**
 * Re-rank each colour's crosses with B3's model, and post the revised plans.
 *
 * B3's cross head beats A4's comfort heuristic by 9.6 points on unseen solvers, so where the
 * model loads it decides both the ordering and the grip. Where it does not, the heuristic
 * ordering already sent stands — the planner degrades to A4 rather than to nothing.
 */
async function reviseWithModel(
  id: number,
  plans: readonly ColourPlan[],
  /** Centres of the state the plans were made from, so re-picked grips keep a correct setup. */
  centres: ArrayLike<number>,
): Promise<void> {
  const score = scorerFor("cross");
  if (score === null || id !== activeRequest) return;

  for (const plan of plans) {
    try {
      const cross = await rerankCross(plan.cross, score, centres);
      post({ id, kind: "colour", plan: { ...plan, cross }, revised: true });
    } catch {
      // A model that misbehaves on one colour should not take the others down with it.
    }
  }
}

/**
 * A5: walk a recorded solve and say, at each decision, what a top solver would likely have done.
 * The logic is `diffSolve` in `packages/planner/src/review.ts`; this only carries it off the main
 * thread and abandons it when a newer request arrives.
 */
async function diffSolve(request: DiffRequest): Promise<void> {
  try {
    const diff = await reviewSolve(
      fromFacelets(request.startFacelets),
      parseMoves(request.solution),
      { cross: scorerFor("cross"), pair: scorerFor("pair") },
      () => request.id === activeRequest,
    );
    if (!diff || request.id !== activeRequest) return;
    post({ id: request.id, kind: "diff", ...diff });
  } catch (error) {
    post({
      id: request.id,
      kind: "error",
      message: error instanceof Error ? error.message : String(error),
    });
  }
}

/** Rank the open slots by which pair a pro would fill next: `rankOpenPairs`, off the main thread. */
async function rankPairs(request: NextPairRequest): Promise<void> {
  try {
    const result = await rankOpenPairs(
      fromFacelets(request.facelets),
      request.crossFaces as Face[],
      scorerFor("pair"),
      request.lookaheadDepth ?? 2,
    );
    if (request.id !== activeRequest) return;
    post({ id: request.id, kind: "next-pair", ...result });
  } catch (error) {
    post({
      id: request.id,
      kind: "error",
      message: error instanceof Error ? error.message : String(error),
    });
  }
}
