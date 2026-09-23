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
  lookaheadPairs,
  pairDecisions,
  planColour,
  rankNextPair,
  reasons,
  rerankCross,
  rotationBetween,
  scorerFor,
  slotColours,
  type ColourPlan,
  type Continuation,
} from "@cubing-companion/planner";
import { enumerateCross } from "@cubing-companion/solver";
import { applyMoves, parseMoves, serializeMoves, type Move } from "@cubing-companion/engine";

export interface PlanRequest {
  /** Echoed back, so the page can drop results for a position it has already moved on from. */
  readonly id: number;
  readonly kind: "plan";
  readonly facelets: string;
  readonly crossFaces: number[];
  readonly keep?: number;
  readonly crossOnly?: boolean;
  readonly lookahead?: boolean;
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

export interface RankedPair {
  /** The internal key, stable across frames — the model's and dataset's identity for the slot. */
  readonly slot: string;
  /** The slot by its side colours — "green-red" — which is how the UI names it. */
  readonly label: string;
  readonly optimal: number;
  readonly moves: string;
  readonly confidence: number;
  readonly lookahead: PairForecast | null;
}

export interface PairForecast {
  readonly depth: number;
  readonly immediateTurns: number;
  readonly totalTurns: number;
  readonly solvedPairs: number;
  /** Full continuation, including setup, executable from the decision position. */
  readonly branch: string;
  readonly steps: readonly { readonly label: string; readonly moves: string }[];
}

/** Which cross the ranking was done against, or null when none is built yet. */
export type NextPairCross = number | null;

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
  /** Rotations to reach the frame the insertion is written in — shown apart, being free. */
  readonly setup: string;
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
  /** What you actually turned to fill it, so the counts above have something behind them. */
  readonly played: string;
  /** The alternative's moves, for branch playback. */
  readonly branch: string;
  /** Search advice is distinct from the existing model's imitation prediction. */
  readonly lookahead?: { readonly label: string; readonly forecast: PairForecast };
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
  readonly lookahead?: { readonly label: string; readonly turns: number; readonly branch: string };
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
  event: MessageEvent<PlanRequest | NextPairRequest | DiffRequest>,
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

  try {
    const state = fromFacelets(request.facelets);
    const plans: ColourPlan[] = [];
    for (const face of request.crossFaces) {
      const plan = planColour(state, face as Face, {
        keep: request.keep ?? 3,
        crossOnly: request.crossOnly ?? false,
        lookahead: request.lookahead ?? true,
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

/** Describe the verified path without treating its search score as a probability. */
function forecast(plan: Continuation, crossFace: Face, depth: number, setup: readonly Move[]): PairForecast {
  const slots = GEOMETRY[crossFace]!.slots;
  return {
    depth,
    immediateTurns: plan.steps[0]?.moves.length ?? 0,
    totalTurns: plan.moves.length,
    solvedPairs: plan.solvedSlots.length,
    branch: notation([...setup, ...plan.moves]),
    steps: plan.steps.map((step, i) => ({
      label: slotColours(slots.find((slot) => slotName(slot) === step.slot)!),
      moves: notation(i === 0 ? [...setup, ...step.moves] : step.moves),
    })),
  };
}

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
    const score = scorerFor("pair");
    if (request.id !== activeRequest) return;

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
      const plan = planColour(rawAtCross, crossFace, { keep: 3, lookahead: true });
      const crossScore = scorerFor("cross");
      const ranked = crossScore
        ? await rerankCross(plan.cross, crossScore, rawAtCross.centers)
        : plan.cross;
      const best = ranked[0];
      const opening = plan.crossPlusTwo?.[0] ?? plan.crossPlusOne?.[0];
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
        ...(opening ? { lookahead: {
          label: opening.kind === "cross+2" ? "cross + 2 pairs" : "cross + 1 pair",
          turns: opening.length,
          branch: notation([...opening.setup, ...opening.moves]),
        } } : {}),
      };
    }

    const pairs: PairDiff[] = [];
    for (const decision of pairDecisions(start, solution, spans, crossFace)) {
      await new Promise<void>((resolve) => setTimeout(resolve, 0));
      if (request.id !== activeRequest) return;
      const yours = decision.options[decision.chosen]!;
      const playedTurns = decision.playedMoves.filter((m) => !"xyz".includes(m.family)).length;
      // Search results are in the normalised frame; the branch replays against the raw state at
      // this move. The prefix bridges the two — empty for a smart cube, whose centres never
      // move, and exactly the missing rotations for a manual solve that rotated mid-way.
      const setup = normalisingSetup(applyMoves(start, solution.slice(0, decision.at)).centers);
      const executable = (moves: readonly Move[]) => notation([...setup, ...moves]);
      const setupText = notation(setup);
      const deeper = lookaheadPairs(decision.state, crossFace);
      const continuation = deeper.options.find((option) => option.plan !== null);
      const searchAdvice = continuation?.plan ? {
        lookahead: {
          label: slotColours(continuation.slot),
          forecast: forecast(continuation.plan, crossFace, deeper.depth, setup),
        },
      } : {};

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
            setup: setupText,
            moves: notation(option.bestMoves),
            confidence: 0,
            mine: option === yours,
          })),
          wording: "",
          reasons: [],
          playedTurns,
          optimalTurns: yours.optimal,
          played: notation(decision.playedMoves),
          branch: executable(yours.bestMoves),
          ...searchAdvice,
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
            setup: setupText,
            moves: notation(option.bestMoves),
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
        // Recorded as it happened, so it is already executable from the position at this
        // decision — the same footing as the suggestions beside it, which are setup-prefixed.
        played: notation(decision.playedMoves),
        branch: executable(theirs.bestMoves),
        ...searchAdvice,
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

/**
 * Rank the open slots by which pair a pro would fill next.
 *
 * The original optimal insertion results still supply the model's feature contract. A separate
 * bounded search explores alternative executions and follow-up pairs; its completed totals rank
 * first, with model preference breaking ties. Lookahead also runs when the model cannot load.
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
    const score = scorerFor("pair");
    if (request.id !== activeRequest) return;
    const predicted = score && usable.length > 0
      ? await rankNextPair(state, geometry, usable, { previous: null, step: 4 - open.length }, score)
      : [];
    if (request.id !== activeRequest) return;
    const deeper = lookaheadPairs(state, crossFace, { depth: request.lookaheadDepth ?? 2 });
    const ranked = usable.map((candidate) => {
      const plan = deeper.options.find((option) => option.slot === candidate.slot)?.plan;
      const lookahead = plan ? forecast(plan, crossFace, deeper.depth, setup) : null;
      return {
        slot: slotName(candidate.slot),
        label: slotColours(candidate.slot),
        optimal: candidate.optimal,
        moves: plan?.steps[0] ? notation([...setup, ...plan.steps[0].moves]) : notation([...setup, ...candidate.bestMoves]),
        confidence: predicted.find((entry) => entry.slot === candidate.slot)?.confidence ?? 0,
        lookahead,
      };
    });
    ranked.sort((a, b) =>
      (a.lookahead?.totalTurns ?? Infinity) - (b.lookahead?.totalTurns ?? Infinity) ||
      b.confidence - a.confidence || a.optimal - b.optimal);
    post({ id: request.id, kind: "next-pair", learned: score !== null, crossFace, ranked });
  } catch (error) {
    post({
      id: request.id,
      kind: "error",
      message: error instanceof Error ? error.message : String(error),
    });
  }
}
