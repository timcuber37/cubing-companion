/**
 * Reviewing a solve and ranking the next pair — A5's decision diff, and the "which pair" advice.
 *
 * These lived inside `apps/web/workers/planner.worker.ts`, tangled with the worker's messaging, which
 * left them callable from nowhere else: not from a test, not from the vector oracle, and so not
 * checkable against a port. They are pure functions of a position, a solution and the model, so
 * they live here; the worker calls them and posts what they return.
 *
 * Two independent kinds of feedback, deliberately kept apart. **Choice** comes from the model and is
 * uncertain — it agrees with a real pro 69.6% of the time, so it reports a distribution and never a
 * verdict. **Execution** comes from the search and is not uncertain at all: nine moves against six
 * is a fact, model or no model.
 */
import {
  applyMoves,
  normalizeOrientation,
  serializeMoves,
  type CubeState,
  type Face,
  type Move,
} from "@cubing-companion/engine";
import { GEOMETRY, isSlotSolved, segmentFromState, slotName } from "@cubing-companion/analysis";
import { crossDistance, enumerateCross, enumerateF2LInsertion } from "@cubing-companion/solver";
import { colourName, slotColours } from "./colours.ts";
import { crossDecision, pairDecisions } from "./decisions.ts";
import { attribute, confidenceWording, reasons } from "./explain.ts";
import { lookaheadPairs, type Continuation } from "./lookahead.ts";
import { rotationBetween } from "./orientation.ts";
import { planColour } from "./plan.ts";
import { rankNextPair, rerankCross, type ScoreFn } from "./rank.ts";

export interface PairForecast {
  readonly depth: number;
  readonly immediateTurns: number;
  readonly totalTurns: number;
  readonly solvedPairs: number;
  readonly branch: string;
  readonly steps: readonly { readonly label: string; readonly moves: string }[];
}

export interface RankedPair {
  readonly slot: string;
  readonly label: string;
  readonly optimal: number;
  readonly moves: string;
  readonly confidence: number;
  readonly lookahead: PairForecast | null;
}

export interface DiffOption {
  readonly slot: string;
  readonly label: string;
  readonly optimal: number;
  readonly setup: string;
  readonly moves: string;
  readonly confidence: number;
  readonly mine: boolean;
}

export interface PairDiff {
  readonly step: number;
  readonly at: number;
  readonly yours: string;
  readonly theirs: string;
  readonly options: readonly DiffOption[];
  readonly wording: string;
  readonly reasons: readonly string[];
  readonly playedTurns: number;
  readonly optimalTurns: number;
  readonly played: string;
  readonly branch: string;
  readonly lookahead?: { readonly label: string; readonly forecast: PairForecast };
}

export interface CrossDiff {
  readonly at: number;
  readonly end: number;
  readonly playedTurns: number;
  readonly optimalTurns: number;
  readonly setup: string;
  readonly best: string;
  readonly hold: string;
  readonly branch: string;
  readonly lookahead?: { readonly label: string; readonly turns: number; readonly branch: string };
}

export interface SolveDiff {
  readonly cross: CrossDiff | null;
  readonly pairs: readonly PairDiff[];
  readonly learned: boolean;
  readonly failure?: string;
}

export interface NextPairs {
  readonly crossFace: Face | null;
  readonly ranked: readonly RankedPair[];
  readonly learned: boolean;
}

/** The two heads of the model; either may be missing, and the review degrades rather than fails. */
export interface Scorers {
  readonly cross: ScoreFn | null;
  readonly pair: ScoreFn | null;
}

/** Stops a long review early: checked between decisions, which are the expensive part. */
export type StillWanted = () => boolean;

const notation = (moves: readonly Move[]) => serializeMoves([...moves]);

/** The normalised frame's centre arrangement: colour i at face i. */
const HOME_CENTRES = [0, 1, 2, 3, 4, 5] as const;

/**
 * The rotations that put a cube into the normalised frame — the frame every search result is
 * expressed in. Prefixed onto any sequence shown or played against the raw state, so it is
 * literally executable from the position the cube is actually in. Empty for a smart cube, whose
 * centres never move; the fix exists for manual solves, where they do.
 */
export const normalisingSetup = (centres: ArrayLike<number>): Move[] =>
  rotationBetween(centres, HOME_CENTRES);

