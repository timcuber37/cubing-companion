/**
 * @cubing-companion/planner — turning search results into advice.
 *
 * `solver` says what solves a position; this says which of those you should do, and how to hold
 * the cube while you do it. The second half is the one that matters: the corpus says pros spend
 * their rotations in inspection choosing a frame, then execute almost without rotating.
 */

export {
  gripObservations,
  inferGrip,
  phaseGroup,
  PHASE_FACE_SHARE,
  type GripObservation,
  type PhaseGroup,
} from "./grip.ts";

export {
  COLOURS,
  colourName,
  colourOf,
  slotColours,
  slotSwatches,
  type Colour,
} from "./colours.ts";

export { awkwardTurns, comfortScore, FACE_SHARE } from "./comfort.ts";

export {
  frameFor,
  framesPuttingColourDown,
  ORIENTATIONS,
  orientationsWithColourDown,
  renameMoves,
  renameSlot,
  rotationBetween,
  rotationPuttingColourDown,
  type Orientation,
} from "./orientation.ts";

export {
  CROSS_FEATURES,
  crossFeatures,
  PAIR_FEATURES,
  pairFeatures,
  slotsAdjacent,
  type CrossFeature,
  type PairCandidateInput,
  type PairContext,
  type PairFeature,
} from "./features.ts";

export {
  crossDecision,
  pairDecisions,
  WAYS_CAP,
  type CrossDecision,
  type PairDecision,
  type PairOption,
} from "./decisions.ts";

export {
  attribute,
  confidenceWording,
  phrase,
  reasons,
  type Attribution,
  type Named,
} from "./explain.ts";

export {
  rankByMoveCount,
  rankNextPair,
  rerankCross,
  type RankedSlot,
  type ScoreFn,
} from "./rank.ts";

export {
  scorerFrom,
  scoreRow,
  scoreRows,
  validateWeights,
  type MlpLayer,
  type MlpWeights,
} from "./mlp.ts";

export { WEIGHTS, type RankerName } from "./weights.generated.ts";

export { scorerFor } from "./scorer.ts";

export {
  planColour,
  planColours,
  type ColourPlan,
  type Hold,
  type PlanKind,
  type PlanOptions,
  type PlannedSolution,
} from "./plan.ts";

export {
  continueF2L,
  lookaheadPairs,
  type Continuation,
  type ContinuationResult,
  type LookaheadOptions,
  type PairLookahead,
  type PairLookaheadResult,
  type PairStep,
} from "./lookahead.ts";

export {
  diffSolve,
  forecast,
  normalisingSetup,
  rankOpenPairs,
  type CrossDiff,
  type DiffOption,
  type NextPairs,
  type PairDiff,
  type PairForecast,
  type RankedPair,
  type Scorers,
  type SolveDiff,
  type StillWanted,
} from "./review.ts";
