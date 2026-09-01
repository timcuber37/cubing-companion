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
import { GEOMETRY, isSlotSolved, segmentFromState, slotName } from "@cubing-companion/analysis";
import { crossDistance, enumerateF2LInsertion } from "@cubing-companion/solver";
import {
  attribute,
  colourName,
  confidenceWording,
  crossDecision,
  pairDecisions,
  planColour,
  rankByMoveCount,
  rankNextPair,
  reasons,
  rerankCross,
  rotationBetween,
  slotColours,
  type ColourPlan,
} from "@cubing-companion/planner";
import { enumerateCross } from "@cubing-companion/solver";
import { applyMoves, parseMoves, serializeMoves, type Move } from "@cubing-companion/engine";
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
  /** The internal key, stable across frames — the model's and dataset's identity for the slot. */
  readonly slot: string;
  /** The slot by its side colours — "green-red" — which is how the UI names it. */
  readonly label: string;
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
/** A5: score a recorded solve decision by decision, and say what a pro would likely have done. */
export interface DiffRequest {
  readonly id: number;
  readonly kind: "diff";
  /** The position the solve began from. */
  readonly startFacelets: string;
  readonly solution: string;
}

export interface DiffOption {
  /** Internal key; stable across frames. */
  readonly slot: string;
  /** The pair by its side colours, which is how the UI names it. */
  readonly label: string;
  readonly optimal: number;
  readonly moves: string;
  readonly confidence: number;
  readonly mine: boolean;
}

export interface PairDiff {
  readonly step: number;
  /** Move index the decision was acted on, for jumping the replay there. */
  readonly at: number;
  readonly yours: string;
  readonly theirs: string;
  /** Every open slot, ranked by the model, with yours marked. */
  readonly options: readonly DiffOption[];
  /** "would most likely take", softened when the model is unsure. */
  readonly wording: string;
  readonly reasons: readonly string[];
  /** Turns you actually spent filling it, against the optimum. */
  readonly playedTurns: number;
  readonly optimalTurns: number;
  /** The alternative's moves, for branch playback. */
  readonly branch: string;
}

export interface CrossDiff {
  readonly at: number;
  readonly end: number;
  readonly playedTurns: number;
  readonly optimalTurns: number;
  /** Rotations from the position the solve started in to the recommended grip — dim in the UI. */
  readonly setup: string;
  readonly best: string;
  readonly hold: string;
  readonly branch: string;
}

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
      readonly kind: "diff";
      readonly cross: CrossDiff | null;
      readonly pairs: readonly PairDiff[];
      /** False when the model would not load and only the search-based numbers are present. */
      readonly learned: boolean;
      readonly failure?: string;
    }
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

