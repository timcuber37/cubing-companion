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
import { fromFacelets, normalizeOrientation, type Face } from "@cubing-companion/engine";
import { GEOMETRY, isSlotSolved, slotName } from "@cubing-companion/analysis";
import { crossDistance, enumerateF2LInsertion } from "@cubing-companion/solver";
import {
  planColour,
  rankByMoveCount,
  rankNextPair,
  rerankCross,
  type ColourPlan,
} from "@cubing-companion/planner";
import { loadScorer } from "./model";

export interface PlanRequest {
  /** Echoed back, so the page can drop results for a position it has already moved on from. */
  readonly id: number;
  readonly kind: "plan";
  readonly facelets: string;
  readonly crossFaces: number[];
  readonly keep?: number;
  readonly crossOnly?: boolean;
}

/** "Which pair next" — B3's learned ranking, over the slots still open. */
export interface NextPairRequest {
  readonly id: number;
  readonly kind: "next-pair";
  readonly facelets: string;
  /** Colours to consider; whichever already has its cross built is the one used. */
  readonly crossFaces: number[];
}

export interface RankedPair {
  readonly slot: string;
  readonly optimal: number;
  readonly moves: string;
  readonly confidence: number;
}

/** Which cross the ranking was done against, or null when none is built yet. */
export type NextPairCross = number | null;

/**
 * Asks the worker to score the exported fixture and report the worst disagreement with PyTorch.
 *
 * Deliberately routed through `loadScorer`, the same path inference uses, so it proves the
 * shipped loader — model URL, tensor shape, output name and all — rather than a parallel copy
 * that could be right while production is wrong.
 */
export interface ParityRequest {
  readonly id: number;
  readonly kind: "parity";
  readonly model: "pair" | "cross";
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
      readonly kind: "parity";
      readonly rows: number;
      /** Largest absolute difference from the score PyTorch produced for the same input. */
      readonly worst: number;
    }
  | {
      readonly id: number;
      readonly kind: "next-pair";
      readonly ranked: readonly RankedPair[];
      /** False when the model could not be loaded and move count was used instead. */
      readonly learned: boolean;
      readonly crossFace: NextPairCross;
    };

const post = (message: PlanResponse): void => {
  (self as unknown as Worker).postMessage(message);
};

self.onmessage = (event: MessageEvent<PlanRequest | NextPairRequest | ParityRequest>) => {
  const request = event.data;
  const startedAt = Date.now();

  if (request.kind === "next-pair") {
    void rankPairs(request);
    return;
  }
  if (request.kind === "parity") {
    void checkParity(request);
    return;
  }

  try {
    const state = fromFacelets(request.facelets);
    const plans: ColourPlan[] = [];
    for (const face of request.crossFaces) {
      const plan = planColour(state, face as Face, {
        keep: request.keep ?? 3,
        crossOnly: request.crossOnly ?? false,
      });
      plans.push(plan);
      post({ id: request.id, kind: "colour", plan });
    }
    post({ id: request.id, kind: "done", elapsedMs: Date.now() - startedAt });
    // Then improve on it. The search is what takes the time, so the heuristic ordering goes out
    // immediately and the model's revision follows a moment later rather than holding it up.
    void reviseWithModel(request.id, plans);
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

/**
 * Re-rank each colour's crosses with B3's model, and post the revised plans.
 *
 * B3's cross head beats A4's comfort heuristic by 9.6 points on unseen solvers, so where the
 * model loads it decides both the ordering and the grip. Where it does not, the heuristic
 * ordering already sent stands — the planner degrades to A4 rather than to nothing.
 */
async function reviseWithModel(id: number, plans: readonly ColourPlan[]): Promise<void> {
  const score = await loadScorer("cross");
  if (score === null) return;

  for (const plan of plans) {
    try {
      const cross = await rerankCross(plan.cross, score);
      post({ id, kind: "colour", plan: { ...plan, cross }, revised: true });
    } catch {
      // A model that misbehaves on one colour should not take the others down with it.
    }
  }
}

/** Score the exported fixture and report the worst disagreement with PyTorch. */
async function checkParity(request: ParityRequest): Promise<void> {
  try {
    const score = await loadScorer(request.model);
    if (score === null) throw new Error(`could not load the ${request.model} model`);
    const fixture = (await (await fetch(`/models/${request.model}.fixture.json`)).json()) as {
      input: number[][];
      expected: number[];
    };
    const got = await score(fixture.input);
    let worst = 0;
    for (const [i, value] of got.entries()) {
      worst = Math.max(worst, Math.abs(value - fixture.expected[i]!));
    }
    post({ id: request.id, kind: "parity", rows: got.length, worst });
  } catch (error) {
    post({
      id: request.id,
      kind: "error",
      message: error instanceof Error ? error.message : String(error),
    });
  }
}

/**
 * Rank the open slots by which pair a pro would fill next.
 *
 * Searching happens here so one set of insertion results feeds both the model's features and
 * what gets shown. If the model will not load, this falls back to ordering by move count and
 * says so rather than going quiet — a missing download should cost the learned ranking, not the
 * advice.
 */
async function rankPairs(request: NextPairRequest): Promise<void> {
  try {
    const state = normalizeOrientation(fromFacelets(request.facelets));
    // Which cross is already up? Ranking pairs only means something once one is, and asking the
    // position beats asking the user to tell us what they just built.
    const crossFace = request.crossFaces.find(
      (face) => crossDistance(state, face as Face) === 0,
    ) as Face | undefined;
    if (crossFace === undefined) {
      post({ id: request.id, kind: "next-pair", learned: false, ranked: [], crossFace: null });
      return;
    }
    const geometry = GEOMETRY[crossFace]!;
    const open = geometry.slots.filter((slot) => !isSlotSolved(state, slot));

    const searched = open.map((slot) => {
      const result = enumerateF2LInsertion(state, crossFace, slot, { maxSolutions: 60 });
      return {
        slot,
        optimal: result.optimal,
        ways: result.candidates.length,
        bestMoves: result.candidates[0]?.moves ?? [],
      };
    });
    const usable = searched.filter((candidate) => candidate.optimal >= 0);
    const describe = (slot: (typeof usable)[number]) =>
      slot.bestMoves.map((m) => `${m.family}${m.amount === 2 ? "2" : m.amount === -1 ? "'" : ""}`).join(" ");

    const score = await loadScorer("pair");
    if (score === null || usable.length === 0) {
      post({
        id: request.id,
        kind: "next-pair",
        learned: false,
        crossFace,
        ranked: rankByMoveCount(usable).map((candidate) => ({
          slot: slotName(candidate.slot),
          optimal: candidate.optimal,
          moves: describe(candidate),
          confidence: 0,
        })),
      });
      return;
    }

    const ranked = await rankNextPair(state, geometry, usable, { previous: null, step: 4 - open.length }, score);
    post({
      id: request.id,
      kind: "next-pair",
      learned: true,
      crossFace,
      ranked: ranked.map((entry) => ({
        slot: slotName(entry.slot),
        optimal: entry.optimal,
        moves: describe(usable.find((c) => c.slot === entry.slot)!),
        confidence: entry.confidence,
      })),
    });
  } catch (error) {
    post({
      id: request.id,
      kind: "error",
      message: error instanceof Error ? error.message : String(error),
    });
  }
}