/** Describe the verified path without treating its search score as a probability. */
export function forecast(
  plan: Continuation,
  crossFace: Face,
  depth: number,
  setup: readonly Move[],
): PairForecast {
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

const yieldToOthers = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

/**
 * A5: walk a recorded solve and say, at each decision, what a top solver would likely have done.
 *
 * @param stillWanted checked between decisions; a review nobody is waiting for any more stops
 * there and returns null.
 */
export async function diffSolve(
  start: CubeState,
  solution: readonly Move[],
  scorers: Scorers,
  stillWanted?: StillWanted,
): Promise<SolveDiff | null> {
  const { segmentation } = segmentFromState(start, solution);
  const spans = segmentation?.spans;
  if (!segmentation || !spans) {
    return {
      cross: null,
      pairs: [],
      learned: false,
      failure: "this solve could not be segmented, so there are no decisions to compare",
    };
  }

  const crossFace = segmentation.crossFace;
  const score = scorers.pair;

  // The cross needs no model to be useful: your length against the optimum is a fact. The model
  // only picks which of the optimal crosses to show you.
  let cross: CrossDiff | null = null;
  const crossSearch = enumerateCross(normalizeOrientation(start), crossFace, { maxSolutions: 1 });
  const crossPart = crossDecision(start, solution, spans, crossFace, crossSearch.optimal);
  if (crossPart) {
    // Planned from the RAW position at the decision, not the normalised one `crossPart.state`
    // holds — the setup rotations are relative to where the cube actually was, and the branch is
    // applied to exactly that state. Planning from the normalised state was the bug: its centres
    // are always home, so the setup came out empty and the frame-renamed moves solved the wrong
    // pieces the moment the real frame differed.
    const rawAtCross = applyMoves(start, solution.slice(0, crossPart.at));
    const plan = planColour(rawAtCross, crossFace, { keep: 3, lookahead: true });
    const ranked = scorers.cross
      ? await rerankCross(plan.cross, scorers.cross, rawAtCross.centers)
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
      hold: best ? `${colourName(best.hold.down)} down, ${colourName(best.hold.front)} front` : "",
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
    if (stillWanted) {
      await yieldToOthers();
      if (!stillWanted()) return null;
    }
    const yours = decision.options[decision.chosen]!;
    const playedTurns = decision.playedMoves.filter((m) => !"xyz".includes(m.family)).length;
    // Search results are in the normalised frame; the branch replays against the raw state at this
    // move. The prefix bridges the two — empty for a smart cube, whose centres never move, and
    // exactly the missing rotations for a manual solve that rotated mid-way.
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
      // Recorded as it happened, so it is already executable from the position at this decision —
      // the same footing as the suggestions beside it, which are setup-prefixed.
      played: notation(decision.playedMoves),
      branch: executable(theirs.bestMoves),
      ...searchAdvice,
    });
  }

  return { cross, pairs, learned: score !== null };
}

/**
 * Rank the open slots by which pair a pro would fill next.
 *
 * The original optimal insertion results still supply the model's feature contract. A separate
 * bounded search explores alternative executions and follow-up pairs; its completed totals rank
 * first, with model preference breaking ties. Lookahead also runs when the model cannot load.
 */
export async function rankOpenPairs(
  raw: CubeState,
  crossFaces: readonly Face[],
  pairScore: ScoreFn | null,
  lookaheadDepth = 2,
): Promise<NextPairs> {
  const state = normalizeOrientation(raw);
  // The rotations from the cube's actual orientation into the search frame, so every sequence shown
  // is executable from the cube as it stands rather than as the search imagines it.
  const setup = normalisingSetup(raw.centers);
  // Which cross is already up? Ranking pairs only means something once one is, and asking the
  // position beats asking the user to tell us what they just built.
  const crossFace = crossFaces.find((face) => crossDistance(state, face) === 0);
  if (crossFace === undefined) return { crossFace: null, ranked: [], learned: false };

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
  const predicted = pairScore && usable.length > 0
    ? await rankNextPair(state, geometry, usable, { previous: null, step: 4 - open.length }, pairScore)
    : [];
  const deeper = lookaheadPairs(state, crossFace, { depth: lookaheadDepth });
  const ranked = usable.map((candidate) => {
    const plan = deeper.options.find((option) => option.slot === candidate.slot)?.plan;
    const lookahead = plan ? forecast(plan, crossFace, deeper.depth, setup) : null;
    return {
      slot: slotName(candidate.slot),
      label: slotColours(candidate.slot),
      optimal: candidate.optimal,
      moves: plan?.steps[0]
        ? notation([...setup, ...plan.steps[0].moves])
        : notation([...setup, ...candidate.bestMoves]),
      confidence: predicted.find((entry) => entry.slot === candidate.slot)?.confidence ?? 0,
      lookahead,
    };
  });
  ranked.sort((a, b) =>
    (a.lookahead?.totalTurns ?? Infinity) - (b.lookahead?.totalTurns ?? Infinity) ||
    b.confidence - a.confidence || a.optimal - b.optimal);
  return { crossFace, ranked, learned: pairScore !== null };
}