self.onmessage = (
  event: MessageEvent<PlanRequest | NextPairRequest | ParityRequest | DiffRequest>,
) => {
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
  if (request.kind === "diff") {
    void diffSolve(request);
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
  const score = await loadScorer("cross");
  if (score === null) return;

  for (const plan of plans) {
    try {
      const cross = await rerankCross(plan.cross, score, centres);
      post({ id, kind: "colour", plan: { ...plan, cross }, revised: true });
    } catch {
      // A model that misbehaves on one colour should not take the others down with it.
    }
  }
}

const notation = (moves: readonly Move[]) => serializeMoves([...moves]);

/** The normalised frame's centre arrangement: colour i at face i. */
const HOME_CENTRES = [0, 1, 2, 3, 4, 5] as const;

/**
 * The rotations that put a cube into the normalised frame — the frame every search result is
 * expressed in. Prefixed onto any sequence shown or played against the raw state, so it is
 * literally executable from the position the cube is actually in. Empty for a smart cube, whose
 * centres never move; the fix exists for manual solves, where they do.
 */
const normalisingSetup = (centres: ArrayLike<number>): Move[] =>
  rotationBetween(centres, HOME_CENTRES);

/**
 * A5: walk a recorded solve and say, at each decision, what a top solver would likely have done.
 *
 * Two independent kinds of feedback, deliberately kept apart. **Choice** comes from the model and
 * is uncertain — it agrees with a real pro 69.6% of the time, so it reports a distribution and
 * never a verdict. **Execution** comes from the search and is not uncertain at all: nine moves
 * against six is a fact, model or no model.
 */
async function diffSolve(request: DiffRequest): Promise<void> {
  try {
    const start = fromFacelets(request.startFacelets);
    const solution = parseMoves(request.solution);
    const { segmentation } = segmentFromState(start, solution);
    const spans = segmentation?.spans;
    if (!segmentation || !spans) {
      post({
        id: request.id,
        kind: "diff",
        cross: null,
        pairs: [],
        learned: false,
        failure: "this solve could not be segmented, so there are no decisions to compare",
      });
      return;
    }

    const crossFace = segmentation.crossFace;
    const score = await loadScorer("pair");

    // The cross needs no model to be useful: your length against the optimum is a fact. The
    // model only picks which of the optimal crosses to show you.
    let cross: CrossDiff | null = null;
    const crossSearch = enumerateCross(normalizeOrientation(start), crossFace, {
      maxSolutions: 1,
    });
    const crossPart = crossDecision(start, solution, spans, crossFace, crossSearch.optimal);
    if (crossPart) {
      // Planned from the RAW position at the decision, not the normalised one `crossPart.state`
      // holds — the setup rotations are relative to where the cube actually was, and the branch
      // is applied to exactly that state. Planning from the normalised state was the bug: its
      // centres are always home, so the setup came out empty and the frame-renamed moves solved
      // the wrong pieces the moment the real frame differed.
      const rawAtCross = applyMoves(start, solution.slice(0, crossPart.at));
      const plan = planColour(rawAtCross, crossFace, { keep: 1, crossOnly: true });
      const crossScore = await loadScorer("cross");
      const ranked = crossScore
        ? await rerankCross(plan.cross, crossScore, rawAtCross.centers)
        : plan.cross;
      const best = ranked[0];
      cross = {
        at: crossPart.at,
        end: crossPart.end,
        playedTurns: crossPart.played,
        optimalTurns: crossPart.optimal,
        setup: best?.setupText ?? "",
        best: best?.text ?? "",
        hold: best
          ? `${colourName(best.hold.down)} down, ${colourName(best.hold.front)} front`
          : "",
        branch: best ? notation([...best.setup, ...best.moves]) : "",
      };
    }

    const pairs: PairDiff[] = [];
    for (const decision of pairDecisions(start, solution, spans, crossFace)) {
      const yours = decision.options[decision.chosen]!;
      const playedTurns = decision.playedMoves.filter((m) => !"xyz".includes(m.family)).length;
      // Search results are in the normalised frame; the branch replays against the raw state at
      // this move. The prefix bridges the two — empty for a smart cube, whose centres never
      // move, and exactly the missing rotations for a manual solve that rotated mid-way.
      const setup = normalisingSetup(applyMoves(start, solution.slice(0, decision.at)).centers);
      const executable = (moves: readonly Move[]) => notation([...setup, ...moves]);

      if (!score) {
        // Without the model there is no "which pair" advice, but the execution half still holds.
        pairs.push({
          step: decision.step,
          at: decision.at,
          yours: slotColours(yours.slot),
          theirs: slotColours(yours.slot),
          options: decision.options.map((option) => ({
            slot: option.name,
            label: slotColours(option.slot),
            optimal: option.optimal,
            moves: executable(option.bestMoves),
            confidence: 0,
            mine: option === yours,
          })),
          wording: "",
          reasons: [],
          playedTurns,
          optimalTurns: yours.optimal,
          branch: executable(yours.bestMoves),
        });
        continue;
      }

      const ranked = await rankNextPair(
        decision.state,
        GEOMETRY[crossFace]!,
        [...decision.options],
        { previous: null, step: decision.step },
        score,
      );
      const top = ranked[0]!;
      const theirs = decision.options.find((option) => option.slot === top.slot)!;

      pairs.push({
        step: decision.step,
        at: decision.at,
        yours: slotColours(yours.slot),
        theirs: slotColours(theirs.slot),
        options: ranked.map((entry) => {
          const option = decision.options.find((o) => o.slot === entry.slot)!;
          return {
            slot: option.name,
            label: slotColours(option.slot),
            optimal: option.optimal,
            moves: executable(option.bestMoves),
            confidence: entry.confidence,
            mine: option === yours,
          };
        }),
        wording: confidenceWording(top.confidence),
        reasons:
          theirs === yours
            ? []
            : reasons(await attribute(yours.features, theirs.features, score), {
                // Named by colour, because the reasons are read in whatever grip the reader is
                // actually holding — "FR's corner" means nothing after a y rotation.
                yours: slotColours(yours.slot),
                theirs: slotColours(theirs.slot),
              }),
        playedTurns,
        optimalTurns: yours.optimal,
        branch: executable(theirs.bestMoves),
      });
    }

    post({ id: request.id, kind: "diff", cross, pairs, learned: score !== null });
  } catch (error) {
    post({
      id: request.id,
      kind: "error",
      message: error instanceof Error ? error.message : String(error),
    });
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
    const raw = fromFacelets(request.facelets);
    const state = normalizeOrientation(raw);
    // The rotations from the cube's actual orientation into the search frame, so every sequence
    // shown is executable from the cube as it stands rather than as the search imagines it.
    const setup = normalisingSetup(raw.centers);
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
    const describe = (candidate: (typeof usable)[number]) =>
      notation([...setup, ...candidate.bestMoves]);

    const score = await loadScorer("pair");
    if (score === null || usable.length === 0) {
      post({
        id: request.id,
        kind: "next-pair",
        learned: false,
        crossFace,
        ranked: rankByMoveCount(usable).map((candidate) => ({
          slot: slotName(candidate.slot),
          label: slotColours(candidate.slot),
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
        label: slotColours(entry.slot),
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
